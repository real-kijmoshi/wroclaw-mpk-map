'use strict';

const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');

const config = require('./config');
const { LruCache } = require('./cache');
const { VehicleDetailCache } = require('./vehicle-detail-cache');
const { simplify } = require('./gtfs/geo');
const { CATEGORIES } = require('./lines');
const { describeVehicle } = require('./progress');
const { enrichDepartures } = require('./realtime-departures');

const shapeCache = new LruCache(config.cache.shapeEntries);
// One entry is one (generation, revision, vehicle, limit, history) detail
// payload. The generation and poll-revision components invalidate it on a
// timetable refresh or a new vehicle poll; a short TTL bounds the
// time-sensitive output (delay, ETAs) for a vehicle that sits still. Read-time
// position matching keeps a vehicle that has moved from being served stale
// geometry.
const vehicleDetailCache = new VehicleDetailCache({
  maxEntries: config.cache.vehicleDetailEntries,
  ttlMs: config.cache.vehicleDetailTtlMs,
});
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

/**
 * GTFS-derived shape endpoints: allow caching but force revalidation, so a
 * proxy or browser can never serve a generation-old geometry without checking
 * the server. Uses a strong ETag (sha1 of the body) checked manually —
 * Express 5's built-in weak-ETag req.fresh comparison does not return 304
 * for If-None-Match on this platform.
 */
const revalidateShape = (req, res, next) => {
  res.set('Cache-Control', 'public, no-cache');
  next();
};

/**
 * Serialize JSON, set a strong ETag, and answer 304 on If-None-Match match.
 * Used by shape endpoints (which carry Cache-Control: no-cache) and any
 * future route that needs a strong, revalidating ETag instead of relying on
 * Express's built-in (weak) comparison.
 */
const conditionalJson = (req, res, payload) => {
  const body = JSON.stringify(payload);
  const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.set('ETag', etag);
  res.set('Content-Type', 'application/json; charset=utf-8');
  return res.send(body);
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
    // Kłosok vehicles carry the destination as `destination` rather than a trip;
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
  // Kłosok vehicles carry extra realtime fields; the map uses them for the
  // badge (operator), the click view (route/trip) and the delay label.
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
 * @param {{ gtfs: import('./gtfs/store').GtfsStore, vehicles: any, alerts: any, stats?: any, klosok?: any, startedAt: Date }} services
 */
const createRouter = ({ gtfs, vehicles, alerts, stats, klosok = null, startedAt }) => {
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
   * inputs changed not at all since the last poll.
   *
   * The merged fleet is cached in TWO independent caches — one for the map
   * format, one for the full format — each keyed on a format-aware combined
   * revision that only advances when /locations-visible state for that format
   * changes. This split is what fixes the stale-merged-object bug: a quiet poll
   * (fullRevision-only change) advances the full key but not the map key, so
   * only the full cache is rebuilt — the map merged array is reused untouched,
   * and the map body cache still answers 304. The full cache IS rebuilt, so the
   * full body is re-serialised from fresh provider snapshots (per-vehicle
   * updatedAt included) instead of stale objects.
   *
   * Serialized bodies are additionally keyed on the query that shapes them,
   * and validated against the matching format cache's key before being served.
   *
   * Freshness is checked on every request, before any body-cache lookup —
   * a cached serialized body must never be served past the moment the fleet it
   * represents has changed. Kłosok's nextExpiryAt is folded into validUntil,
   * so a bus that ages out between polls still vanishes from the response.
   */
  const mapMergedCache = { key: null, merged: null, validUntil: null };
  const fullMergedCache = { key: null, merged: null, validUntil: null };
  /** `line|type|format` -> { etag, body, mapKey, fullKey } */
  const locationsBodyCache = new Map();

  /** Combined key for the map format — advances only when map-visible state changes. */
  const combinedMapKey = () =>
    `${vehicles.mapRevision ?? 0}|${klosok?.mapRevision ?? 0}`;

  /** Combined key for the full format — advances when full-visible state changes (incl. lastUpdated). */
  const combinedFullKey = () =>
    `${vehicles.fullRevision ?? 0}|${klosok?.fullRevision ?? 0}`;

  /**
   * Merge the Wrocław and PT KŁOSOK (when enabled) location lists, returning the
   * array for the requested format from a format-specific cache.
   *
   * `format` selects the cache and the revision key to compare against. A
   * quiet poll advances fullKey only: the full cache is rebuilt from current
   * provider snapshots (so per-vehicle updatedAt is fresh in the full body),
   * while the map cache keeps its old array and the map body still answers 304.
   *
   * The fleet is rebuilt when the format's key changes or a Kłosok vehicle has
   * aged out (validUntil). A rebuild invalidates only serialized bodies built
   * for that same format, so the other format's body cache (and ETag) survive.
   */
  const getMergedLocations = (format) => {
    const isMap = format === 'map';
    const cache = isMap ? mapMergedCache : fullMergedCache;
    const key = isMap ? combinedMapKey() : combinedFullKey();
    const now = Date.now();

    // A Kłosok vehicle can age out by wall-clock, not by poll revision. If the
    // earliest remaining fix is past its maxAge, rebuild so it vanishes from
    // /locations even though no poll has run.
    const expired = cache.validUntil != null && now >= cache.validUntil;

    if (cache.merged === null || cache.key !== key || expired) {
      const wroclaw = vehicles.snapshot.locations;
      const merged = klosok?.enabled ? klosok.mergeLocations(wroclaw) : wroclaw;
      cache.merged = merged;
      cache.key = key;
      cache.validUntil = klosok?.nextExpiryAt ?? null;
      // Invalidate only bodies built from this format's merged fleet.
      for (const [variantKey] of [...locationsBodyCache]) {
        const entryIsMap = variantKey.split('|').pop() === 'map';
        if (entryIsMap === isMap) locationsBodyCache.delete(variantKey);
      }
    }

    return cache.merged;
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
        { method: 'GET', path: '/shapes/:line', description: 'Route shape; ?lat=&lon=&heading= picks the variant being run, ?format=compact for the smaller payload' },
        { method: 'GET', path: '/shapes/:line/variants', description: 'Every variant of a route' },
        { method: 'GET', path: '/stops', description: 'Search stops with ?q=' },
        { method: 'GET', path: '/stops/near', description: 'Stops near ?lat=&lon=; ?radius= (m) and ?limit=' },
        { method: 'GET', path: '/stops/:line', description: 'Stops served by a line' },
        { method: 'GET', path: '/stop/:id', description: 'Stop details' },
        { method: 'GET', path: '/stop/:id/departures', description: 'Next departures; ?limit= and ?within= (minutes)' },
        { method: 'GET', path: '/alerts', description: 'Service alerts; ?since= (ms epoch) and ?line=' },
        { method: 'GET', path: '/incidents', description: 'Grouped incident timelines; ?since=, ?line= and ?status=' },
        { method: 'GET', path: '/health', description: 'Health and upstream source report' },
        { method: 'GET', path: '/map', description: 'Browser map' },
        { method: 'GET', path: '/status', description: 'Status dashboard' },
      ],
    });
  });

  router.get('/lines', requireGtfs, cacheFor(300), (req, res) => {
    res.json({ ...gtfs.lines });
  });

  router.get('/lines/:category', requireGtfs, cacheFor(300), (req, res) => {
    const { category } = req.params;
    const lines = { ...gtfs.lines };
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

    // Check freshness before any body-cache lookup. If the merged fleet
    // changed, getMergedLocations() clears the body cache for this format —
    // so a stale serialized body is never served.
    const merged = getMergedLocations(format);

    let entry = locationsBodyCache.get(variantKey);

    // Validate the cached body against the key for THIS format only. A quiet
    // poll advances fullKey but not mapKey: the map body stays valid (304),
    // while the full body is discarded and re-serialised (200).
    if (entry) {
      const currentKey = format === 'map' ? mapMergedCache.key : fullMergedCache.key;
      const entryKey = format === 'map' ? entry.mapKey : entry.fullKey;
      if (entryKey !== currentKey) entry = undefined;
    }

    if (!entry) {
      const snapshot = vehicles.snapshot;
      const wanted = line ? new Set(String(line).split(',').map((item) => item.trim())) : null;
      const locations = merged.filter(
        (vehicle) => (!wanted || wanted.has(vehicle.line)) && (!type || vehicle.type === type),
      );

      const payload =
        format === 'map'
          ? toMapSnapshot(snapshot, locations)
          : // No filter means both providers in full, in the snapshot's own
            // shape — the merge must not be skipped by an unfiltered shortcut.
            { ...snapshot, locations, count: locations.length };
      const body = JSON.stringify(payload);
      entry = {
        etag: `"${crypto.createHash('sha1').update(body).digest('hex')}"`,
        body,
        mapKey: mapMergedCache.key,
        fullKey: fullMergedCache.key,
      };
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
   * One vehicle, with the whole stop list of the run it is on.
   *
   * /locations carries only the next stop for every vehicle — the full board
   * for a few hundred of them would be several times the payload for something
   * a rider looks at one vehicle at a time.
   */
  router.get('/vehicle/:id', requireGtfs, noStore, (req, res) => {
    const vehicle = req.params.id.startsWith('klosok:')
      ? klosok?.getVehicle(req.params.id)
      : vehicles.getVehicle(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not tracked', id: req.params.id });
    }

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 40, 200);
    const history = Math.min(Number.parseInt(req.query.history, 10) || 2, 20);

    // Open-data vehicles go through the detail cache; the Kłosok feed is a
    // separate tracker without the position fingerprint the cache needs.
    if (!req.params.id.startsWith('klosok:')) {
      const revision = vehicles.pollRevision ?? 0;
      const cached = vehicleDetailCache.get(
        gtfs.generation,
        revision,
        req.params.id,
        limit,
        history,
        vehicle,
      );
      // A detail computed for one lat/lon/heading stays true only while the
      // vehicle is still there, the timetable generation is unchanged, and the
      // polling revision is the same. updatedAt is a freshness timestamp, so it
      // is deliberately not part of the key or the test.
      if (cached) return res.json({ vehicle, trip: cached });

      // Seed the projection fast path with the tracker's last position; the
      // detail request then re-projects around the vehicle instead of scanning
      // every shape variant for it.
      const previousState = vehicles.describeCache.get(vehicle.id)?.state ?? null;
      const trip = describeVehicle(gtfs, vehicle, { limit, history, previousState });
      vehicleDetailCache.set(
        gtfs.generation,
        revision,
        req.params.id,
        limit,
        history,
        vehicle,
        trip,
      );
      return res.json({ vehicle, trip });
    }

    return res.json({
      vehicle,
      trip: describeVehicle(gtfs, vehicle, { limit, history }),
    });
  });

  router.get('/shapes/:line/variants', requireGtfs, revalidateShape, (req, res) => {
    const { line } = req.params;
    const variants = gtfs.getVariants(line);
    if (!variants.length) return res.status(404).json({ error: 'Line not found', line });

    return conditionalJson(req, res, {
      line,
      route: gtfs.routesByLine.get(line) ?? null,
      variants: variants.map(toCompact),
    });
  });

  router.get('/shapes/:line', requireGtfs, revalidateShape, (req, res) => {
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
    const cacheKey = `${gtfs.generation}|${line}|${positionKey}|${headingKey}|${compact ? 'compact' : 'legacy'}`;

    const cached = shapeCache.get(cacheKey);
    if (cached) return conditionalJson(req, res, cached);

    const variant = gtfs.getBestVariant(line, lat, lon, { heading });
    if (!variant) return res.status(404).json({ error: 'No shape available for this line', line });

    const payload = compact ? toCompact(variant) : toLegacy(variant);
    shapeCache.set(cacheKey, payload);
    return conditionalJson(req, res, payload);
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

  router.get('/stops', requireGtfs, cacheFor(300), (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (!query) return res.status(400).json({ error: 'Provide a search term with ?q=' });
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    return res.json({ query, stops: [...gtfs.searchStops(query, limit)].slice(0, limit) });
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
    const withinMinutes = Math.min(Number.parseInt(req.query.within, 10) || 1440, 1440);
    const departures = gtfs.getDeparturesForStop(stop.id, { limit, horizonSeconds: withinMinutes * 60 });
    return res.json({
      stop: { ...stop, lines: gtfs.getLinesForStop(stop.id) },
      departures: enrichDepartures(departures, stop.id, vehicles),
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

  router.get('/incidents', cacheFor(60), (req, res) => {
    const since = Number.parseInt(req.query.since ?? req.query.from, 10) || 0;
    const line = req.query.line ?? null;
    const status = req.query.status ?? null;
    if (status && !['active', 'resolved', 'unknown'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid incident status',
        availableStatuses: ['active', 'resolved', 'unknown'],
      });
    }
    const ai = alerts.incidentStatus ?? {
      enabled: false,
      provider: null,
      model: null,
      lastSuccessAt: null,
      lastError: 'Incident generation is unavailable',
    };
    return res.json({
      incidents: alerts.getIncidents({ since, line, status }),
      lastRefreshAt: alerts.status.lastRefreshAt,
      ai: {
        enabled: ai.enabled,
        provider: ai.provider,
        model: ai.model,
        lastSuccessAt: ai.lastSuccessAt,
        lastError: ai.lastError,
      },
    });
  });

  router.get('/health', noStore, (req, res) => {
    const healthy = gtfs.isReady;
    // Keep the payload compact: the rolling metrics are latest / EWMA / max
    // with no history, and the GTFS block is only the last successful build.
    const performanceBlock = {
      vehicles: vehicles.performanceSnapshot ? vehicles.performanceSnapshot() : {},
      openData: vehicles.openDataPerformanceSnapshot
        ? vehicles.openDataPerformanceSnapshot()
        : {},
      gtfs: gtfs.performance ?? null,
    };
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
      performance: performanceBlock,
      klosok: klosok ? klosok.status : { enabled: false },
      alerts: alerts.status,
      lines: {
        total: Object.values(gtfs.lines).flat().length,
        trams: gtfs.lines.allTrams.length,
        buses: gtfs.lines.allBuses.length,
      },
      shapeCacheEntries: shapeCache.size,
      vehicleDetailCacheEntries: vehicleDetailCache.size,
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
  vehicleDetailCache,
  toCompact,
  toLegacy,
  toMapSnapshot,
};
