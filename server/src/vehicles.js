'use strict';

const { performance } = require('node:perf_hooks');

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout, tryEachSource, SourceHealth } = require('./http');
const { lineToType } = require('./lines');
const { Metric } = require('./metrics');
const {
  fetchOpenDataVehicles,
  mergeFleet,
  normalizeOpenDataRecord,
} = require('./open-data');
const { describeVehicle, summarise } = require('./progress');
const { bearingDegrees, distanceMeters } = require('./gtfs/geo');

// Anything outside this box is a bad fix, not a vehicle in Wrocław.
const BOUNDS = { minLat: 50.8, maxLat: 51.4, minLon: 16.6, maxLon: 17.5 };

// How long a route projection is trusted for a vehicle that has not moved,
// and how far it may drift between polls before it is projected again. A bus
// sitting at a terminus has the same route geometry every poll; re-projecting
// it every ten seconds buys nothing, so only a vehicle that actually moved (or
// one that has idled past the cap) pays for the geometry pass.
const DESCRIBE_MAX_AGE_MS = 30_000;
const DESCRIBE_STATIONARY_METERS = 15;

const inBounds = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= BOUNDS.minLat &&
  lat <= BOUNDS.maxLat &&
  lon >= BOUNDS.minLon &&
  lon <= BOUNDS.maxLon;

const FIELD_ALIASES = {
  lat: ['x', 'lat', 'latitude', 'szerokosc', 'y_wgs84'],
  lon: ['y', 'lon', 'lng', 'longitude', 'dlugosc', 'x_wgs84'],
  line: ['name', 'line', 'linia', 'route', 'route_short_name', 'nazwa_linii'],
  id: ['k', 'id', 'vehicle_id', 'nr_boczny', 'brigade'],
};

/**
 * Ways to ask `bus_position` for a set of lines.
 *
 * Community projects document two different encodings — the typed
 * `busList[bus][]` / `busList[tram][]` form and the flat `busList[][]` form —
 * and it is not clear which one MPK will keep. Rather than betting on one, the
 * tracker tries each in turn and then sticks to whichever answered.
 */
const BODY_ENCODINGS = [
  {
    name: 'typed',
    build: (lines) => {
      const body = new URLSearchParams();
      for (const line of lines.allBuses) body.append('busList[bus][]', line);
      for (const line of lines.allTrams) body.append('busList[tram][]', line);
      return body;
    },
  },
  {
    name: 'flat',
    build: (lines) => {
      const body = new URLSearchParams();
      for (const line of [...lines.allTrams, ...lines.allBuses]) body.append('busList[][]', line);
      return body;
    },
  },
];

const pick = (row, aliases) => {
  for (const key of aliases) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
};

/**
 * Normalise one upstream record.
 *
 * MPK's `bus_position` returns `{ x, y, name, k, type }` where `x` is latitude.
 * Field names have changed before, so aliases are accepted rather than assuming
 * one exact shape.
 */
const normalizeVehicle = (row) => {
  if (!row || typeof row !== 'object') return null;

  const lat = Number.parseFloat(pick(row, FIELD_ALIASES.lat));
  const lon = Number.parseFloat(pick(row, FIELD_ALIASES.lon));
  if (!inBounds(lat, lon)) return null;

  // MPK reports express lines ("A", "K", "N") in lowercase, while the GTFS
  // timetable carries them uppercase. The live name has to match the
  // timetable's `route_short_name` byte for byte — the /locations line
  // filter, the route matcher and the app's line picker all compare exact
  // values, so a lowercase letter bus would be invisible everywhere.
  const line = String(pick(row, FIELD_ALIASES.line) ?? '').trim().toUpperCase();
  if (!line) return null;

  const rawId = pick(row, FIELD_ALIASES.id);

  // The line number gives the finer category (night, express, suburban…), but
  // fall back to whatever the upstream record says for labels we do not know.
  let type = lineToType(line);
  if (type === 'unknown' && (row.type === 'tram' || row.type === 'bus')) type = row.type;

  return {
    id: rawId !== undefined ? `${line}-${rawId}` : `${line}-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    line,
    type,
    lat,
    lon,
  };
};

/**
 * Compass bearing in degrees from one position to the next.
 *
 * The maths moved to `gtfs/geo` when the route matcher started needing it too —
 * it compares this heading against the bearing of the route it is matching.
 * Re-exported under the old name so the tracker's API is unchanged.
 */
const bearing = bearingDegrees;

/**
 * Polls the live vehicle-position endpoints and keeps the last known fleet
 * state, enriched with heading and, when a timetable is available, with where
 * each vehicle is headed and which stops it reaches when. MPK's `bus_position`
 * is the primary source; the city's Open Data table is polled on its own timer
 * and merged in (see src/open-data.js), so neither source can take the fleet
 * down with it. Never throws at the caller: a failed poll keeps the previous
 * snapshot and is reported through `status` / `openDataStatus`.
 *
 * The timetable match runs once per poll, here, rather than per request:
 * /locations is polled by every open app every ten seconds, and projecting
 * several hundred vehicles onto their route geometry on each of those would be
 * the same work done over and over for an answer that only changes when a new
 * position arrives.
 */
class VehicleTracker {
  /**
   * @param {() => object} getLines
   * @param {{ gtfs?: import('./gtfs/store').GtfsStore }} [services]
   *   The store is optional: without it the tracker still serves positions,
   *   just with no direction or stop information attached.
   */
  constructor(getLines, { gtfs = null } = {}) {
    this.getLines = getLines;
    this.gtfs = gtfs;
    /** @type {Map<string, object>} MPK vehicle id -> last known state */
    this.mpkFleet = new Map();
    /** @type {Map<string, object>} `open-data:<number>` -> last known state */
    this.openDataFleet = new Map();
    /** Combined view: what /locations actually serves, rebuilt after every poll. */
    this.fleet = new Map();
    /** id -> entry in the current `snapshot.locations`, so /vehicle/:id is O(1). */
    this.byId = new Map();
    /** Memoized snapshot: what the `snapshot` getter returns between polls. */
    this._snapshot = { locations: [], count: 0, lastUpdated: null, source: null, stale: false };
    /** Monotonic counter bumped on every accepted poll (success or failure). Used by the vehicle-detail cache and internal freshness checks. */
    this.pollRevision = 0;
    /**
     * Map revision: bumps only when something visible in `/locations?format=map`
     * changes — vehicle positions, headings, trip info, source/stale state.
     * A quiet poll that observed identical positions keeps the same value, so
     * the map-format body cache and ETag stay valid and the client gets 304.
     * `updatedAt`/`lastUpdated` are freshness timestamps, not map content, and
     * are deliberately excluded — the map format does not carry per-vehicle
     * updatedAt, and its cached body freezes lastUpdated at the last content
     * change rather than re-downloading every ten seconds.
     */
    this.mapRevision = 0;
    /**
     * Full revision: bumps whenever anything visible in the full `/locations`
     * response changes — the same fields as mapRevision, plus `lastUpdated`
     * (which the full format serializes) and per-vehicle `updatedAt`. A quiet
     * poll advances `fullRevision` even when `mapRevision` does not, because
     * lastUpdated ticks on every successful poll.
     */
    this.fullRevision = 0;
    /** vehicle id -> { lat, lon, heading, at, trip } of the last projection, so stationary vehicles skip re-projection. */
    this.describeCache = new Map();
    this.timer = null;
    this.openDataTimer = null;
    /** True once stop() has run, so an in-flight poll never re-arms its loop. */
    this._stopped = true;
    /** Per-URL health of the position endpoints (see http.SourceHealth). */
    this.sourceHealth = new SourceHealth(config.vehicles.sources);
    /** Body encoding that last worked; tried first on the next poll. */
    this.preferredEncoding = null;
    this.status = {
      source: null,
      encoding: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailures: 0,
      count: 0,
      // How many of them the timetable could place on a route. A number well
      // below `count` means the feed and the shapes disagree — a stale
      // snapshot, or lines running a diversion.
      described: 0,
      /** Per-URL health snapshot, for /health. */
      sources: [],
    };
    this.openDataStatus = {
      source: config.vehicles.openDataUrl,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      consecutiveFailures: 0,
      count: 0,
    };
    this.stats = { mpk: 0, merged: 0, openData: 0, total: 0, activeLines: 0 };
    /**
     * Rolling per-poll timings and counts. Each field is a bounded Metric
     * (latest / EWMA / max / count), so nothing here grows with uptime.
     */
    this.performance = {
      totalPollMs: new Metric(),
      fetchMs: new Metric(),
      normalizationMs: new Metric(),
      openDataMergeMs: new Metric(),
      descriptionMs: new Metric(),
      snapshotBuildMs: new Metric(),
      incomingVehicleCount: new Metric(),
      acceptedVehicleCount: new Metric(),
      descriptionsReused: new Metric(),
      descriptionsRecomputed: new Metric(),
    };
    /**
     * Separate rolling metrics for the Open Data poll cycle, so its timings are
     * visible independently of the MPK primary source. Same bounded Metric
     * shape — O(1) memory, no history arrays.
     */
    this.openDataPerformance = {
      totalPollMs: new Metric(),
      fetchMs: new Metric(),
      normalizationMs: new Metric(),
      mergeMs: new Metric(),
      descriptionMs: new Metric(),
      snapshotBuildMs: new Metric(),
      incomingVehicleCount: new Metric(),
      acceptedVehicleCount: new Metric(),
      descriptionsReused: new Metric(),
      descriptionsRecomputed: new Metric(),
    };
  }

  /** Rolling metrics as a flat object, for /health. */
  performanceSnapshot() {
    return Object.fromEntries(
      Object.entries(this.performance).map(([name, metric]) => [name, metric.snapshot()]),
    );
  }

  /** Rolling Open Data poll metrics as a flat object, for /health. */
  openDataPerformanceSnapshot() {
    return Object.fromEntries(
      Object.entries(this.openDataPerformance).map(([name, metric]) => [name, metric.snapshot()]),
    );
  }

  get snapshot() {
    return this._snapshot;
  }

  /**
   * One vehicle from the current snapshot, or null. O(1).
   *
   * /vehicle/:id used to scan `snapshot.locations` for every request; with
   * every open app tapping vehicles the scan was a small per-request tax that
   * only grows with the fleet. The id map is rebuilt alongside the snapshot.
   */
  getVehicle(id) {
    return this.byId.get(id) ?? null;
  }

  /** Rebuild the memoized snapshot from the current fleet, once per poll.
   *
   * @param {{ source: string|null, stale: boolean }} meta — explicit snapshot
   *   metadata, read from the *already-updated* `status`. Passing it in (rather
   *   than reading `this.status` implicitly) makes the ordering a non-issue:
   *   status is finalised by the caller before the snapshot reads it.
   */
  #rebuildSnapshot({ source, stale }) {
    const cutoff = Date.now() - config.vehicles.staleAfterMs;
    const vehicles = [];
    for (const vehicle of this.fleet.values()) {
      if (vehicle.updatedAt < cutoff) continue;
      vehicles.push({
        id: vehicle.id,
        line: vehicle.line,
        type: vehicle.type,
        lat: vehicle.lat,
        lon: vehicle.lon,
        heading: vehicle.heading,
        trip: vehicle.trip ?? null,
        updatedAt: new Date(vehicle.updatedAt).toISOString(),
        // Optional fields from the merge. MPK-only vehicles carry `source:
        // "mpk"`; a vehicle paired with an Open Data record carries the
        // vehicle number, brigade and the timestamp of the position that
        // supplied them.
        source: vehicle.source,
        ...(vehicle.vehicleNumber !== undefined
          ? { vehicleNumber: vehicle.vehicleNumber }
          : {}),
        ...(vehicle.brigade !== undefined ? { brigade: vehicle.brigade } : {}),
        ...(vehicle.positionUpdatedAt !== undefined
          ? { positionUpdatedAt: vehicle.positionUpdatedAt }
          : {}),
      });
    }

    // True when anything visible in /locations changed since the last snapshot.
    // `updatedAt` (per-vehicle) and `lastUpdated` (snapshot-level) are freshness
    // timestamps, not positional content, so they are excluded from this check —
    // a quiet poll that observed the same positions must not advance mapRevision,
    // which is what keeps `/locations?format=map` answering 304.
    let contentChanged = this._snapshot.locations.length !== vehicles.length;
    for (let i = 0; contentChanged === false && i < vehicles.length; i += 1) {
      const prev = this._snapshot.locations[i];
      const next = vehicles[i];
      contentChanged =
        prev.id !== next.id ||
        prev.line !== next.line ||
        prev.type !== next.type ||
        prev.lat !== next.lat ||
        prev.lon !== next.lon ||
        prev.heading !== next.heading ||
        prev.source !== next.source ||
        prev.vehicleNumber !== next.vehicleNumber ||
        prev.brigade !== next.brigade ||
        prev.positionUpdatedAt !== next.positionUpdatedAt ||
        JSON.stringify(prev.trip) !== JSON.stringify(next.trip);
    }

    // Source and stale are snapshot metadata visible in /locations; a change
    // in either is content-visible even when every vehicle is identical.
    contentChanged =
      contentChanged ||
      this._snapshot.source !== source ||
      this._snapshot.stale !== stale;

    // The O(1) id lookup /vehicle/:id uses. Built here from the same filtered
    // list the snapshot serves, so it never answers for a stale vehicle.
    this.byId = new Map(vehicles.map((entry) => [entry.id, entry]));

    this.pollRevision += 1;
    // A quiet poll (identical positions) still advances lastUpdated, which the
    // full format carries — so fullRevision always ticks on a successful
    // rebuild. mapRevision only ticks on a positional/metadata content change.
    this.fullRevision += 1;
    if (contentChanged) this.mapRevision += 1;

    this._snapshot = {
      locations: vehicles,
      count: vehicles.length,
      // Always advance on a successful poll: the full /locations format
      // serializes lastUpdated, so a quiet poll must still produce a fresh
      // full body and ETag. The map format's body cache is keyed on
      // mapRevision (not fullRevision), so it still answers 304 here.
      lastUpdated: new Date().toISOString(),
      source,
      stale,
    };
  }

  /** One request with one body encoding. Throws when the answer is unusable. */
  async #requestWith(url, lines, encoding) {
    const body = encoding.build(lines);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      timeoutMs: config.vehicles.timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON, got ${text.slice(0, 60).replace(/\s+/g, ' ')}…`);
    }

    // Accept both a bare array and a wrapper object, since the endpoint has
    // returned both shapes over its lifetime.
    const rows = Array.isArray(payload)
      ? payload
      : payload.vehicles ?? payload.data ?? payload.locations ?? null;
    if (!Array.isArray(rows)) throw new Error('response did not contain a list of vehicles');
    // An empty list is how this endpoint reports "I did not understand your
    // body", so it has to count as a failure and let the next encoding try.
    if (!rows.length) throw new Error('response contained no vehicles');

    return rows;
  }

  /**
   * Ask one URL for positions, trying each body encoding until one answers.
   * The encoding that worked is remembered and tried first next time.
   */
  async #request(url, lines) {
    const ordered = this.preferredEncoding
      ? [
          ...BODY_ENCODINGS.filter((encoding) => encoding.name === this.preferredEncoding),
          ...BODY_ENCODINGS.filter((encoding) => encoding.name !== this.preferredEncoding),
        ]
      : BODY_ENCODINGS;

    const errors = [];
    for (const encoding of ordered) {
      try {
        const rows = await this.#requestWith(url, lines, encoding);
        if (this.preferredEncoding !== encoding.name) {
          logger.info(`Vehicle endpoint accepted the "${encoding.name}" body encoding`);
          this.preferredEncoding = encoding.name;
        }
        return rows;
      } catch (error) {
        errors.push(`${encoding.name}: ${error.message}`);
      }
    }

    throw new Error(errors.join('; '));
  }

  /**
   * Attach the timetable view — destination, delay, next stop — to every
   * vehicle in the fleet.
   *
   * A vehicle the timetable cannot place keeps a null `trip` rather than the
   * one from its previous position: a stale destination on a moving vehicle is
   * worse than none, because nothing on screen says it is out of date.
   *
   * @returns {{ described: number, reused: number, recomputed: number }}
   *   `described` counts placed vehicles, `reused` those served from the
   *   describe cache, `recomputed` those projected again this pass.
   */
  #describe() {
    if (!this.gtfs?.isReady) return { described: 0, reused: 0, recomputed: 0 };

    const now = new Date();
    const nowMs = Date.now();
    let described = 0;
    let reused = 0;
    let recomputed = 0;

    for (const vehicle of this.fleet.values()) {
      const previous = this.describeCache.get(vehicle.id);
      const stationary =
        previous != null &&
        nowMs - previous.at < DESCRIBE_MAX_AGE_MS &&
        vehicle.heading === previous.heading &&
        distanceMeters(previous.lat, previous.lon, vehicle.lat, vehicle.lon) <=
          DESCRIBE_STATIONARY_METERS;

      if (stationary) {
        // Same spot, same heading, not long since the last projection: the
        // trip an idling bus is on does not change just because the clock
        // moved a few seconds. Reuse the match instead of re-projecting it.
        vehicle.trip = previous.trip ?? null;
        if (vehicle.trip) described += 1;
        reused += 1;
        continue;
      }

      recomputed += 1;
      try {
        // One stop ahead is all /locations carries; /vehicle/:id recomputes the
        // full list when someone actually taps a vehicle. `previous?.state` is
        // the projection from the last time this vehicle was described, which
        // lets the matcher skip the full scan and only re-project around where
        // the vehicle was (a stationary vehicle never gets here).
        const result = describeVehicle(this.gtfs, vehicle, {
          now,
          limit: 1,
          previousState: previous?.state ?? null,
        });
        vehicle.trip = summarise(result);
        if (vehicle.trip) described += 1;
        this.describeCache.set(vehicle.id, {
          lat: vehicle.lat,
          lon: vehicle.lon,
          heading: vehicle.heading ?? null,
          at: nowMs,
          trip: vehicle.trip,
          // Seeded by the projection the next poll's fast path needs; undefined
          // (and so a full match next time) when this position was off route.
          state: result?.state ?? null,
        });
      } catch (error) {
        vehicle.trip = null;
        this.describeCache.delete(vehicle.id);
        logger.debug(`Could not place ${vehicle.id} on a route: ${error.message}`);
      }
    }

    // The cache is only useful while the vehicle is still on the map; a
    // vehicle that stopped reporting should be forgotten, not re-armed later.
    for (const id of this.describeCache.keys()) {
      if (!this.fleet.has(id)) this.describeCache.delete(id);
    }

    return { described, reused, recomputed };
  }

  /** Fetch the primary (MPK) source once and merge it into the fleet. */
  async poll() {
    const lines = this.getLines();
    if (!lines || (!lines.allBuses.length && !lines.allTrams.length)) {
      return this.status;
    }

    this.status.lastAttemptAt = new Date().toISOString();
    const pollStart = performance.now();
    const perf = this.performance;

    try {
      const fetchStart = performance.now();
      const { url, value: rows } = await tryEachSource(
        this.sourceHealth.plan(),
        (candidate) => this.#request(candidate, lines),
        {
          label: 'vehicle position',
          onResult: ({ url: attemptedUrl, ok, error }) => {
            if (ok) this.sourceHealth.recordSuccess(attemptedUrl);
            else this.sourceHealth.recordFailure(attemptedUrl, error);
          },
        },
      );
      perf.fetchMs.record(performance.now() - fetchStart);
      perf.incomingVehicleCount.record(rows.length);

      const now = Date.now();
      const normalizeStart = performance.now();
      let accepted = 0;

      for (const row of rows) {
        const vehicle = normalizeVehicle(row);
        if (!vehicle) continue;
        accepted += 1;

        const previous = this.mpkFleet.get(vehicle.id);
        let heading = previous?.heading ?? null;
        if (previous && distanceMeters(previous.lat, previous.lon, vehicle.lat, vehicle.lon) > 15) {
          heading = Math.round(bearing(previous.lat, previous.lon, vehicle.lat, vehicle.lon));
        }

        vehicle.vehicleNumber = vehicle.vehicleNumber?.toUpperCase?.();

        this.mpkFleet.set(vehicle.id, { ...vehicle, heading, updatedAt: now });
      }
      perf.normalizationMs.record(performance.now() - normalizeStart);
      perf.acceptedVehicleCount.record(accepted);

      // Drop vehicles that stopped reporting a while ago.
      const cutoff = now - config.vehicles.staleAfterMs * 2;
      for (const [id, vehicle] of this.mpkFleet) {
        if (vehicle.updatedAt < cutoff) this.mpkFleet.delete(id);
      }

      const mergeStart = performance.now();
      this.#merge();
      perf.openDataMergeMs.record(performance.now() - mergeStart);

      const describeStart = performance.now();
      const { described, reused, recomputed } = this.#describe();
      perf.descriptionMs.record(performance.now() - describeStart);
      perf.descriptionsReused.record(reused);
      perf.descriptionsRecomputed.record(recomputed);

      perf.totalPollMs.record(performance.now() - pollStart);

      // Finalise status BEFORE rebuilding the snapshot. The snapshot reads
      // `source` and `stale` from the arguments below (not from `this.status`),
      // so there is no one-poll lag between "the poll succeeded" and the public
      // snapshot reflecting it.
      this.status = {
        ...this.status,
        source: url,
        encoding: this.preferredEncoding,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        count: accepted,
        described,
        sources: this.sourceHealth.snapshot(),
      };

      const snapshotStart = performance.now();
      this.#rebuildSnapshot({ source: url, stale: false });
      perf.snapshotBuildMs.record(performance.now() - snapshotStart);

      if (accepted === 0) logger.warn('Vehicle poll returned rows but none were usable');
    } catch (error) {
      perf.totalPollMs.record(performance.now() - pollStart);
      const wasStale = this._snapshot.stale;
      this.status.consecutiveFailures += 1;
      this.status.lastError = error.message;
      // A failed poll keeps the last good fleet but is a change of state all
      // the same: the snapshot must say it is stale and the /locations body
      // cache must not keep serving a "fresh" answer.
      this._snapshot = { ...this._snapshot, stale: true };
      this.pollRevision += 1;
      if (!wasStale) {
        this.mapRevision += 1;
        this.fullRevision += 1;
      }
      this.status.sources = this.sourceHealth.snapshot();
      // Only shout about it once it is clearly not a blip.
      const log = this.status.consecutiveFailures === 1 ? logger.debug : logger.warn;
      log(`Vehicle poll failed (${this.status.consecutiveFailures}x): ${error.message}`);
    }

    return this.status;
  }

  /**
   * Fetch the supplementary (Open Data) source once and merge it into the
   * fleet. Runs on its own timer so one source going down never stops the
   * other; a failed poll keeps the last good records and is reported through
   * `openDataStatus`.
   */
  async pollOpenData() {
    this.openDataStatus.lastAttemptAt = new Date().toISOString();

    const pollStart = performance.now();
    const perf = this.openDataPerformance;

    try {
      const fetchStart = performance.now();
      const rows = await fetchOpenDataVehicles(config.vehicles.openDataUrl, {
        timeoutMs: config.vehicles.openDataTimeoutMs,
      });
      perf.fetchMs.record(performance.now() - fetchStart);
      perf.incomingVehicleCount.record(rows.length);

      const now = Date.now();
      const normalizeStart = performance.now();
      let accepted = 0;

      for (const row of rows) {
        const vehicle = normalizeOpenDataRecord(row, {
          now,
          maxAgeMs: config.vehicles.openDataMaxAgeMs,
        });
        if (!vehicle) continue;
        accepted += 1;
        this.openDataFleet.set(vehicle.id, { ...vehicle, updatedAt: now });
      }
      perf.normalizationMs.record(performance.now() - normalizeStart);
      perf.acceptedVehicleCount.record(accepted);

      // Drop records that stopped being refreshed a while ago.
      const cutoff = now - config.vehicles.staleAfterMs * 2;
      for (const [id, vehicle] of this.openDataFleet) {
        if (vehicle.updatedAt < cutoff) this.openDataFleet.delete(id);
      }

      const mergeStart = performance.now();
      this.#merge();
      perf.mergeMs.record(performance.now() - mergeStart);

      const describeStart = performance.now();
      const { reused, recomputed } = this.#describe();
      perf.descriptionMs.record(performance.now() - describeStart);
      perf.descriptionsReused.record(reused);
      perf.descriptionsRecomputed.record(recomputed);

      const snapshotStart = performance.now();
      // Open Data is a supplementary poll: it does not change the MPK source or
      // the MPK stale flag. Pass the current MPK status explicitly so the
      // snapshot metadata is correct without reading mutable state inside the
      // rebuild.
      this.#rebuildSnapshot({
        source: this.status.source,
        stale: this.status.consecutiveFailures > 0,
      });
      perf.snapshotBuildMs.record(performance.now() - snapshotStart);

      perf.totalPollMs.record(performance.now() - pollStart);

      this.openDataStatus = {
        ...this.openDataStatus,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        count: accepted,
      };

      //if (accepted === 0) logger.warn('Open Data poll returned rows but none were usable');
    } catch (error) {
      // The total duration is always recorded so a slow upstream shows up in
      // /health even when every stage after it was skipped. Stage timings that
      // never ran stay at their previous value — a failed fetch does not pretend
      // merge or describe work happened.
      perf.totalPollMs.record(performance.now() - pollStart);
      this.openDataStatus.consecutiveFailures += 1;
      this.openDataStatus.lastError = error.message;
      const log = this.openDataStatus.consecutiveFailures === 1 ? logger.debug : logger.warn;
      log(`Open Data poll failed (${this.openDataStatus.consecutiveFailures}x): ${error.message}`);
    }

    return this.openDataStatus;
  }

  /** Rebuild the combined fleet after either source has been polled. */
  #merge() {
    const { fleet, stats } = mergeFleet(this.mpkFleet, this.openDataFleet, {
      matchMaxMeters: config.vehicles.matchMaxMeters,
      dedupeMeters: config.vehicles.dedupeMeters,
      ambiguityMeters: config.vehicles.ambiguityMeters,
    });
    this.fleet = fleet;
    this.stats = stats;
  }

  /**
   * Re-arm the MPK poll for `intervalMs` from now. Deliberately not a
   * setInterval: the next poll is scheduled from the *end* of the previous one,
   * so a slow response can never pile a second poll on top of one still running
   * (a setInterval would, and two concurrent polls would double every merge and
   * race on the describe cache).
   */
  #scheduleNextPoll() {
    if (this._stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#runPollLoop(), config.vehicles.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Re-arm the Open Data poll, same non-overlapping discipline as #scheduleNextPoll. */
  #scheduleNextOpenDataPoll() {
    if (this._stopped) return;
    if (this.openDataTimer) clearTimeout(this.openDataTimer);
    this.openDataTimer = setTimeout(
      () => this.#runOpenDataPollLoop(),
      config.vehicles.openDataPollIntervalMs,
    );
    this.openDataTimer.unref?.();
  }

  /**
   * One iteration of the MPK poll loop: run a poll, then arm the next from its
   * completion. This is the sole owner that can enqueue an MPK timer — poll()
   * no longer self-schedules and start() only calls here — so a double start()
   * or a stop() racing an in-flight poll can never stack timers. A throw from
   * poll() is logged but rescheduled, so one bad poll cannot drop the live fleet.
   */
  async #runPollLoop() {
    try {
      await this.poll();
    } catch (error) {
      logger.error(`MPK poll threw, rescheduling: ${error.message}`);
    } finally {
      this.#scheduleNextPoll();
    }
  }

  /** One iteration of the Open Data poll loop — sole armer of its timer. */
  async #runOpenDataPollLoop() {
    try {
      await this.pollOpenData();
    } catch (error) {
      logger.error(`Open Data poll threw, rescheduling: ${error.message}`);
    } finally {
      this.#scheduleNextOpenDataPoll();
    }
  }

  start() {
    if (this.timer) return;
    this._stopped = false;

    // First poll immediately. A placeholder handle keeps `timer` non-null from
    // the first instant — stop() and callers that inspect the timers rely on
    // it — and is replaced by the real arm the moment the first poll settles.
    // The next arm is queued from the *end* of each #runPollLoop, which is the
    // only code that schedules an MPK timer, so even the first tick can never
    // overlap the poll that preceded it.
    this.timer = setTimeout(() => {}, 0);
    this.timer.unref?.();
    void this.#runPollLoop();

    // The Open Data source runs on its own timer and its own failure state, so
    // either source can go down without taking the fleet with it.
    if (config.vehicles.openDataUrl) {
      this.openDataTimer = setTimeout(() => {}, 0);
      this.openDataTimer.unref?.();
      void this.#runOpenDataPollLoop();
    }
  }

  stop() {
    this._stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.openDataTimer) {
      clearTimeout(this.openDataTimer);
      this.openDataTimer = null;
    }
  }
}

module.exports = { VehicleTracker, normalizeVehicle, bearing, BOUNDS };
