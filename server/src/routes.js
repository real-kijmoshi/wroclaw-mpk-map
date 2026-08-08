'use strict';

const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');

const config = require('./config');
const { LruCache } = require('./cache');
const { simplify } = require('./gtfs/geo');
const { CATEGORIES } = require('./lines');
const { describeVehicle } = require('./progress');

const shapeCache = new LruCache(config.cache.shapeEntries);
const WIRE_SHAPE_SIMPLIFY_METERS = 8;

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
  // Matching keeps the store's finer geometry; drawing gets a slightly
  // stronger simplification because an 8 m deviation is hidden by the route
  // stroke at the zoom levels where a whole run is visible.
  const wirePoints = simplify(variant.points, WIRE_SHAPE_SIMPLIFY_METERS);
  const points = new Array(wirePoints.length / 2);
  for (let i = 0; i < points.length; i += 1) {
    points[i] = [
      Number(wirePoints[i * 2].toFixed(5)),
      Number(wirePoints[i * 2 + 1].toFixed(5)),
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

/** The map does not need stop progress or timestamps for every vehicle. */
const toMapVehicle = (vehicle) => {
  const entry = {
    id: vehicle.id,
    line: vehicle.line,
    type: vehicle.type,
    lat: vehicle.lat,
    lon: vehicle.lon,
    heading: vehicle.heading,
    // KD vehicles carry the destination as `destination` rather than a trip;
    // fold it in so the tooltip still reads "Linia X → Y" on both clients.
    trip: vehicle.trip
      ? {
          headsign: vehicle.trip.headsign ?? null,
          towards: vehicle.trip.towards ?? null,
        }
      : vehicle.destination != null
        ? { headsign: vehicle.destination, towards: null }
        : null,
  };
  // The merge metadata is optional — only add it when a vehicle actually has
  // it, so the map payload shape is unchanged for plain MPK vehicles.
  if (vehicle.source !== undefined) entry.source = vehicle.source;
  if (vehicle.vehicleNumber !== undefined) entry.vehicleNumber = vehicle.vehicleNumber;
  if (vehicle.brigade !== undefined) entry.brigade = vehicle.brigade;
  if (vehicle.positionUpdatedAt !== undefined) entry.positionUpdatedAt = vehicle.positionUpdatedAt;
  // KD trains carry extra realtime fields; the map uses them for the badge
  // (operator), the click view (route/trip) and the delay label.
  if (vehicle.operator !== undefined) entry.operator = vehicle.operator;
  if (vehicle.routeId !== undefined) entry.routeId = vehicle.routeId;
  if (vehicle.tripId !== undefined) entry.tripId = vehicle.tripId;
  if (vehicle.vehicleLabel !== undefined) entry.vehicleLabel = vehicle.vehicleLabel;
  if (vehicle.delaySeconds !== undefined) entry.delaySeconds = vehicle.delaySeconds;
  if (vehicle.occupancyStatus !== undefined) entry.occupancyStatus = vehicle.occupancyStatus;
  if (vehicle.occupancyPercentage !== undefined) entry.occupancyPercentage = vehicle.occupancyPercentage;
  return entry;
};

const toMapSnapshot = (snapshot, locations) => ({
  locations: locations.map(toMapVehicle),
  count: locations.length,
  lastUpdated: snapshot.lastUpdated,
  source: snapshot.source,
  stale: snapshot.stale,
});

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

/** A compass bearing from the query string, or null when it is absent or junk. */
const parseHeading = (value) => {
  const parsed = parseCoordinate(value);
  return parsed === null ? null : ((parsed % 360) + 360) % 360;
};

/**
 * @param {{ gtfs: import('./gtfs/store').GtfsStore, vehicles: any, alerts: any, stats?: any, kd?: any, klosok?: any, startedAt: Date }} services
 */
const createRouter = ({ gtfs, vehicles, alerts, stats, kd = null, klosok = null, startedAt }) => {
  const router = express.Router();

  // Count finished requests for the admin dashboard. Runs first, but reads
  // req.route on `finish`, by which point the route has matched.
  if (stats) {
    router.use((req, res, next) => {
      res.on('finish', () => stats.record(req));
      next();
    });
  }

  // Constant-time token check; a length mismatch short-circuits before
  // timingSafeEqual, which throws on different-length buffers.
  const tokenMatches = (given) => {
    if (!given || given.length !== config.admin.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.admin.token));
  };

  const requireAdmin = (req, res, next) => {
    const authorization = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match || !tokenMatches(match[1])) {
      res.set('Cache-Control', 'no-store');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };

  /**
   * /locations memoization. Every open app polls the endpoint every ten
   * seconds, and without this each request re-runs the Kłosok dedup, re-maps
   * the whole fleet into wire objects and re-stringifies a payload whose
   * inputs changed not at all since the last poll. The merged fleet is keyed
   * on the sources' revision counters; serialized bodies additionally key on
   * the query that shapes them.
   */
  let mergedCache = { key: null, merged: null };
  /** `line|type|format` -> { etag, body } */
  const locationsBodyCache = new Map();

  /**
   * Merge the Wrocław, PT KŁOSOK (when enabled) and Koleje Dolnośląskie
   * location lists. KD ids are kd:* namespaced so there is nothing to
   * deduplicate against the other two; Kłosok positions are deduplicated
   * against the Wrocław fleet first (a fresh Kłosok fix outranks MPK/Open
   * Data for the same physical bus), then KD is appended.
   */
  const allLocations = () => {
    const key = `${vehicles.revision}|${klosok?.revision ?? 0}|${kd?.snapshot.lastUpdated ?? ''}`;
    if (mergedCache.key !== key || mergedCache.merged === null) {
      const wroclaw = vehicles.snapshot.locations;
      const merged = klosok?.enabled ? klosok.mergeLocations(wroclaw) : wroclaw;
      mergedCache = {
        key,
        merged: kd?.snapshot.count ? [...merged, ...kd.snapshot.locations] : merged,
      };
      // A new fleet invalidates every serialized body derived from it.
      locationsBodyCache.clear();
    }
    return mergedCache.merged;
  };

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

  /**
   * 503 until *a* timetable is loaded. /lines serves both Wrocław and KD, and
   * either provider being ready is enough for the endpoint to be useful — a KD
   * line list must not wait on the Wrocław store.
   */
  const requireAnyTimetable = (req, res, next) => {
    if (gtfs.isReady || kd?.isReady) return next();
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
        { method: 'GET', path: '/locations', description: 'Live vehicle positions, with destination and next stop' },
        { method: 'GET', path: '/vehicle/:id', description: 'One vehicle with its remaining stops and estimated times' },
        { method: 'GET', path: '/kd/trip/:tripId/shape', description: 'KD trip geometry (when the feed links one to a shape)' },
        { method: 'GET', path: '/shapes/:line', description: 'Route shape; ?lat=&lon=&heading= picks the variant being run, ?format=compact for the smaller payload' },
        { method: 'GET', path: '/shapes/:line/variants', description: 'Every variant of a route' },
        { method: 'GET', path: '/stops', description: 'Search stops with ?q=' },
        { method: 'GET', path: '/stops/near', description: 'Stops near ?lat=&lon=; ?radius= (m) and ?limit=' },
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

  router.get('/lines', requireAnyTimetable, cacheFor(300), (req, res) => {
    const lines = { ...gtfs.lines };
    // KD trains are a provider of their own: they go under a dedicated
    // category and the allTrains convenience group — never into allBuses,
    // and never through the MPK lineToType rules (D1/D6 must not be read
    // as express buses).
    if (kd?.isReady) {
      lines.train = kd.getLines();
      lines.allTrains = kd.getLines();
      if (!lines.train.length) delete lines.train;
      if (!lines.allTrains.length) delete lines.allTrains;
    }
    res.json(lines);
  });

  router.get('/lines/:category', requireAnyTimetable, cacheFor(300), (req, res) => {
    const { category } = req.params;
    const lines = { ...gtfs.lines };
    if (kd?.isReady) {
      if (category === 'train' || category === 'allTrains') lines[category] = kd.getLines();
    }
    if (!Object.hasOwn(lines, category)) {
      return res.status(404).json({
        error: 'Category not found',
        availableCategories: Object.keys(lines),
      });
    }
    return res.json({ category, lines: lines[category] });
  });

  router.get('/locations', noStore, (req, res) => {
    const { line, type, format } = req.query;
    const variantKey = `${line ?? ''}|${type ?? ''}|${format ?? ''}`;
    let entry = locationsBodyCache.get(variantKey);

    if (!entry) {
      const snapshot = vehicles.snapshot;
      const wanted = line ? new Set(String(line).split(',').map((item) => item.trim())) : null;
      const locations = allLocations().filter(
        (vehicle) => (!wanted || wanted.has(vehicle.line)) && (!type || vehicle.type === type),
      );

      const payload =
        format === 'map'
          ? toMapSnapshot(snapshot, locations)
          : // No filter means both providers in full, in the snapshot's own
            // shape — the merge must not be skipped by an unfiltered shortcut.
            { ...snapshot, locations, count: locations.length };
      const body = JSON.stringify(payload);
      entry = { etag: `"${crypto.createHash('sha1').update(body).digest('hex')}"`, body };
      locationsBodyCache.set(variantKey, entry);
    }

    // The ETag is derived from the serialized body, so an unchanged fleet
    // answers 304 and the client keeps its copy instead of re-downloading it.
    if (req.headers['if-none-match'] && req.headers['if-none-match'] === entry.etag) {
      return res.status(304).end();
    }

    res.set('ETag', entry.etag);
    res.set('Content-Type', 'application/json; charset=utf-8');
    return res.send(entry.body);
  });

  /**
   * KD vehicle detail. Registered before the MPK handler below and without its
   * `requireGtfs` gate: KD is a standalone provider, so a train can be asked
   * about while Wrocław's timetable is still loading.
   */
  router.get('/vehicle/:id', noStore, (req, res, next) => {
    if (!req.params.id.startsWith('kd:') || !kd) return next();
    const detail = kd.getTrip(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Vehicle not tracked', id: req.params.id });
    return res.json(detail);
  });

  /**
   * One vehicle, with the whole stop list of the run it is on.
   *
   * /locations carries only the next stop for every vehicle — the full board
   * for a few hundred of them would be several times the payload for something
   * a rider looks at one vehicle at a time.
   */
  router.get('/vehicle/:id', requireGtfs, noStore, (req, res) => {
    const vehicle = req.params.id.startsWith('klosok:')
      ? klosok?.getVehicle(req.params.id)
      : vehicles.snapshot.locations.find((entry) => entry.id === req.params.id);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not tracked', id: req.params.id });
    }

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 40, 200);
    const history = Math.min(Number.parseInt(req.query.history, 10) || 2, 20);

    return res.json({
      vehicle,
      trip: describeVehicle(gtfs, vehicle, { limit, history }),
    });
  });

  /**
   * Geometry of one KD trip, keyed by trip rather than line because a train
   * line runs many trips and the feed does not link every one to a shape.
   * The KD sample has no shapes.txt at all, so this answers "unavailable"
   * instead of drawing a straight line between stations.
   */
  router.get('/kd/trip/:tripId/shape', cacheFor(3600), (req, res) => {
    if (!kd) return res.status(404).json({ error: 'KD not enabled' });
    const rawTripId = req.params.tripId.startsWith('kd:trip:')
      ? req.params.tripId.slice('kd:trip:'.length)
      : req.params.tripId;
    const shape = kd.getTripShape(rawTripId);
    if (!shape) {
      return res.status(404).json({
        available: false,
        reason: 'GTFS feed does not link this trip to a shape',
      });
    }
    return res.json({ tripId: req.params.tripId, ...shape });
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
    const heading = parseHeading(req.query.heading);
    const compact = req.query.format === 'compact';

    if (!gtfs.hasLine(line)) return res.status(404).json({ error: 'Line not found', line });

    // Rounding the position keeps the cache useful: vehicles a few metres apart
    // resolve to the same variant anyway. The heading is bucketed to 45° for
    // the same reason — it is only ever used to rule out the opposite
    // direction, and a per-degree key would never hit.
    const positionKey = lat !== null && lon !== null ? `${lat.toFixed(3)},${lon.toFixed(3)}` : 'default';
    const headingKey = heading === null ? 'any' : String(Math.round(heading / 45) % 8);
    const cacheKey = `${line}|${positionKey}|${headingKey}|${compact ? 'compact' : 'legacy'}`;

    const cached = shapeCache.get(cacheKey);
    if (cached) return res.json(cached);

    const variant = gtfs.getBestVariant(line, lat, lon, { heading });
    if (!variant) return res.status(404).json({ error: 'No shape available for this line', line });

    const payload = compact ? toCompact(variant) : toLegacy(variant);
    shapeCache.set(cacheKey, payload);
    return res.json(payload);
  });

  router.get('/stops/near', requireGtfs, cacheFor(60), (req, res) => {
    const lat = parseCoordinate(req.query.lat);
    const lon = parseCoordinate(req.query.lon);
    if (lat === null || lon === null) {
      return res.status(400).json({ error: 'Provide ?lat= and ?lon=' });
    }

    const radius = Math.min(Number.parseInt(req.query.radius, 10) || 500, 5000);
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    return res.json({ stops: gtfs.findStopsNear(lat, lon, { radiusMeters: radius, limit }) });
  });

  router.get('/stops', requireAnyTimetable, cacheFor(300), (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) return res.status(400).json({ error: 'Provide a search term with ?q=' });
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const stops = [...gtfs.searchStops(query, limit)];
    // KD stops are searched in the same box as MPK stops. The two id spaces
    // are namespaced, so a union is safe.
    if (kd?.isReady) {
      for (const stop of kd.searchStops(query, limit)) {
        if (!stops.some((entry) => entry.id === stop.id)) stops.push(stop);
      }
    }
    return res.json({ query, stops: stops.slice(0, limit) });
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

  router.get('/stop/:id/departures', requireAnyTimetable, noStore, (req, res) => {
    // KD departures come from the KD service — the Wrocław store does not know
    // a kd: stop and would answer 404.
    if (req.params.id.startsWith('kd:')) {
      if (!kd) return res.status(404).json({ error: 'Stop not found', id: req.params.id });
      const stop = kd.getStop(req.params.id);
      if (!stop) return res.status(404).json({ error: 'Stop not found', id: req.params.id });
      const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
      const withinMinutes = Math.min(Number.parseInt(req.query.within, 10) || 120, 1440);
      return res.json({
        stop,
        departures: kd.getDepartures(req.params.id, { limit, horizonSeconds: withinMinutes * 60 }),
      });
    }

    const stop = gtfs.getStop(req.params.id);
    if (!stop) return res.status(404).json({ error: 'Stop not found', id: req.params.id });

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const withinMinutes = Math.min(Number.parseInt(req.query.within, 10) || 120, 1440);
    return res.json({
      stop,
      departures: gtfs.getDepartures(stop.id, { limit, horizonSeconds: withinMinutes * 60 }),
    });
  });

  router.get('/stop/:id', requireAnyTimetable, cacheFor(3600), (req, res) => {
    if (req.params.id.startsWith('kd:')) {
      if (!kd) return res.status(404).json({ error: 'Stop not found', id: req.params.id });
      const stop = kd.getStop(req.params.id);
      if (!stop) return res.status(404).json({ error: 'Stop not found', id: req.params.id });
      return res.json(stop);
    }
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
      vehicles: {
        ...vehicles.status,
        tracked: vehicles.snapshot.count,
        stats: vehicles.stats,
        openData: vehicles.openDataStatus,
      },
      // KD and Kłosok are standalone providers: they are reported on, but
      // their health does not decide the overall status — Wrocław must stay
      // up when either is down.
      kd: kd ? kd.status : { enabled: false },
      klosok: klosok ? klosok.status : { enabled: false },
      alerts: alerts.status,
      lines: {
        total: Object.values(gtfs.lines).flat().length,
        trams: gtfs.lines.allTrams.length,
        buses: gtfs.lines.allBuses.length,
        trains: kd?.isReady ? kd.getLines().length : 0,
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

  // Admin dashboard. Registered only when a token exists — an unauthenticated
  // /admin would be a gaping hole, and one that cannot log in is useless.
  if (config.admin.token) {
    router.get('/admin', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
    });

    router.get('/admin/api/stats', requireAdmin, noStore, (req, res) => {
      res.json(stats ? stats.snapshot() : { enabled: false });
    });
  }

  return router;
};

module.exports = {
  WIRE_SHAPE_SIMPLIFY_METERS,
  createRouter,
  shapeCache,
  toCompact,
  toLegacy,
  toMapSnapshot,
};
