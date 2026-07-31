'use strict';

const AdmZip = require('adm-zip');

const config = require('../config');
const logger = require('../logger');
const { categorizeLines, lineToType } = require('../lines');
const { downloadGtfs } = require('./download');
const { assertComplete, entryBuffer, findEntry, isInForce } = require('./archive');
const { boundsOf, distanceMeters, distanceToPolyline, simplify } = require('./geo');
const { parseTable, secondsToTime, streamTable, timeToSeconds } = require('./parse');

const SHAPE_SIMPLIFY_METERS = 4;
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parsed and indexed GTFS feed.
 *
 * The previous implementation kept every table as a flat array and answered
 * each request with `Array.prototype.filter` over it — an O(rows) scan of a
 * ~1.5 million row `stop_times` table per call. Everything here is indexed once
 * at load time, so lookups are O(1) and the raw tables are released to the GC.
 */
class GtfsStore {
  constructor() {
    this.reset();
    this.status = {
      state: 'empty',
      source: null,
      snapshot: null,
      fetchedAt: null,
      builtAt: null,
      fromCache: false,
      buildMs: null,
      error: null,
      counts: {},
    };
  }

  reset() {
    /** @type {Map<string, object>} short name -> route metadata */
    this.routesByLine = new Map();
    /** @type {Map<string, object[]>} short name -> route variants */
    this.variantsByLine = new Map();
    /** @type {Map<string, object>} stop_id -> stop */
    this.stopsById = new Map();
    /** @type {object[]} compact trip records, addressed by index */
    this.trips = [];
    /** @type {Map<string, object>} service_id -> calendar */
    this.services = new Map();
    /** Parallel arrays holding one entry per stop_times row. */
    this.stopTimes = { trip: new Int32Array(0), arrival: new Int32Array(0), departure: new Int32Array(0) };
    /** @type {Map<string, Int32Array>} stop_id -> stop_times row indices, sorted by departure */
    this.departuresByStop = new Map();
    this.lines = categorizeLines([]);
  }

  get isReady() {
    return this.status.state === 'ready';
  }

  /** Download the newest archive and rebuild every index. */
  async refresh() {
    const previousState = this.status.state;
    this.status.state = previousState === 'ready' ? 'refreshing' : 'loading';

    try {
      const archive = await downloadGtfs({ validate: assertComplete, prefer: isInForce });
      const startedAt = Date.now();
      await this.build(archive.buffer);

      this.status = {
        ...this.status,
        state: 'ready',
        source: archive.source,
        snapshot: archive.snapshot ?? null,
        fetchedAt: archive.fetchedAt,
        fromCache: archive.fromCache,
        builtAt: new Date().toISOString(),
        buildMs: Date.now() - startedAt,
        error: null,
      };
      logger.info(
        `GTFS ready in ${this.status.buildMs} ms — ${this.status.counts.routes} routes, ` +
          `${this.status.counts.variants} variants, ${this.status.counts.stops} stops`,
      );
      return this.status;
    } catch (error) {
      this.status.error = error.message;
      this.status.state = previousState === 'ready' ? 'ready' : 'failed';
      logger.error('GTFS refresh failed:', error.message);
      throw error;
    }
  }

  /**
   * Build every index from a GTFS zip buffer.
   * Kept synchronous-ish and self-contained so it can be unit tested against a
   * small fixture archive.
   */
  async build(buffer) {
    const zip = new AdmZip(buffer);
    this.reset();

    const routeIdToLine = this.#buildRoutes(zip);
    const { representativeTripByShape } = this.#buildTrips(zip, routeIdToLine);
    this.#buildStops(zip);
    this.#buildCalendar(zip);
    const shapePoints = await this.#buildShapes(zip);

    return this.#buildStopTimes(zip, representativeTripByShape, shapePoints);
  }

  #buildRoutes(zip) {
    const rows = parseTable(entryBuffer(zip, 'routes.txt') ?? Buffer.from(''));
    const routeIdToLine = new Map();

    for (const row of rows) {
      const line = (row.route_short_name || row.route_id || '').trim();
      if (!line) continue;
      routeIdToLine.set(row.route_id, line);

      const existing = this.routesByLine.get(line);
      if (existing) {
        existing.routeIds.push(row.route_id);
        continue;
      }
      this.routesByLine.set(line, {
        line,
        routeIds: [row.route_id],
        longName: row.route_long_name || null,
        routeType: row.route_type ? Number.parseInt(row.route_type, 10) : null,
        color: row.route_color ? `#${row.route_color}` : null,
        category: lineToType(line),
      });
    }

    this.lines = categorizeLines([...this.routesByLine.keys()]);
    return routeIdToLine;
  }

  #buildTrips(zip, routeIdToLine) {
    const rows = parseTable(entryBuffer(zip, 'trips.txt') ?? Buffer.from(''));
    /** @type {Map<string, number>} trip_id -> index into this.trips */
    this.tripIndexById = new Map();
    /** @type {Map<string, number>} shape_id -> index of the trip used to describe it */
    const representativeTripByShape = new Map();
    /** @type {Map<string, number>} shape_id -> number of trips using it */
    const tripsPerShape = new Map();

    for (const row of rows) {
      const line = routeIdToLine.get(row.route_id);
      if (!line) continue;

      const index = this.trips.length;
      this.trips.push({
        id: row.trip_id,
        line,
        shapeId: row.shape_id || null,
        headsign: row.trip_headsign || null,
        serviceId: row.service_id || null,
        directionId: row.direction_id === undefined ? null : Number.parseInt(row.direction_id, 10),
      });
      this.tripIndexById.set(row.trip_id, index);

      if (!row.shape_id) continue;
      tripsPerShape.set(row.shape_id, (tripsPerShape.get(row.shape_id) ?? 0) + 1);
      if (!representativeTripByShape.has(row.shape_id)) {
        representativeTripByShape.set(row.shape_id, index);
      }
    }

    this.tripsPerShape = tripsPerShape;
    return { representativeTripByShape };
  }

  #buildStops(zip) {
    const rows = parseTable(entryBuffer(zip, 'stops.txt') ?? Buffer.from(''));
    for (const row of rows) {
      const lat = Number.parseFloat(row.stop_lat);
      const lon = Number.parseFloat(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      this.stopsById.set(row.stop_id, {
        id: row.stop_id,
        code: row.stop_code || null,
        name: row.stop_name || '',
        lat,
        lon,
      });
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

  async #buildShapes(zip) {
    const buffer = entryBuffer(zip, 'shapes.txt');
    if (!buffer) return new Map();

    /** @type {Map<string, {seq: number[], lat: number[], lon: number[]}>} */
    const raw = new Map();

    // shapes.txt is hundreds of thousands of rows; stream it so the parsed
    // array never exists all at once, and keep only the numbers per shape.
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

    /** @type {Map<string, Float64Array>} shape_id -> interleaved [lat, lon, ...] */
    const shapes = new Map();
    for (const [shapeId, shape] of raw) {
      const order = shape.seq
        .map((sequence, index) => [sequence, index])
        .sort((a, b) => a[0] - b[0]);

      const points = new Float64Array(order.length * 2);
      order.forEach(([, index], position) => {
        points[position * 2] = shape.lat[index];
        points[position * 2 + 1] = shape.lon[index];
      });
      shapes.set(shapeId, simplify(points, SHAPE_SIMPLIFY_METERS));
    }

    return shapes;
  }

  async #buildStopTimes(zip, representativeTripByShape, shapePoints) {
    const buffer = entryBuffer(zip, 'stop_times.txt');
    /** @type {Map<number, object[]>} trip index -> ordered stops (representatives only) */
    const representativeStops = new Map();
    for (const tripIndex of representativeTripByShape.values()) representativeStops.set(tripIndex, []);

    const tripColumn = [];
    const arrivalColumn = [];
    const departureColumn = [];
    /** @type {Map<string, number[]>} stop_id -> row indices */
    const rowsByStop = new Map();

    if (buffer) {
      await streamTable(buffer, (row) => {
        const tripIndex = this.tripIndexById.get(row.trip_id);
        if (tripIndex === undefined) return;

        const arrival = timeToSeconds(row.arrival_time);
        const departure = timeToSeconds(row.departure_time);

        const stops = representativeStops.get(tripIndex);
        if (stops) {
          stops.push({
            stopId: row.stop_id,
            sequence: Number.parseInt(row.stop_sequence, 10) || stops.length,
            arrival,
            departure,
          });
        }

        if (!config.gtfs.buildStopIndex) return;
        if (!this.stopsById.has(row.stop_id)) return;

        const index = tripColumn.length;
        tripColumn.push(tripIndex);
        arrivalColumn.push(arrival);
        departureColumn.push(departure);

        let bucket = rowsByStop.get(row.stop_id);
        if (!bucket) {
          bucket = [];
          rowsByStop.set(row.stop_id, bucket);
        }
        bucket.push(index);
      });
    }

    this.stopTimes = {
      trip: Int32Array.from(tripColumn),
      arrival: Int32Array.from(arrivalColumn),
      departure: Int32Array.from(departureColumn),
    };

    for (const [stopId, bucket] of rowsByStop) {
      bucket.sort((a, b) => this.stopTimes.departure[a] - this.stopTimes.departure[b]);
      this.departuresByStop.set(stopId, Int32Array.from(bucket));
    }

    this.#buildVariants(representativeTripByShape, representativeStops, shapePoints);

    this.status.counts = {
      routes: this.routesByLine.size,
      variants: [...this.variantsByLine.values()].reduce((total, list) => total + list.length, 0),
      stops: this.stopsById.size,
      trips: this.trips.length,
      stopTimes: this.stopTimes.trip.length,
      shapes: shapePoints.size,
    };

    return this.status.counts;
  }

  #buildVariants(representativeTripByShape, representativeStops, shapePoints) {
    for (const [shapeId, tripIndex] of representativeTripByShape) {
      const trip = this.trips[tripIndex];
      const points = shapePoints.get(shapeId);
      if (!points || points.length < 4) continue;

      const stops = (representativeStops.get(tripIndex) ?? [])
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => {
          const stop = this.stopsById.get(entry.stopId);
          return stop
            ? {
                id: stop.id,
                name: stop.name,
                lat: stop.lat,
                lon: stop.lon,
                arrival: secondsToTime(entry.arrival),
                departure: secondsToTime(entry.departure),
                sequence: entry.sequence,
              }
            : null;
        })
        .filter(Boolean);

      const first = stops[0]?.name ?? '';
      const last = stops[stops.length - 1]?.name ?? '';

      const variant = {
        shapeId,
        line: trip.line,
        directionId: trip.directionId,
        headsign: trip.headsign || last || null,
        direction: first && last ? `${first} → ${last}` : trip.headsign || null,
        tripCount: this.tripsPerShape.get(shapeId) ?? 1,
        points,
        stops,
        bounds: boundsOf(points),
      };

      const existing = this.variantsByLine.get(trip.line);
      if (existing) existing.push(variant);
      else this.variantsByLine.set(trip.line, [variant]);
    }

    // Most used variant first — that is the one riders recognise as "the" route.
    for (const variants of this.variantsByLine.values()) {
      variants.sort((a, b) => b.tripCount - a.tripCount);
    }
  }

  hasLine(line) {
    return this.variantsByLine.has(line) || this.routesByLine.has(line);
  }

  getVariants(line) {
    return this.variantsByLine.get(line) ?? [];
  }

  /**
   * Pick the route variant a vehicle is most likely running, by proximity of
   * its reported position to each variant's polyline.
   */
  getBestVariant(line, lat, lon) {
    const variants = this.getVariants(line);
    if (!variants.length) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return variants[0];

    let best = variants[0];
    let bestDistance = Infinity;

    for (const variant of variants) {
      // Cheap rejection: a variant whose bounding box is already further away
      // than the current best cannot contain a closer point.
      if (variant.bounds) {
        const clampedLat = Math.min(Math.max(lat, variant.bounds.minLat), variant.bounds.maxLat);
        const clampedLon = Math.min(Math.max(lon, variant.bounds.minLon), variant.bounds.maxLon);
        if (distanceMeters(lat, lon, clampedLat, clampedLon) > bestDistance) continue;
      }

      const distance = distanceToPolyline(lat, lon, variant.points);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = variant;
      }
    }

    return best;
  }

  getStop(stopId) {
    return this.stopsById.get(stopId) ?? null;
  }

  /**
   * Stops within `radiusMeters` of a point, nearest first.
   *
   * A linear scan with real haversine distances, not a lat/lon grid. Wrocław
   * has a few thousand stops, so the scan costs microseconds — and a grid is
   * where the easy bug lives: a degree of longitude is about 0.63 of a degree
   * of latitude at this latitude, so a grid built on 111 km/degree for both
   * axes under-searches east and west.
   */
  findStopsNear(lat, lon, { radiusMeters = 500, limit = 20 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

    const found = [];
    for (const stop of this.stopsById.values()) {
      const distance = distanceMeters(lat, lon, stop.lat, stop.lon);
      if (distance <= radiusMeters) found.push({ ...stop, distance: Math.round(distance) });
    }

    return found.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }

  /** Case/diacritic-insensitive stop search, ranked by prefix match. */
  searchStops(query, limit = 20) {
    const needle = query.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    if (!needle) return [];

    const results = [];
    for (const stop of this.stopsById.values()) {
      const haystack = stop.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      const position = haystack.indexOf(needle);
      if (position === -1) continue;
      results.push({ stop, rank: position });
      if (results.length > limit * 10) break;
    }

    return results
      .sort((a, b) => a.rank - b.rank || a.stop.name.localeCompare(b.stop.name, 'pl'))
      .slice(0, limit)
      .map((entry) => entry.stop);
  }

  /** Is `serviceId` running on `date` (a Date in Europe/Warsaw)? */
  isServiceActive(serviceId, date) {
    const service = this.services.get(serviceId);
    if (!service) return true; // No calendar information — assume it runs.

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
   * Upcoming departures from a stop, filtered to services running today.
   *
   * @param {string} stopId
   * @param {{ limit?: number, now?: Date, horizonSeconds?: number }} options
   */
  getDepartures(stopId, { limit = 20, now = new Date(), horizonSeconds = 7200 } = {}) {
    const rows = this.departuresByStop.get(stopId);
    if (!rows || !rows.length) return [];

    const localNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
    const secondsNow =
      localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();

    const yesterday = new Date(localNow);
    yesterday.setDate(yesterday.getDate() - 1);

    // rows is sorted by departure time, so a binary search finds where to start.
    const lowerBound = (target) => {
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (this.stopTimes.departure[rows[mid]] < target) low = mid + 1;
        else high = mid;
      }
      return low;
    };

    const collect = (from, serviceDate, offset, label) => {
      const found = [];
      for (let i = from; i < rows.length && found.length < limit; i += 1) {
        const departure = this.stopTimes.departure[rows[i]];
        // rows is sorted, so the first departure past the horizon ends the scan.
        if (departure - offset - secondsNow > horizonSeconds) break;
        const trip = this.trips[this.stopTimes.trip[rows[i]]];
        if (!this.isServiceActive(trip.serviceId, serviceDate)) continue;
        found.push({
          line: trip.line,
          type: lineToType(trip.line),
          headsign: trip.headsign,
          departure: secondsToTime(departure),
          inSeconds: departure - offset - secondsNow,
          tripId: trip.id,
          serviceDay: label,
        });
      }
      return found;
    };

    // A trip that began yesterday can still be running past midnight; GTFS
    // encodes those as times beyond 24:00:00 on the previous service day.
    const departures = [
      ...collect(lowerBound(86_400 + secondsNow), yesterday, 86_400, 'yesterday'),
      ...collect(lowerBound(secondsNow), localNow, 0, 'today'),
    ];

    return departures.sort((a, b) => a.inSeconds - b.inSeconds).slice(0, limit);
  }
}

module.exports = { GtfsStore, SHAPE_SIMPLIFY_METERS, assertComplete, findEntry };
