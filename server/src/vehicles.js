'use strict';

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout, tryEachSource } = require('./http');
const { lineToType } = require('./lines');
const {
  fetchOpenDataVehicles,
  mergeFleet,
  normalizeOpenDataRecord,
} = require('./open-data');
const { describeVehicle, summarise } = require('./progress');
const { bearingDegrees, distanceMeters } = require('./gtfs/geo');

// Anything outside this box is a bad fix, not a vehicle in Wrocław.
const BOUNDS = { minLat: 50.8, maxLat: 51.4, minLon: 16.6, maxLon: 17.5 };

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
    this.timer = null;
    this.openDataTimer = null;
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
  }

  get snapshot() {
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
    return {
      locations: vehicles,
      count: vehicles.length,
      lastUpdated: this.status.lastSuccessAt,
      source: this.status.source,
      stale: this.status.consecutiveFailures > 0,
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
   * @returns {number} how many vehicles were placed
   */
  #describe() {
    if (!this.gtfs?.isReady) return 0;

    const now = new Date();
    let described = 0;

    for (const vehicle of this.fleet.values()) {
      try {
        // One stop ahead is all /locations carries; /vehicle/:id recomputes the
        // full list when someone actually taps a vehicle.
        vehicle.trip = summarise(describeVehicle(this.gtfs, vehicle, { now, limit: 1 }));
        if (vehicle.trip) described += 1;
      } catch (error) {
        vehicle.trip = null;
        logger.debug(`Could not place ${vehicle.id} on a route: ${error.message}`);
      }
    }

    return described;
  }

  /** Fetch the primary (MPK) source once and merge it into the fleet. */
  async poll() {
    const lines = this.getLines();
    if (!lines || (!lines.allBuses.length && !lines.allTrams.length)) return this.status;

    this.status.lastAttemptAt = new Date().toISOString();

    try {
      const { url, value: rows } = await tryEachSource(
        config.vehicles.sources,
        (candidate) => this.#request(candidate, lines),
        { label: 'vehicle position' },
      );

      const now = Date.now();
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

      // Drop vehicles that stopped reporting a while ago.
      const cutoff = now - config.vehicles.staleAfterMs * 2;
      for (const [id, vehicle] of this.mpkFleet) {
        if (vehicle.updatedAt < cutoff) this.mpkFleet.delete(id);
      }

      this.#merge();
      const described = this.#describe();

      this.status = {
        ...this.status,
        source: url,
        encoding: this.preferredEncoding,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        count: accepted,
        described,
      };

      if (accepted === 0) logger.warn('Vehicle poll returned rows but none were usable');
    } catch (error) {
      this.status.consecutiveFailures += 1;
      this.status.lastError = error.message;
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

    try {
      const rows = await fetchOpenDataVehicles(config.vehicles.openDataUrl, {
        timeoutMs: config.vehicles.openDataTimeoutMs,
      });

      const now = Date.now();
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

      // Drop records that stopped being refreshed a while ago.
      const cutoff = now - config.vehicles.staleAfterMs * 2;
      for (const [id, vehicle] of this.openDataFleet) {
        if (vehicle.updatedAt < cutoff) this.openDataFleet.delete(id);
      }

      this.#merge();

      this.openDataStatus = {
        ...this.openDataStatus,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        count: accepted,
      };

      //if (accepted === 0) logger.warn('Open Data poll returned rows but none were usable');
    } catch (error) {
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

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), config.vehicles.pollIntervalMs);
    this.timer.unref?.();

    // The Open Data source runs on its own timer and its own failure state, so
    // either source can go down without taking the fleet with it.
    if (config.vehicles.openDataUrl) {
      this.pollOpenData();
      this.openDataTimer = setInterval(
        () => this.pollOpenData(),
        config.vehicles.openDataPollIntervalMs,
      );
      this.openDataTimer.unref?.();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.openDataTimer) {
      clearInterval(this.openDataTimer);
      this.openDataTimer = null;
    }
  }
}

module.exports = { VehicleTracker, normalizeVehicle, bearing, BOUNDS };
