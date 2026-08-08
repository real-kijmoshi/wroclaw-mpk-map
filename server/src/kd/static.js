'use strict';

const AdmZip = require('adm-zip');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const logger = require('../logger');
const { findEntry } = require('../gtfs/archive');
const { parseTable, secondsToTime, streamTable, timeToSeconds } = require('../gtfs/parse');
const { matchRank, normalizeSearchText } = require('../search');

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const OPERATOR = 'KD';

/** External IDs keep KD and MPK from ever colliding on the wire. */
const external = {
  stop: (raw) => `kd:stop:${raw}`,
  trip: (raw) => `kd:trip:${raw}`,
  route: (raw) => `kd:route:${raw}`,
};

/**
 * Static GTFS timetable for Koleje Dolnośląskie, loaded from a single download
 * URL behind HTTP Basic Auth (the sample at kd.kiedyprzyjedzie.pl).
 *
 * The current sample deliberately lacks `shapes.txt` and `trips.shape_id`, so
 * this store never assumes route geometry exists: a trip is a ordered list of
 * stops, and `/kd/trip/:id/shape` answers "unavailable" rather than inventing a
 * line between stations.
 *
 * Every public record is namespaced `kd:*`; the raw GTFS ids are kept inside.
 */
class KdStaticStore {
  constructor() {
    this.reset();
    this.status = {
      state: 'empty',
      source: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      fromCache: false,
      counts: {},
    };
  }

  reset() {
    /** @type {Map<string, object>} route_id -> route */
    this.routesById = new Map();
    /** @type {Map<string, object>} trip_id -> trip */
    this.tripsById = new Map();
    /** @type {Map<string, object>} stop_id -> stop */
    this.stopsById = new Map();
    /**
     * Search index over the stops, names folded once at load time.
     * @type {Array<{ stop: object, normalized: string }>}
     */
    this.stopSearchIndex = [];
    /** @type {Map<string, object[]>} trip_id -> ordered stop times */
    this.stopTimesByTripId = new Map();
    /** @type {Map<string, number[]>} stop_id -> departures (seconds after midnight) */
    this.departuresByStop = new Map();
    /** @type {Map<string, string[]>} station stop_id -> platform stop ids */
    this.platformsByStation = new Map();
    /** @type {Map<string, object>} service_id -> calendar */
    this.services = new Map();
    /** @type {Map<string, Float64Array>} shape_id -> interleaved [lat, lon, ...] */
    this.shapesById = new Map();
    /**
     * @type {Map<string, string[]>} the numeric train-number-ish prefix
     * before the first "_" in a GTFS trip_id (e.g. "49568439" out of
     * "49568439_446530") -> every full trip_id sharing it. Lets
     * publicRealtime.js join kiedyPrzyjedzie.pl's bare numeric `trip_id`
     * (from /api/departures) back to this feed's own trip records.
     */
    this.tripsByNumericId = new Map();
  }

  get isReady() {
    return this.status.state === 'ready';
  }

  /**
   * Download the current timetable and rebuild every index.
   * A failed refresh keeps serving the last good data.
   */
  async refresh() {
    const previousState = this.status.state;
    this.status.state = previousState === 'ready' ? 'refreshing' : 'loading';
    this.status.lastAttemptAt = new Date().toISOString();

    try {
      const { buffer, fromCache, source } = await this.#download();
      const startedAt = Date.now();
      await this.build(buffer);

      this.status = {
        ...this.status,
        state: 'ready',
        source,
        lastSuccessAt: new Date().toISOString(),
        fromCache,
        lastError: null,
      };
      logger.info(
        `KD GTFS ready in ${Date.now() - startedAt} ms — ${this.status.counts.routes} routes, ` +
          `${this.status.counts.trips} trips, ${this.status.counts.stops} stops` +
          (fromCache ? ' (from cache)' : ''),
      );
      return this.status;
    } catch (error) {
      this.status.state = previousState === 'ready' ? 'ready' : 'failed';
      this.status.lastError = error.message;
      logger.error(`KD GTFS refresh failed: ${error.message}`);
      throw error;
    }
  }

  async #download() {
    const { gtfsUrl, username, password, timeoutMs, useCache } = config.kd;

    if (username && password) {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const { fetchWithTimeout } = require('../http');
      try {
        const response = await fetchWithTimeout(gtfsUrl, {
          timeoutMs,
          redirect: 'follow',
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/zip' },
        });

        if (response.status === 401) {
          const message = 'KD GTFS authentication failed (401)';
          this.status.lastError = message;
          logger.error(message);
        } else if (!response.ok) {
          this.status.lastError = `KD GTFS responded HTTP ${response.status}`;
          logger.error(`KD GTFS responded HTTP ${response.status}`);
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          this.#writeCache(buffer);
          return { buffer, fromCache: false, source: gtfsUrl };
        }
      } catch (error) {
        this.status.lastError = error.message;
        logger.error(`KD GTFS download failed: ${error.message}`);
      }
    }

    if (useCache) {
      const cached = this.#readCache();
      if (cached) {
        return { buffer: cached, fromCache: true, source: 'cache' };
      }
    }

    const message =
      username && password
        ? 'KD GTFS unavailable and no cached archive exists'
        : 'KD GTFS credentials not configured (KD_GTFS_USERNAME / KD_GTFS_PASSWORD)';
    throw new Error(message);
  }

  #cachePath() {
    return path.join(config.kd.cacheDir, 'google_transit.zip');
  }

  #writeCache(buffer) {
    if (!config.kd.useCache) return;
    try {
      fs.mkdirSync(config.kd.cacheDir, { recursive: true });
      fs.writeFileSync(this.#cachePath(), buffer);
    } catch (error) {
      logger.warn(`KD GTFS cache write failed: ${error.message}`);
    }
  }

  #readCache() {
    try {
      return fs.readFileSync(this.#cachePath());
    } catch {
      return null;
    }
  }

  /** Build every index from a GTFS zip buffer. Self-contained for tests. */
  async build(buffer) {
    const zip = new AdmZip(buffer);
    this.reset();

    this.#buildRoutes(zip);
    this.#buildStops(zip);
    this.#buildCalendar(zip);
    await this.#buildShapes(zip);
    this.#buildTrips(zip);
    await this.#buildStopTimes(zip);

    this.status.counts = {
      routes: this.routesById.size,
      trips: this.tripsById.size,
      stops: this.stopsById.size,
      stopTimes: [...this.stopTimesByTripId.values()].reduce((total, list) => total + list.length, 0),
      shapes: this.shapesById.size,
    };
  }

  #buildRoutes(zip) {
    const rows = parseTable(entryBuffer(zip, 'routes.txt') ?? Buffer.from(''));
    for (const row of rows) {
      if (!row.route_id) continue;
      this.routesById.set(row.route_id, {
        id: external.route(row.route_id),
        rawId: row.route_id,
        shortName: row.route_short_name || null,
        longName: row.route_long_name || null,
        routeType: row.route_type === undefined ? null : Number.parseInt(row.route_type, 10),
        color: row.route_color ? `#${row.route_color}` : null,
      });
    }
  }

  /**
   * A stop's display line, preferring the route short name (D6, D1/D62) and
   * falling back through the long name to the raw id.
   */
  routeName(routeId) {
    const route = this.routesById.get(routeId);
    if (!route) return null;
    return route.shortName || route.longName || route.rawId;
  }

  #buildStops(zip) {
    const rows = parseTable(entryBuffer(zip, 'stops.txt') ?? Buffer.from(''));
    for (const row of rows) {
      const lat = Number.parseFloat(row.stop_lat);
      const lon = Number.parseFloat(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const rawParent = row.parent_station || null;
      const stop = {
        id: external.stop(row.stop_id),
        rawId: row.stop_id,
        code: row.stop_code || null,
        name: row.stop_name || '',
        lat,
        lon,
        locationType: row.location_type === undefined ? null : Number.parseInt(row.location_type, 10),
        parentStation: rawParent ? external.stop(rawParent) : null,
        platformCode: row.platform_code || null,
        operator: OPERATOR,
      };
      this.stopsById.set(row.stop_id, stop);

      this.stopSearchIndex.push({ stop, normalized: normalizeSearchText(stop.name) });

      if (rawParent && row.location_type === '0') {
        let platforms = this.platformsByStation.get(rawParent);
        if (!platforms) {
          platforms = [];
          this.platformsByStation.set(rawParent, platforms);
        }
        platforms.push(row.stop_id);
      }
    }
  }

  #buildCalendar(zip) {
    const calendar = entryBuffer(zip, 'calendar.txt');
    if (calendar) {
      for (const row of parseTable(calendar)) {
        this.services.set(row.service_id, {
          days: DAY_KEYS.map((day) => row[day] === '1'),
          start: row.start_date || null,
          end: row.end_date || null,
          added: new Set(),
          removed: new Set(),
        });
      }
    }

    const exceptions = entryBuffer(zip, 'calendar_dates.txt');
    if (!exceptions) return;

    for (const row of parseTable(exceptions)) {
      let service = this.services.get(row.service_id);
      if (!service) {
        service = { days: DAY_KEYS.map(() => false), start: null, end: null, added: new Set(), removed: new Set() };
        this.services.set(row.service_id, service);
      }
      if (row.exception_type === '1') service.added.add(row.date);
      else if (row.exception_type === '2') service.removed.add(row.date);
    }
  }

  /** Shapes are optional in the KD feed; trips reference them by shape_id. */
  async #buildShapes(zip) {
    const buffer = entryBuffer(zip, 'shapes.txt');
    if (!buffer) return;

    const raw = new Map();
    await streamTable(buffer, (row) => {
      const lat = Number.parseFloat(row.shape_pt_lat);
      const lon = Number.parseFloat(row.shape_pt_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      let shape = raw.get(row.shape_id);
      if (!shape) {
        shape = { seq: [], lat: [], lon: [] };
        raw.set(row.shape_id, shape);
      }
      shape.seq.push(Number.parseInt(row.shape_pt_sequence, 10) || shape.seq.length);
      shape.lat.push(lat);
      shape.lon.push(lon);
    });

    for (const [shapeId, shape] of raw) {
      const order = shape.seq
        .map((sequence, index) => [sequence, index])
        .sort((a, b) => a[0] - b[0]);
      const points = new Float64Array(order.length * 2);
      order.forEach(([, index], position) => {
        points[position * 2] = shape.lat[index];
        points[position * 2 + 1] = shape.lon[index];
      });
      if (points.length < 4) continue;
      this.shapesById.set(shapeId, points);
    }
  }

  #buildTrips(zip) {
    const rows = parseTable(entryBuffer(zip, 'trips.txt') ?? Buffer.from(''));
    for (const row of rows) {
      if (!row.trip_id) continue;
      const shapeId = row.shape_id || null;
      this.tripsById.set(row.trip_id, {
        id: external.trip(row.trip_id),
        rawId: row.trip_id,
        routeId: row.route_id || null,
        serviceId: row.service_id || null,
        headsign: row.trip_headsign || null,
        directionId: row.direction_id === undefined || row.direction_id === '' ? null : Number.parseInt(row.direction_id, 10),
        shapeId,
        blockId: row.block_id || null,
      });

      const numericId = row.trip_id.split('_')[0];
      if (numericId) {
        let list = this.tripsByNumericId.get(numericId);
        if (!list) {
          list = [];
          this.tripsByNumericId.set(numericId, list);
        }
        list.push(row.trip_id);
      }
    }
  }

  /**
   * Full GTFS trip_ids sharing kiedyPrzyjedzie.pl's bare numeric `trip_id`
   * (the part of this feed's own trip_id before the first "_"). Usually one
   * match; when several services share a train number, the caller picks
   * with isServiceActive().
   */
  resolveTripsByNumericId(numericId) {
    return this.tripsByNumericId.get(String(numericId)) ?? [];
  }

  async #buildStopTimes(zip) {
    const buffer = entryBuffer(zip, 'stop_times.txt');
    if (!buffer) return;

    const rowsByStop = new Map();

    await streamTable(buffer, (row) => {
      if (!this.tripsById.has(row.trip_id)) return;
      if (!this.stopsById.has(row.stop_id)) return;

      const arrival = timeToSeconds(row.arrival_time);
      const departure = timeToSeconds(row.departure_time);
      if (arrival < 0 && departure < 0) return;

      let stops = this.stopTimesByTripId.get(row.trip_id);
      if (!stops) {
        stops = [];
        this.stopTimesByTripId.set(row.trip_id, stops);
      }
      stops.push({
        stopId: row.stop_id,
        sequence: Number.parseInt(row.stop_sequence, 10) || stops.length,
        arrival,
        departure,
        stopHeadsign: row.stop_headsign || null,
      });

      let bucket = rowsByStop.get(row.stop_id);
      if (!bucket) {
        bucket = [];
        rowsByStop.set(row.stop_id, bucket);
      }
      bucket.push({ tripId: row.trip_id, departure, arrival });
    });

    for (const [stopId, bucket] of rowsByStop) {
      bucket.sort((a, b) => a.departure - b.departure);
      this.departuresByStop.set(stopId, bucket);
    }
  }

  getStop(rawId) {
    return this.stopsById.get(rawId) ?? null;
  }

  /** Stop ids whose departures a stop id stands for (a station + its platforms). */
  departureStops(rawId) {
    const platforms = this.platformsByStation.get(rawId);
    return platforms ? [rawId, ...platforms] : [rawId];
  }

  /** Case/diacritic-insensitive stop search, ranked by match quality. */
  searchStops(query, limit = 20) {
    const needle = normalizeSearchText(query);
    if (!needle) return [];

    // Full scan over every stop, like the MPK store: ranking decides the
    // result, not insertion order (an early cutoff used to drop exact and
    // prefix hits indexed late).
    const results = [];
    for (const entry of this.stopSearchIndex) {
      const rank = matchRank(entry.normalized, needle);
      if (rank === -1) continue;
      results.push({ stop: entry.stop, rank });
    }

    return results
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.stop.locationType === 1 ? -1 : 1) - (b.stop.locationType === 1 ? -1 : 1) ||
          a.stop.name.length - b.stop.name.length ||
          a.stop.name.localeCompare(b.stop.name, 'pl') ||
          a.stop.id.localeCompare(b.stop.id),
      )
      .slice(0, limit)
      .map((entry) => entry.stop);
  }

  /** Is `serviceId` running on `date` (a Date in Europe/Warsaw)? */
  isServiceActive(serviceId, date) {
    const service = this.services.get(serviceId);
    if (!service) return true;

    const key = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate(),
    ).padStart(2, '0')}`;

    if (service.removed.has(key)) return false;
    if (service.added.has(key)) return true;
    if (service.start && key < service.start) return false;
    if (service.end && key > service.end) return false;
    return service.days[date.getDay()];
  }

  /**
   * Upcoming scheduled departures from a stop, filtered to services running
   * today. Realtime delays are layered on top by the service.
   *
   * @param {string} rawStopId raw GTFS stop id
   * @param {{ limit?: number, now?: Date, horizonSeconds?: number }} options
   */
  getDepartures(rawStopId, { limit = 20, now = new Date(), horizonSeconds = 7200 } = {}) {
    const stopIds = this.departureStops(rawStopId);
    const rows = [];
    for (const stopId of stopIds) {
      const bucket = this.departuresByStop.get(stopId);
      if (bucket) rows.push(...bucket);
    }
    if (!rows.length) return [];

    const localNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
    const secondsNow = localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();

    const yesterday = new Date(localNow);
    yesterday.setDate(yesterday.getDate() - 1);

    const collect = (filter, serviceDate, offset) =>
      rows
        .filter(filter)
        .map((row) => ({ ...row, offset }))
        .filter((row) => {
          const trip = this.tripsById.get(row.tripId);
          return trip && this.isServiceActive(trip.serviceId, serviceDate);
        })
        .filter((row) => row.departure - row.offset - secondsNow <= horizonSeconds)
        .map((row) => {
          const trip = this.tripsById.get(row.tripId);
          const departure = row.departure - row.offset;
          return {
            line: this.routeName(trip.routeId) ?? trip.routeId,
            type: 'train',
            operator: OPERATOR,
            headsign: trip.headsign || null,
            scheduledDeparture: secondsToTime(departure),
            departureSeconds: departure,
            tripId: trip.id,
            rawTripId: trip.rawId,
          };
        });

    // A trip that began yesterday can still be running past midnight; GTFS
    // encodes those as times beyond 24:00:00 on the previous service day.
    const departures = [
      ...collect((row) => row.departure >= 86_400 + secondsNow, yesterday, 86_400),
      ...collect((row) => row.departure >= secondsNow, localNow, 0),
    ];

    return departures.sort((a, b) => a.departureSeconds - b.departureSeconds).slice(0, limit);
  }

  /**
   * The ordered stops of a trip, with display names and scheduled times.
   * Returns null when the trip is unknown.
   */
  getTripStops(rawTripId) {
    const trip = this.tripsById.get(rawTripId);
    if (!trip) return null;
    const stops = this.stopTimesByTripId.get(rawTripId);
    if (!stops) return null;

    const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
    return {
      trip,
      stops: ordered.map((entry) => {
        const stop = this.stopsById.get(entry.stopId);
        return {
          stopId: external.stop(entry.stopId),
          rawStopId: entry.stopId,
          name: stop?.name ?? entry.stopId,
          platformCode: stop?.platformCode ?? null,
          sequence: entry.sequence,
          scheduledArrival: entry.arrival >= 0 ? secondsToTime(entry.arrival) : null,
          scheduledDeparture: entry.departure >= 0 ? secondsToTime(entry.departure) : null,
          arrivalSeconds: entry.arrival >= 0 ? entry.arrival : null,
          departureSeconds: entry.departure >= 0 ? entry.departure : null,
        };
      }),
    };
  }

  /**
   * The geometry of a trip, when the feed actually links one to it.
   *
   * The KD sample carries no shapes.txt at all, and even a feed with shapes
   * must link them via trips.shape_id before a trip can claim any — the answer
   * is a deliberate "no" rather than a straight line between stations.
   */
  getTripShape(rawTripId) {
    const trip = this.tripsById.get(rawTripId);
    if (!trip?.shapeId) return null;
    const points = this.shapesById.get(trip.shapeId);
    if (!points) return null;

    const wire = new Array(points.length / 2);
    for (let i = 0; i < wire.length; i += 1) {
      wire[i] = [
        Number(points[i * 2].toFixed(5)),
        Number(points[i * 2 + 1].toFixed(5)),
      ];
    }
    return { shapeId: trip.shapeId, points: wire };
  }
}

const entryBuffer = (zip, name) => {
  const entry = findEntry(zip, name);
  return entry ? entry.getData() : null;
};

module.exports = { KdStaticStore, OPERATOR, external };
