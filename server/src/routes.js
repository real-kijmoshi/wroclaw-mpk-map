'use strict';

const express = require('express');
const path = require('node:path');

const config = require('./config');
const { LruCache } = require('./cache');
const { CATEGORIES } = require('./lines');

const shapeCache = new LruCache(config.cache.shapeEntries);

/** Cache-Control helper: timetable data is stable, vehicle data is not. */
const cacheFor = (seconds) => (req, res, next) => {
  res.set('Cache-Control', `public, max-age=${seconds}`);
  next();
};

const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Compact wire format used by the current app: half the bytes of the legacy one. */
const toCompact = (variant) => {
  const points = new Array(variant.points.length / 2);
  for (let i = 0; i < points.length; i += 1) {
    points[i] = [
      Number(variant.points[i * 2].toFixed(5)),
      Number(variant.points[i * 2 + 1].toFixed(5)),
    ];
  }
  return {
    line: variant.line,
    shapeId: variant.shapeId,
    direction: variant.direction,
    headsign: variant.headsign,
    directionId: variant.directionId,
    tripCount: variant.tripCount,
    bounds: variant.bounds,
    points,
    stops: variant.stops.map((stop) => ({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      arrival: stop.arrival,
      departure: stop.departure,
    })),
  };
};

/**
 * The shape released app builds expect. Kept so an older installed app keeps
 * working after the server is upgraded.
 */
const toLegacy = (variant) => {
  const shapePoints = new Array(variant.points.length / 2);
  for (let i = 0; i < shapePoints.length; i += 1) {
    shapePoints[i] = {
      shape_pt_lat: variant.points[i * 2],
      shape_pt_lon: variant.points[i * 2 + 1],
      shape_pt_sequence: i,
    };
  }
  return {
    shape_id: variant.shapeId,
    direction: variant.direction,
    shapePoints,
    stops: variant.stops.map((stop) => ({
      stop: {
        stop_id: stop.id,
        stop_name: stop.name,
        stop_lat: stop.lat,
        stop_lon: stop.lon,
      },
      arrival_time: stop.arrival,
      departure_time: stop.departure,
      stop_sequence: stop.sequence,
    })),
  };
};

const parseCoordinate = (value) => {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * @param {{ gtfs: import('./gtfs/store').GtfsStore, vehicles: any, alerts: any, startedAt: Date }} services
 */
const createRouter = ({ gtfs, vehicles, alerts, startedAt }) => {
  const router = express.Router();

  /** 503 until the timetable is loaded, so clients can retry instead of caching an empty answer. */
  const requireGtfs = (req, res, next) => {
    if (gtfs.isReady) return next();
    res.set('Retry-After', '15');
    return res.status(503).json({
      error: 'Timetable data is still loading',
      state: gtfs.status.state,
      detail: gtfs.status.error,
    });
  };

  router.get('/', (req, res) => {
    res.json({
      name: 'Wrocław MPK Map API',
      version: require('../package.json').version,
      status: gtfs.status.state,
      endpoints: [
        { method: 'GET', path: '/lines', description: 'All lines grouped by category' },
        { method: 'GET', path: '/lines/:category', description: `One category (${CATEGORIES.join(', ')})` },
        { method: 'GET', path: '/locations', description: 'Live vehicle positions' },
        { method: 'GET', path: '/shapes/:line', description: 'Route shape; ?lat=&lon= picks the closest variant, ?format=compact for the smaller payload' },
        { method: 'GET', path: '/shapes/:line/variants', description: 'Every variant of a route' },
        { method: 'GET', path: '/stops', description: 'Search stops with ?q=' },
        { method: 'GET', path: '/stops/:line', description: 'Stops served by a line' },
        { method: 'GET', path: '/stop/:id', description: 'Stop details' },
        { method: 'GET', path: '/stop/:id/departures', description: 'Next departures; ?limit= and ?within= (minutes)' },
        { method: 'GET', path: '/alerts', description: 'Service alerts; ?since= (ms epoch) and ?line=' },
        { method: 'GET', path: '/health', description: 'Health and upstream source report' },
        { method: 'GET', path: '/map', description: 'Browser map' },
        { method: 'GET', path: '/status', description: 'Status dashboard' },
      ],
    });
  });

  router.get('/lines', requireGtfs, cacheFor(300), (req, res) => {
    res.json(gtfs.lines);
  });

  router.get('/lines/:category', requireGtfs, cacheFor(300), (req, res) => {
    const { category } = req.params;
    if (!Object.hasOwn(gtfs.lines, category)) {
      return res.status(404).json({
        error: 'Category not found',
        availableCategories: Object.keys(gtfs.lines),
      });
    }
    return res.json({ category, lines: gtfs.lines[category] });
  });

  router.get('/locations', noStore, (req, res) => {
    const { line, type } = req.query;
    const snapshot = vehicles.snapshot;
    if (!line && !type) return res.json(snapshot);

    const wanted = line ? new Set(String(line).split(',').map((item) => item.trim())) : null;
    const locations = snapshot.locations.filter(
      (vehicle) => (!wanted || wanted.has(vehicle.line)) && (!type || vehicle.type === type),
    );
    return res.json({ ...snapshot, locations, count: locations.length });
  });

  router.get('/shapes/:line/variants', requireGtfs, cacheFor(3600), (req, res) => {
    const { line } = req.params;
    const variants = gtfs.getVariants(line);
    if (!variants.length) return res.status(404).json({ error: 'Line not found', line });

    return res.json({
      line,
      route: gtfs.routesByLine.get(line) ?? null,
      variants: variants.map(toCompact),
    });
  });

  router.get('/shapes/:line', requireGtfs, cacheFor(3600), (req, res) => {
    const { line } = req.params;
    const lat = parseCoordinate(req.query.lat);
    const lon = parseCoordinate(req.query.lon);
    const compact = req.query.format === 'compact';

    if (!gtfs.hasLine(line)) return res.status(404).json({ error: 'Line not found', line });

    // Rounding the position keeps the cache useful: vehicles a few metres apart
    // resolve to the same variant anyway.
    const positionKey = lat !== null && lon !== null ? `${lat.toFixed(3)},${lon.toFixed(3)}` : 'default';
    const cacheKey = `${line}|${positionKey}|${compact ? 'compact' : 'legacy'}`;

    const cached = shapeCache.get(cacheKey);
    if (cached) return res.json(cached);

    const variant = gtfs.getBestVariant(line, lat, lon);
    if (!variant) return res.status(404).json({ error: 'No shape available for this line', line });

    const payload = compact ? toCompact(variant) : toLegacy(variant);
    shapeCache.set(cacheKey, payload);
    return res.json(payload);
  });

  router.get('/stops', requireGtfs, cacheFor(300), (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) return res.status(400).json({ error: 'Provide a search term with ?q=' });
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    return res.json({ query, stops: gtfs.searchStops(query, limit) });
  });

  router.get('/stops/:line', requireGtfs, cacheFor(3600), (req, res) => {
    const { line } = req.params;
    const variants = gtfs.getVariants(line);
    if (!variants.length) return res.status(404).json({ error: 'Line not found', line });

    // Union of stops across every variant, so a stop served by only one
    // direction is not silently missing.
    const byId = new Map();
    for (const variant of variants) {
      for (const stop of variant.stops) {
        if (!byId.has(stop.id)) {
          byId.set(stop.id, { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon });
        }
      }
    }

    return res.json({ line, stops: [...byId.values()] });
  });

  router.get('/stop/:id/departures', requireGtfs, noStore, (req, res) => {
    const stop = gtfs.getStop(req.params.id);
    if (!stop) return res.status(404).json({ error: 'Stop not found', id: req.params.id });

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const withinMinutes = Math.min(Number.parseInt(req.query.within, 10) || 120, 1440);
    return res.json({
      stop,
      departures: gtfs.getDepartures(stop.id, { limit, horizonSeconds: withinMinutes * 60 }),
    });
  });

  router.get('/stop/:id', requireGtfs, cacheFor(3600), (req, res) => {
    const stop = gtfs.getStop(req.params.id);
    if (!stop) return res.status(404).json({ error: 'Stop not found', id: req.params.id });
    return res.json(stop);
  });

  router.get('/alerts', cacheFor(60), (req, res) => {
    const since = Number.parseInt(req.query.since ?? req.query.from, 10) || 0;
    const line = req.query.line ?? null;
    res.json({
      alerts: alerts.getAlerts({ since, line }),
      lastRefreshAt: alerts.status.lastRefreshAt,
    });
  });

  router.get('/health', noStore, (req, res) => {
    const healthy = gtfs.isReady;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'starting',
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      gtfs: gtfs.status,
      vehicles: { ...vehicles.status, tracked: vehicles.snapshot.count },
      alerts: alerts.status,
      lines: {
        total: Object.values(gtfs.lines).flat().length,
        trams: gtfs.lines.allTrams.length,
        buses: gtfs.lines.allBuses.length,
      },
      shapeCacheEntries: shapeCache.size,
    });
  });

  router.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'status.html'));
  });

  router.get('/map', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'map.html'));
  });

  return router;
};

module.exports = { createRouter, shapeCache, toCompact, toLegacy };
