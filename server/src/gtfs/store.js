'use strict';

const AdmZip = require('adm-zip');
const { performance } = require('node:perf_hooks');

const config = require('../config');
const logger = require('../logger');
const { categorizeLines, lineToType } = require('../lines');
const { timeSync } = require('../metrics');
const { matchRank, normalizeSearchText } = require('../search');
const { downloadGtfs } = require('./download');
const { assertComplete, entryBuffer, findEntry, isInForce } = require('./archive');
const {
  angleBetween,
  boundsOf,
  cumulativeDistances,
  distanceMeters,
  projectToPolyline,
  simplify,
} = require('./geo');
const { inWarsaw, parseTable, secondsToTime, streamTableFast, timeToSeconds } = require('./parse');
const { GrowableFloat64Array, GrowableInt32Array } = require('./typed-arrays');

const SHAPE_SIMPLIFY_METERS = 4;
/** Duplicate pattern records at one platform are close; opposite directions are not. */
const SAME_PLATFORM_RADIUS_METERS = 12;

/**
 * Wrocław's five-digit stop codes end in a platform suffix: `24505`, `24534`
 * belong to the same `245` stop area. Some feeds omit codes, so callers still
 * need the coordinate fallback below.
 */
const stopAreaCode = (stop) => {
  const code = String(stop.code ?? '').trim();
  return /^\d{5,}$/.test(code) ? code.slice(0, -2) : null;
};

const sameBoardingArea = (a, b) => {
  if (a.name !== b.name) return false;
  const aArea = stopAreaCode(a);
  const bArea = stopAreaCode(b);
  if (aArea && bArea) return aArea === bArea;
  return distanceMeters(a.lat, a.lon, b.lat, b.lon) <= SAME_PLATFORM_RADIUS_METERS;
};
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * How much a variant running the wrong way is penalised when matching a
 * vehicle, in metres of apparent extra distance.
 *
 * Both directions of a line share the same street, and often the same few
 * metres of track, so the distance to the polyline alone cannot say which way
 * a vehicle is going — it picks whichever variant happens to be a couple of
 * metres nearer, and the app then announces the opposite terminus. The
 * reported heading is what actually distinguishes them, scaled here so a
 * variant pointing backwards has to be 400 m closer to win.
 */
const HEADING_PENALTY_METERS = 400;

/**
 * Parsed and indexed GTFS feed.
 *
 * The previous implementation kept every table as a flat array and answered
 * each request with `Array.prototype.filter` over it — an O(rows) scan of a
 * ~1.5 million row `stop_times` table per call. Everything here is indexed once
 * at load time, so lookups are O(1) and the raw tables are released to the GC.
 */
class GtfsStore {
  /**
   * Reference to the most recently committed, live snapshot state, or null when
   * no usable timetable is installed (freshly constructed, or after reset()).
   * build() sets it when it commits a real candidate; reset() clears it. It must
   * NOT be derived from `generation`: generation is monotonically increasing and
   * survives a reset, so `generation > 0` is not a proof that a snapshot exists.
   */
  #activeSnapshot = null;

  /**
   * @param {{ downloader?: (options: object) => Promise<object> }} [options]
   *   `downloader` is how `refresh()` obtains an archive — injectable for
   *   tests so atomic refresh can be exercised without the network. The
   *   default resolves and validates the real city feed.
   */
  constructor({ downloader = downloadGtfs } = {}) {
    this.downloader = downloader;
    // Bumped exactly once per successful build, on commit. Caches keyed on
    // timetable data use it to refuse entries that were computed against older
    // geometry; it never moves on a failed refresh.
    this.generation = 0;
    /** Stage timings and memory from the latest successful build, or null. */
    this.performance = null;
    /** @type {Promise<object>|null} an in-flight refresh; overlapping calls share one run */
    this.refreshingPromise = null;
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
      // True while a refresh is running against a live snapshot. `state` stays
      // 'ready' throughout, so `/health` reports the refresh instead of the
      // endpoints going 503.
      refreshing: false,
      generation: 0,
    };
    this.reset();
  }

  /**
   * Replace the live snapshot with a fresh, empty one. Not part of the refresh
   * path — `build()` never resets the active store — but kept for callers that
   * want to forget everything.
   */
  reset() {
    this.#activeSnapshot = null;
    this.#commit(this.#emptyState());
    this.status.state = 'empty';
    this.status.refreshing = false;
  }

  /** A fresh, uncommitted GTFS state. Nothing here is live until #commit. */
  #emptyState() {
    return {
      /** @type {Map<string, object>} short name -> route metadata */
      routesByLine: new Map(),
      /** @type {Map<string, object>} route_id -> route metadata (agency, line) */
      routesById: new Map(),
      /** @type {Map<string, object>} agency_id -> agency */
      agencies: new Map(),
      /** @type {Map<string, object[]>} short name -> route variants */
      variantsByLine: new Map(),
      /** @type {Map<string, object>} shape_id -> route variant */
      variantByShapeId: new Map(),
      /** @type {Map<string, object>} stop_id -> stop */
      stopsById: new Map(),
      /**
       * Search index over the stops, built once at load time. The name is
       * folded (diacritics, case) in this entry, not on every query.
       * @type {Array<{ stop: object, normalized: string }>}
       */
      stopSearchIndex: [],
      /**
       * Which lines call at a stop, built once from the variants.
       *
       * Answering this by walking every variant of every line costs about
       * twelve thousand comparisons per stop, which is fine for the one stop
       * behind a departures board and not fine for the hundred behind a map
       * viewport.
       * @type {Map<string, string[]>} stop_id -> line short names
       */
      linesByStopId: new Map(),
      /** @type {object[]} compact trip records, addressed by index */
      trips: [],
      /** @type {Map<string, number>} trip_id -> index into this.trips */
      tripIndexById: new Map(),
      /** @type {Map<string, number[]>} trips.vehicle_id -> trip indices */
      tripsByVehicleId: new Map(),
      /** @type {Map<string, number[]>} trips.brigade_id -> trip indices */
      tripsByBrigade: new Map(),
      /** @type {Map<string, number[]>} shape_id -> trip indices running it */
      tripsByShape: new Map(),
      /** Seconds after midnight each trip leaves its first stop, by trip index. */
      tripStart: new Int32Array(0),
      /** Seconds after midnight each trip reaches its last stop, by trip index. */
      tripEnd: new Int32Array(0),
      /** @type {Map<string, object>} service_id -> calendar */
      services: new Map(),
      /** Parallel arrays holding one entry per stop_times row. */
      stopTimes: { trip: new Int32Array(0), arrival: new Int32Array(0), departure: new Int32Array(0) },
      /** @type {Map<string, Int32Array>} stop_id -> stop_times row indices, sorted by departure */
      departuresByStop: new Map(),
      lines: categorizeLines([]),
      counts: {},
    };
  }

  /**
   * Swap a fully built candidate state in — every field in one synchronous
   * block, so no request can observe half-old / half-new data, and the only
   * moment a reader sees the new snapshot is after all of it is in place.
   */
  #commit(state) {
    this.routesByLine = state.routesByLine;
    this.routesById = state.routesById;
    this.agencies = state.agencies;
    this.variantsByLine = state.variantsByLine;
    this.variantByShapeId = state.variantByShapeId;
    this.stopsById = state.stopsById;
    this.stopSearchIndex = state.stopSearchIndex;
    this.linesByStopId = state.linesByStopId;
    this.trips = state.trips;
    this.tripIndexById = state.tripIndexById;
    this.tripsByVehicleId = state.tripsByVehicleId;
    this.tripsByBrigade = state.tripsByBrigade;
    this.tripsByShape = state.tripsByShape;
    this.tripStart = state.tripStart;
    this.tripEnd = state.tripEnd;
    this.services = state.services;
    this.stopTimes = state.stopTimes;
    this.departuresByStop = state.departuresByStop;
    this.lines = state.lines;
    this.status.counts = state.counts;
  }

  get isReady() {
    return this.status.state === 'ready';
  }

  /** True when build() has committed a live snapshot and reset() has not since wiped it. */
  get hasActiveSnapshot() {
    return this.#activeSnapshot !== null;
  }

  /**
   * Download the newest archive and rebuild every index, transactionally.
   *
   * While a valid snapshot exists the store keeps serving it: `state` stays
   * 'ready' for the whole run (`isReady` never dips), the candidate is built
   * and validated in isolation, and only a fully valid candidate is swapped in
   * and bumps `generation`. Any failure — download, zip, parse, index or
   * validation — keeps the previous snapshot completely intact, records the
   * error on `status`, and throws.
   *
   * Overlapping calls share a single in-flight refresh rather than racing.
   */
  refresh() {
    if (this.refreshingPromise) return this.refreshingPromise;
    const run = this.#doRefresh().finally(() => {
      this.refreshingPromise = null;
    });
    this.refreshingPromise = run;
    return run;
  }

  async #doRefresh() {
    // Only the first-ever load is a cold boot; a refresh over a live snapshot
    // keeps serving it, so `state` must not leave 'ready' and isReady must not
    // flicker. `generation` must not be the test — it is monotonic and survives
    // a reset() that wipes the live snapshot — so the active-snapshot reference
    // is what gates the loading-vs-ready and failed-vs-loading transitions.
    const hasSnapshot = this.hasActiveSnapshot;
    this.status.refreshing = true;
    if (!hasSnapshot) this.status.state = 'loading';

    try {
      const archive = await this.downloader({ validate: assertComplete, prefer: isInForce });
      const startedAt = Date.now();
      await this.build(archive.buffer);

      this.status = {
        ...this.status,
        state: 'ready',
        refreshing: false,
        source: archive.source,
        snapshot: archive.snapshot ?? null,
        fetchedAt: archive.fetchedAt,
        fromCache: archive.fromCache,
        builtAt: new Date().toISOString(),
        buildMs: Date.now() - startedAt,
        error: null,
        generation: this.generation,
      };
      logger.info(
        `GTFS ready in ${this.status.buildMs} ms — ${this.status.counts.routes} routes, ` +
          `${this.status.counts.variants} variants, ${this.status.counts.stops} stops`,
      );
      return this.status;
    } catch (error) {
      // The candidate never reached #commit, so the previous snapshot — and
      // every index, typed array and cache entry built from it — is intact.
      this.status.refreshing = false;
      this.status.error = error.message;
      this.status.state = hasSnapshot ? 'ready' : 'failed';
      logger.error('GTFS refresh failed:', error.message);
      throw error;
    }
  }

  /**
   * Build every index from a GTFS zip buffer.
   *
   * Parsing, indexing and validation happen against a candidate state that is
   * completely separate from the live one; the candidate is installed in a
   * single atomic swap and `generation` bumps only when it is. Any exception —
   * bad zip, unparseable CSV, an error partway through the shapes or
   * stop_times pass — leaves the live store untouched.
   *
   * Kept synchronous-ish and self-contained so it can be unit tested against a
   * small fixture archive.
   *
   * @returns {object} the resulting counts (also on `status.counts`)
   */
  async build(buffer) {
    const state = this.#emptyState();
    const counts = await this.#buildInto(state, buffer);

    // The candidate is fully built and valid — swap it in as one block, then
    // bump the generation so caches keyed on timetable data know to rebuild.
    this.#commit(state);
    this.#activeSnapshot = state;
    this.generation += 1;
    return counts;
  }

  /**
   * Parse and index `buffer` into `state`. Nothing here reads or mutates the
   * live store, so a throw at any stage leaves the previous snapshot intact.
   */
  async #buildInto(state, buffer) {
    const startedAt = performance.now();

    // Memory is sampled only at the build boundaries below, never on a timer:
    // process.memoryUsage() forces a GC when it is called frequently, so a
    // background sampler would distort exactly what it measures. Each stage
    // keeps the running peak and the final sample becomes the "latest".
    const memory = { peak: {}, latest: {} };
    const sampleMemory = () => {
      const usage = process.memoryUsage();
      for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) {
        const value = usage[key] ?? 0;
        if (!(key in memory.peak) || value > memory.peak[key]) memory.peak[key] = value;
        memory.latest[key] = value;
      }
    };
    const stages = {};
    const stage = (name, fn) => {
      const { ms, result } = timeSync(fn);
      stages[name] = ms;
      sampleMemory();
      return result;
    };

    const zip = new AdmZip(buffer);
    stages.archiveOpen = performance.now() - startedAt;
    sampleMemory();

    stage('agency', () => this.#buildAgency(state, zip));
    const routeIdToLine = stage('routes', () => this.#buildRoutes(state, zip));
    const { representativeTripByShape } = stage('trips', () => this.#buildTrips(state, zip, routeIdToLine));
    stage('stops', () => this.#buildStops(state, zip));
    stage('calendar', () => this.#buildCalendar(state, zip));

    const shapesStart = performance.now();
    const shapePoints = await this.#buildShapes(zip);
    stages.shapes = performance.now() - shapesStart;
    sampleMemory();

    const counts = await this.#buildStopTimes(state, zip, representativeTripByShape, shapePoints, stages);
    sampleMemory();

    stages.total = performance.now() - startedAt;

    const mb = (value) => Number((value / 1e6).toFixed(1));
    this.performance = {
      lastBuild: {
        totalMs: stages.total,
        stages,
        latestMemory: {
          rssMb: mb(memory.latest.rss),
          heapUsedMb: mb(memory.latest.heapUsed),
          externalMb: mb(memory.latest.external),
          arrayBuffersMb: mb(memory.latest.arrayBuffers),
        },
        peakMemory: {
          rssMb: mb(memory.peak.rss),
          heapUsedMb: mb(memory.peak.heapUsed),
          externalMb: mb(memory.peak.external),
          arrayBuffersMb: mb(memory.peak.arrayBuffers),
        },
      },
    };

    return counts;
  }

  #buildAgency(state, zip) {
    const rows = parseTable(entryBuffer(zip, 'agency.txt') ?? Buffer.from(''));
    for (const row of rows) {
      state.agencies.set(row.agency_id, {
        id: row.agency_id,
        name: row.agency_name || null,
      });
    }
  }

  #buildRoutes(state, zip) {
    const rows = parseTable(entryBuffer(zip, 'routes.txt') ?? Buffer.from(''));
    const routeIdToLine = new Map();

    for (const row of rows) {
      const line = (row.route_short_name || row.route_id || '').trim();
      if (!line) continue;
      routeIdToLine.set(row.route_id, line);

      // Per-route_id metadata: the live feeds of subcontractor fleets carry
      // route ids, not line names, and operator comes from routes.agency_id.
      if (!state.routesById.has(row.route_id)) {
        state.routesById.set(row.route_id, {
          line,
          agencyId: row.agency_id || null,
          longName: row.route_long_name || null,
          routeType: row.route_type ? Number.parseInt(row.route_type, 10) : null,
          color: row.route_color ? `#${row.route_color}` : null,
        });
      }

      const existing = state.routesByLine.get(line);
      if (existing) {
        existing.routeIds.push(row.route_id);
        continue;
      }
      state.routesByLine.set(line, {
        line,
        routeIds: [row.route_id],
        longName: row.route_long_name || null,
        routeType: row.route_type ? Number.parseInt(row.route_type, 10) : null,
        color: row.route_color ? `#${row.route_color}` : null,
        category: lineToType(line),
      });
    }

    state.lines = categorizeLines([...state.routesByLine.keys()]);
    return routeIdToLine;
  }

  #buildTrips(state, zip, routeIdToLine) {
    const rows = parseTable(entryBuffer(zip, 'trips.txt') ?? Buffer.from(''));
    /** @type {Map<string, number>} shape_id -> index of the trip used to describe it */
    const representativeTripByShape = new Map();

    for (const row of rows) {
      const line = routeIdToLine.get(row.route_id);
      if (!line) continue;

      const index = state.trips.length;
      state.trips.push({
        id: row.trip_id,
        line,
        routeId: row.route_id || null,
        shapeId: row.shape_id || null,
        headsign: row.trip_headsign || null,
        serviceId: row.service_id || null,
        directionId: row.direction_id === undefined ? null : Number.parseInt(row.direction_id, 10),
        // Subcontractor fleets are matched to their runs through these: the
        // Wrocław feed is the authority on its own buses, but Kłosok's live
        // GTFS-RT positions identify a bus by vehicle or brigade rather than
        // trip on some days, and trips.txt is what connects those back here.
        vehicleId: row.vehicle_id || null,
        blockId: row.brigade_id || row.block_id || null,
      });
      state.tripIndexById.set(row.trip_id, index);

      if (row.vehicle_id) {
        const bucket = state.tripsByVehicleId.get(row.vehicle_id);
        if (bucket) bucket.push(index);
        else state.tripsByVehicleId.set(row.vehicle_id, [index]);
      }
      const brigade = row.brigade_id || row.block_id;
      if (brigade) {
        const bucket = state.tripsByBrigade.get(brigade);
        if (bucket) bucket.push(index);
        else state.tripsByBrigade.set(brigade, [index]);
      }

      if (!row.shape_id) continue;
      // Every trip on the shape is kept, not just a count: matching a live
      // vehicle to the run it is on means asking which of today's departures
      // would be here now, and that needs their start times.
      const siblings = state.tripsByShape.get(row.shape_id);
      if (siblings) siblings.push(index);
      else state.tripsByShape.set(row.shape_id, [index]);

      if (!representativeTripByShape.has(row.shape_id)) {
        representativeTripByShape.set(row.shape_id, index);
      }
    }

    return { representativeTripByShape };
  }

  #buildStops(state, zip) {
    const rows = parseTable(entryBuffer(zip, 'stops.txt') ?? Buffer.from(''));
    for (const row of rows) {
      const lat = Number.parseFloat(row.stop_lat);
      const lon = Number.parseFloat(row.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const stop = {
        id: row.stop_id,
        code: row.stop_code || null,
        name: row.stop_name || '',
        lat,
        lon,
      };
      state.stopsById.set(row.stop_id, stop);
      // Folded once here, at load time, so a search never re-normalizes the
      // whole feed. Kept off the stop object itself (which travels through the
      // API) and in a parallel entry instead.
      state.stopSearchIndex.push({ stop, normalized: normalizeSearchText(stop.name) });
    }
  }

  #buildCalendar(state, zip) {
    const calendar = entryBuffer(zip, 'calendar.txt');
    if (calendar) {
      for (const row of parseTable(calendar)) {
        state.services.set(row.service_id, {
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
      let service = state.services.get(row.service_id);
      if (!service) {
        service = { days: DAY_KEYS.map(() => false), start: null, end: null, added: new Set(), removed: new Set() };
        state.services.set(row.service_id, service);
      }
      if (row.exception_type === '1') service.added.add(row.date);
      else if (row.exception_type === '2') service.removed.add(row.date);
    }
  }

  async #buildShapes(zip) {
    const buffer = entryBuffer(zip, 'shapes.txt');
    if (!buffer) return new Map();

    /**
     * @type {Map<string, {seq: GrowableInt32Array, lat: GrowableFloat64Array,
     *   lon: GrowableFloat64Array}>}
     */
    const raw = new Map();

    // shapes.txt is hundreds of thousands of rows; stream it so the parsed
    // array never exists all at once, and keep only the numbers per shape,
    // in typed arrays so no value is ever a boxed JS number.
    let colShapeId;
    let colLat;
    let colLon;
    let colSequence;
    await streamTableFast(buffer, (fields, columns) => {
      if (colShapeId === undefined) {
        colShapeId = columns.get('shape_id');
        colLat = columns.get('shape_pt_lat');
        colLon = columns.get('shape_pt_lon');
        colSequence = columns.get('shape_pt_sequence');
      }
      const lat = Number.parseFloat(fields[colLat]);
      const lon = Number.parseFloat(fields[colLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const shapeId = fields[colShapeId];
      let shape = raw.get(shapeId);
      if (!shape) {
        shape = { seq: new GrowableInt32Array(64), lat: new GrowableFloat64Array(64), lon: new GrowableFloat64Array(64) };
        raw.set(shapeId, shape);
      }
      shape.seq.push(Number.parseInt(fields[colSequence], 10) || shape.seq.length);
      shape.lat.push(lat);
      shape.lon.push(lon);
    });

    /** @type {Map<string, Float64Array>} shape_id -> interleaved [lat, lon, ...] */
    const shapes = new Map();
    for (const [shapeId, shape] of raw) {
      // Points are ordered by sequence. Sorting indices (an Int32Array with a
      // comparator) rather than materialising `[sequence, index]` pairs for
      // every point avoids millions of tiny object allocations; GTFS shapes
      // are usually already in order, so TimSort on the near-sorted indices
      // is near-linear.
      const count = shape.seq.length;
      const order = new Int32Array(count);
      for (let i = 0; i < count; i += 1) order[i] = i;
      order.sort((a, b) => shape.seq.buffer[a] - shape.seq.buffer[b]);

      const points = new Float64Array(count * 2);
      for (let position = 0; position < count; position += 1) {
        const index = order[position];
        points[position * 2] = shape.lat.buffer[index];
        points[position * 2 + 1] = shape.lon.buffer[index];
      }
      shapes.set(shapeId, simplify(points, SHAPE_SIMPLIFY_METERS));
      // The raw arrays are no longer needed once this shape is simplified;
      // dropping them keeps the peak from holding every shape twice.
      raw.delete(shapeId);
    }

    return shapes;
  }

  async #buildStopTimes(state, zip, representativeTripByShape, shapePoints, stages) {
    const buffer = entryBuffer(zip, 'stop_times.txt');
    const startedAt = performance.now();
    /** @type {Map<number, object[]>} trip index -> ordered stops (representatives only) */
    const representativeStops = new Map();
    for (const tripIndex of representativeTripByShape.values()) representativeStops.set(tripIndex, []);

    // Column values are collected into growable typed arrays — not JS arrays
    // copied later with Int32Array.from — so the peak holds one buffer per
    // column plus the final exact-size arrays, and no boxed numbers.
    const tripColumn = new GrowableInt32Array(1 << 16);
    const arrivalColumn = new GrowableInt32Array(1 << 16);
    const departureColumn = new GrowableInt32Array(1 << 16);
    /** @type {Map<string, GrowableInt32Array>} stop_id -> row indices */
    const rowsByStop = new Map();

    // One entry per trip rather than per row: cheap enough to keep for the
    // whole feed, and it is what turns "this vehicle is 40% along the route"
    // into "it is the 08:12 running four minutes late".
    const tripStart = new Int32Array(state.trips.length).fill(-1);
    const tripEnd = new Int32Array(state.trips.length).fill(-1);

    if (buffer) {
      let colTripId;
      let colArrival;
      let colDeparture;
      let colStopId;
      let colSequence;
      await streamTableFast(buffer, (fields, columns) => {
        if (colTripId === undefined) {
          colTripId = columns.get('trip_id');
          colArrival = columns.get('arrival_time');
          colDeparture = columns.get('departure_time');
          colStopId = columns.get('stop_id');
          colSequence = columns.get('stop_sequence');
        }

        const tripIndex = state.tripIndexById.get(fields[colTripId]);
        if (tripIndex === undefined) return;

        const arrival = timeToSeconds(fields[colArrival]);
        const departure = timeToSeconds(fields[colDeparture]);

        const first = departure >= 0 ? departure : arrival;
        if (first >= 0 && (tripStart[tripIndex] < 0 || first < tripStart[tripIndex])) {
          tripStart[tripIndex] = first;
        }
        const last = arrival >= 0 ? arrival : departure;
        if (last > tripEnd[tripIndex]) tripEnd[tripIndex] = last;

        const stops = representativeStops.get(tripIndex);
        if (stops) {
          stops.push({
            stopId: fields[colStopId],
            sequence: Number.parseInt(fields[colSequence], 10) || stops.length,
            arrival,
            departure,
          });
        }

        if (!config.gtfs.buildStopIndex) return;
        if (!state.stopsById.has(fields[colStopId])) return;

        tripColumn.push(tripIndex);
        arrivalColumn.push(arrival);
        departureColumn.push(departure);

        let bucket = rowsByStop.get(fields[colStopId]);
        if (!bucket) {
          bucket = new GrowableInt32Array(64);
          rowsByStop.set(fields[colStopId], bucket);
        }
        bucket.push(tripColumn.length - 1);
      });
    }

    state.stopTimes = {
      trip: tripColumn.toArray(),
      arrival: arrivalColumn.toArray(),
      departure: departureColumn.toArray(),
    };
    state.tripStart = tripStart;
    state.tripEnd = tripEnd;

    for (const [stopId, bucket] of rowsByStop) {
      state.departuresByStop.set(
        stopId,
        bucket.takeSorted((a, b) => state.stopTimes.departure[a] - state.stopTimes.departure[b]),
      );
    }

    // Everything above this line built per-stop indexes from the columns;
    // release the row-based temporaries before the variants pass allocates
    // the per-shape geometry. Clearing the bucket map and dropping the grown
    // column buffers keeps the peak from holding two copies of the numbers.
    rowsByStop.clear();
    tripColumn.buffer = new Int32Array(0);
    arrivalColumn.buffer = new Int32Array(0);
    departureColumn.buffer = new Int32Array(0);

    const variantsStart = performance.now();
    this.#buildVariants(state, representativeTripByShape, representativeStops, shapePoints);
    stages.variants = performance.now() - variantsStart;
    // The parse, per-stop index and cleanup above, without the variants pass.
    stages.stopTimes = variantsStart - startedAt;

    state.counts = {
      routes: state.routesByLine.size,
      variants: [...state.variantsByLine.values()].reduce((total, list) => total + list.length, 0),
      stops: state.stopsById.size,
      trips: state.trips.length,
      stopTimes: state.stopTimes.trip.length,
      shapes: shapePoints.size,
    };

    return state.counts;
  }

  #buildVariants(state, representativeTripByShape, representativeStops, shapePoints) {
    for (const [shapeId, tripIndex] of representativeTripByShape) {
      const trip = state.trips[tripIndex];
      const points = shapePoints.get(shapeId);
      if (!points || points.length < 4) continue;

      const cumulative = cumulativeDistances(points);
      // Offsets are measured from the moment the trip leaves its first stop, so
      // they hold for every run of the shape rather than only the one sampled
      // here — that is what lets a live vehicle be timed against any departure.
      const base = state.tripStart[tripIndex] >= 0 ? state.tripStart[tripIndex] : null;

      // Stops are projected onto the shape in order, each search starting where
      // the previous stop landed. A route that passes the same street twice
      // would otherwise place its second visit back at the first one.
      let searchFrom = 0;

      const stops = (representativeStops.get(tripIndex) ?? [])
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => {
          const stop = state.stopsById.get(entry.stopId);
          if (!stop) return null;

          const projection = projectToPolyline(stop.lat, stop.lon, points, {
            cumulative,
            fromIndex: searchFrom,
          });
          if (projection) searchFrom = projection.index;

          const arrival = entry.arrival >= 0 ? entry.arrival : entry.departure;
          const departure = entry.departure >= 0 ? entry.departure : entry.arrival;

          return {
            id: stop.id,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon,
            arrival: secondsToTime(entry.arrival),
            departure: secondsToTime(entry.departure),
            sequence: entry.sequence,
            alongMeters: projection ? projection.along : 0,
            arrivalOffset: base !== null && arrival >= 0 ? arrival - base : null,
            departureOffset: base !== null && departure >= 0 ? departure - base : null,
          };
        })
        .filter(Boolean);

      const first = stops[0]?.name ?? '';
      const last = stops[stops.length - 1]?.name ?? '';

      const tripIndices = state.tripsByShape.get(shapeId) ?? [tripIndex];

      const variant = {
        shapeId,
        line: trip.line,
        directionId: trip.directionId,
        headsign: trip.headsign || last || null,
        direction: first && last ? `${first} → ${last}` : trip.headsign || null,
        tripCount: tripIndices.length,
        points,
        cumulative,
        lengthMeters: cumulative[cumulative.length - 1],
        // Sorted so the runs of this shape can be walked in departure order.
        trips: Int32Array.from(
          tripIndices
            .filter((index) => state.tripStart[index] >= 0)
            .sort((a, b) => state.tripStart[a] - state.tripStart[b]),
        ),
        stops,
        bounds: boundsOf(points),
      };

      const existing = state.variantsByLine.get(trip.line);
      if (existing) existing.push(variant);
      else state.variantsByLine.set(trip.line, [variant]);
      state.variantByShapeId.set(shapeId, variant);
    }

    // Most used variant first — that is the one riders recognise as "the" route.
    for (const variants of state.variantsByLine.values()) {
      variants.sort((a, b) => b.tripCount - a.tripCount);
    }

    // Invert the same data once: stop -> lines. Built here rather than lazily
    // because the caller that needs it most asks for a hundred stops at a time.
    const linesByStop = new Map();
    for (const [line, variants] of state.variantsByLine) {
      for (const variant of variants) {
        for (const stop of variant.stops) {
          let lines = linesByStop.get(stop.id);
          if (!lines) {
            lines = new Set();
            linesByStop.set(stop.id, lines);
          }
          lines.add(line);
        }
      }
    }
    for (const [stopId, lines] of linesByStop) {
      state.linesByStopId.set(
        stopId,
        [...lines].sort((a, b) => a.localeCompare(b, 'pl', { numeric: true })),
      );
    }
  }

  hasLine(line) {
    return this.variantsByLine.has(line) || this.routesByLine.has(line);
  }

  getVariants(line) {
    return this.variantsByLine.get(line) ?? [];
  }

  /** The route variant running `shapeId`, or null. O(1). */
  getVariantByShapeId(shapeId) {
    return this.variantByShapeId.get(shapeId) ?? null;
  }

  /**
   * Pick the route variant a vehicle is most likely running, and say where on
   * it the vehicle sits.
   *
   * Proximity alone is not enough to answer this. The two directions of a line
   * run down the same street — sometimes the same rails — so the nearer
   * polyline is decided by a few metres of GPS noise, and half the time that
   * is the variant heading the other way. Where a heading is known it is
   * folded into the score (`HEADING_PENALTY_METERS`), which is what makes the
   * destination shown to a rider the one the vehicle is actually going to.
   *
   * @param {string} line
   * @param {number} lat
   * @param {number} lon
   * @param {{ heading?: number|null }} options
   * @returns {{ variant: object, projection: object|null } | null}
   */
  matchVariant(line, lat, lon, { heading = null } = {}) {
    const variants = this.getVariants(line);
    if (!variants.length) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { variant: variants[0], projection: null };
    }

    let best = variants[0];
    let bestProjection = null;
    let bestScore = Infinity;

    for (const variant of variants) {
      // Cheap rejection: a variant whose bounding box is already further away
      // than the current best cannot score better, since the heading term only
      // ever adds to the distance.
      if (variant.bounds) {
        const clampedLat = Math.min(Math.max(lat, variant.bounds.minLat), variant.bounds.maxLat);
        const clampedLon = Math.min(Math.max(lon, variant.bounds.minLon), variant.bounds.maxLon);
        if (distanceMeters(lat, lon, clampedLat, clampedLon) > bestScore) continue;
      }

      const projection = projectToPolyline(lat, lon, variant.points, {
        cumulative: variant.cumulative,
      });
      if (!projection) continue;

      let score = projection.distance;
      if (Number.isFinite(heading) && projection.bearing !== null) {
        // Full penalty for running backwards, none for agreeing, cosine in
        // between — a heading is a noisy quantity and a hard cutoff at 90°
        // flips the answer on a bend.
        const off = angleBetween(heading, projection.bearing);
        score += (HEADING_PENALTY_METERS * (1 - Math.cos((off * Math.PI) / 180))) / 2;
      }

      if (score < bestScore) {
        bestScore = score;
        bestProjection = projection;
        best = variant;
      }
    }

    return { variant: best, projection: bestProjection };
  }

  /**
   * The route variant a vehicle is most likely running.
   *
   * @param {string} line
   * @param {number} lat
   * @param {number} lon
   * @param {{ heading?: number|null }} [options]
   */
  getBestVariant(line, lat, lon, options) {
    return this.matchVariant(line, lat, lon, options)?.variant ?? null;
  }

  getStop(stopId) {
    return this.stopsById.get(stopId) ?? null;
  }

  /** One physical platform has one departure board. */
  getDeparturesForStop(stopId, options = {}) {
    return this.getDepartures(stopId, options);
  }

  getLinesForStop(stopId) {
    return this.linesByStopId.get(stopId) ?? [];
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

    // The lines are what make a list of nearby stops answerable — "is my tram
    // one of these?" — and the map cannot render a stop's identity without
    // them. Attached after the sort so only the stops actually returned pay
    // for the lookup, which is a Map hit each.
    return found
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map((stop) => ({ ...stop, lines: this.getLinesForStop(stop.id) }));
  }

  /** Case/diacritic-insensitive stop search, ranked by match quality. */
  searchStops(query, limit = 20) {
    const needle = normalizeSearchText(query);
    if (!needle) return [];

    // Every stop is examined — a few thousand entries is a cheap scan, and the
    // ranking below must not depend on where a stop sits in insertion order
    // (an early break on "enough matches" used to drop exact and prefix hits
    // that happened to be indexed late).
    const results = [];
    for (const entry of this.stopSearchIndex) {
      const rank = matchRank(entry.normalized, needle);
      if (rank === -1) continue;
      results.push({ stop: entry.stop, rank });
    }

    const ordered = results
      .sort((a, b) => {
        const nameOf = (entry) => entry.stop.name;
        return (
          a.rank - b.rank ||
          nameOf(a).length - nameOf(b).length ||
          nameOf(a).localeCompare(nameOf(b), 'pl') ||
          a.stop.id.localeCompare(b.stop.id)
        );
      })
      .map((entry) => entry.stop);

    // A GTFS producer can repeat a physical boarding point once per pattern.
    // Search should offer that pole once, but must never merge the two sides of
    // a street merely because they have the same passenger-facing name.
    const platforms = [];
    for (const stop of ordered) {
      const platform = platforms.find(
        (candidate) =>
          sameBoardingArea(candidate, stop),
      );
      if (!platform) {
        platforms.push({ ...stop, ids: [stop.id] });
        continue;
      }
      platform.ids.push(stop.id);
    }

    return platforms
      .slice(0, limit)
      .map((stop) => (stop.ids.length > 1 ? stop : (({ ids: _ids, ...platform }) => platform)(stop)));
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
  getDepartures(stopId, { limit = 20, now = new Date(), horizonSeconds = 86_400 } = {}) {
    const rows = this.departuresByStop.get(stopId);
    if (!rows || !rows.length) return [];

    const localNow = inWarsaw(now);
    const secondsNow =
      localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();

    const yesterday = new Date(localNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(localNow);
    tomorrow.setDate(tomorrow.getDate() + 1);

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
      // The board remains useful after the last evening service: tomorrow's
      // first departures are measured forward from the current service day.
      ...collect(lowerBound(0), tomorrow, -86_400, 'tomorrow'),
    ];

    return departures.sort((a, b) => a.inSeconds - b.inSeconds).slice(0, limit);
  }
}

module.exports = { GtfsStore, HEADING_PENALTY_METERS, SHAPE_SIMPLIFY_METERS, assertComplete, findEntry };
