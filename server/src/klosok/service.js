'use strict';

const config = require('../config');
const logger = require('../logger');
const { distanceMeters } = require('../gtfs/geo');
const { lineToType } = require('../lines');
const { fetchKlosokFeed } = require('./fetch');
const { parseRealtime, resolveEnrichment } = require('./realtime');

const OPERATOR = 'PT KŁOSOK';

// How far apart a Kłosok bus and a same-line Wrocław bus can be and still be
// read as the same vehicle by position. Same threshold used when a fresh
// Open Data record with no identifier match sits near an MPK vehicle.
const DEDUPE_METERS = config.klosok.dedupeMeters;
// Positional dedup only happens when the two timestamps are plausibly the
// same moment; a 2-minute skew is well inside both providers' poll rates.
const MAX_TIMESTAMP_SKEW_MS = 120_000;

/** Is `when` recent enough that this vehicle is still being served? */
const isFresh = (positionUpdatedAt, nowMs) => {
  const timestamp = Date.parse(positionUpdatedAt ?? '');
  return Number.isFinite(timestamp) && nowMs - timestamp <= config.klosok.maxAgeMs;
};

/** Wall-clock recency shared by a Kłosok fix and a Wrocław one. */
const similarTimestamp = (w, kv) => {
  const t1 = Date.parse(w.positionUpdatedAt ?? w.updatedAt ?? '');
  const t2 = Date.parse(kv.positionUpdatedAt ?? '');
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return true; // unknown — don't block
  return Math.abs(t1 - t2) <= MAX_TIMESTAMP_SKEW_MS;
};

/**
 * PT KŁOSOK as a live-position provider only.
 *
 * Kłosok publishes no timetable — its buses are matched against the Wrocław
 * GTFS (`GtfsStore`) by trip id, route id, then vehicle/brigade, and its one
 * GTFS-RT poll supplies positions and delays. It is deliberately NOT a
 * VehicleTracker: MPK's tracker is Wrocław-only and its matching heuristics
 * assume MPK's `{line, lat, lon}` feed. This service fails soft — an outage
 * never crashes the server, never blocks MPK/Open Data, and never makes
 * /health unhealthy while Wrocław works.
 *
 * Merging: a fresh Kłosok position outranks the Wrocław sources for the same
 * physical bus (1. Kłosok GTFS-RT, 2. Open Data, 3. MPK `bus_position`), so
 * `mergeLocations()` drops a Wrocław vehicle that a Kłosok one is clearly the
 * same as — exact vehicle number, trip id, brigade, or else a same-line
 * same-type position within a few hundred metres at a similar time. Different
 * lines are never merged just because they are near each other.
 */
class KlosokService {
  /**
   * @param {{ gtfs?: import('../gtfs/store').GtfsStore, getWroclawLocations?: () => object[] }} services
   *   `getWroclawLocations` yields the MPK+Open Data fleet (`/locations`'s
   *   Wrocław half) so Kłosok positions can be deduplicated against it.
   */
  constructor({ gtfs = null, getWroclawLocations = () => [] } = {}) {
    this.gtfs = gtfs;
    this.getWroclawLocations = getWroclawLocations;
    this.snapshot = { locations: [], count: 0, lastUpdated: null, stale: false, source: 'klosok-gtfs-rt' };
    /** Monotonic counter bumped on every poll that replaced the snapshot. */
    this.revision = 0;
    /**
     * Content revision: bumps only when /locations-visible state in the Kłosok
     * snapshot changes (vehicles added/removed, positions, headings, delays,
     * stale/live state). Drives the combined-fleet key in /locations.
     */
    this.snapshotRevision = 0;
    /** @type {Map<string, object>} last parsed trip updates, startDate|tripId -> update */
    this.tripUpdates = new Map();
    this.timer = null;
    this.started = false;
    this.status = {
      enabled: config.klosok.enabled,
      state: config.klosok.enabled && config.klosok.gtfsRtUrl ? 'idle' : 'disabled',
      endpoint: config.klosok.gtfsRtUrl || null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      feedTimestamp: null,
      entities: 0,
      vehiclePositions: 0,
      tripUpdates: 0,
      freshPositions: 0,
      matchedByTripId: 0,
      matchedByRouteId: 0,
      matchedByVehicleOrBrigade: 0,
      unmatched: 0,
      finalVehiclesAdded: 0,
      dedupDroppedWroclaw: 0,
    };
  }

  get enabled() {
    return Boolean(this.status.enabled && this.status.endpoint);
  }

  /** Fresh Kłosok positions only — a bus stops being served once its fix ages out. */
  #freshLocations(nowMs = Date.now()) {
    return this.snapshot.locations.filter((vehicle) => isFresh(vehicle.positionUpdatedAt, nowMs));
  }

  /** Load the timetable, then start the periodic RT poll. */
  async start() {
    if (this.started) return;
    this.started = true;

    if (!config.klosok.enabled || !config.klosok.gtfsRtUrl) {
      logger.info('Kłosok disabled — set KLOSOK_ENABLED=true to enable');
      return;
    }

    await this.poll().catch((error) => logger.error(`Kłosok first poll failed: ${error.message}`));
    this.timer = setInterval(() => this.poll().catch(() => {}), config.klosok.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the poll timer. Anything scheduled must be stoppable (CLAUDE.md). */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** One GTFS-RT poll: fetch, decode, match against the Wrocław GTFS, hold the snapshot. */
  async poll() {
    if (!config.klosok.enabled || !config.klosok.gtfsRtUrl) return this.status;

    this.status.lastAttemptAt = new Date().toISOString();
    try {
      const response = await fetchKlosokFeed(config.klosok.gtfsRtUrl);
      if (!response.ok) throw new Error(`Kłosok GTFS-RT responded HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const now = new Date();
      const parsed = parseRealtime(buffer, { now });

      this.tripUpdates = parsed.tripUpdates;
      const enriched = [];
      const counters = { matchedByTripId: 0, matchedByRouteId: 0, matchedByVehicleOrBrigade: 0, unmatched: 0 };

      for (const vehicle of parsed.vehicles) {
        // Matching needs the timetable; until the Wrocław feed has loaded, a
        // position cannot be named and is not served.
        const enrichment = this.gtfs?.isReady ? resolveEnrichment(this.gtfs, vehicle, { now }) : null;
        if (!enrichment) {
          counters.unmatched += 1;
          continue;
        }
        if (enrichment.how === 'tripId') counters.matchedByTripId += 1;
        else if (enrichment.how === 'routeId') counters.matchedByRouteId += 1;
        else counters.matchedByVehicleOrBrigade += 1;

        enriched.push(this.#enrich(vehicle, enrichment));
      }

      // Dedup against the current Wrocław fleet so /health's numbers match
      // what /locations would actually serve right now.
      const { added, dropped } = this.#dedupCounts(enriched);

      // Detect whether anything /locations-visible changed: vehicle count,
      // stale/live state, or per-vehicle position/heading/timestamp/delay.
      // `updatedAt` is a freshness timestamp, not content, so it is excluded.
      const changed = this.#snapshotChanged(this.snapshot, enriched, parsed.stale);

      this.snapshot = {
        locations: enriched,
        count: enriched.length,
        lastUpdated: now.toISOString(),
        stale: parsed.stale,
        source: 'klosok-gtfs-rt',
      };
      this.revision += 1;
      if (changed) this.snapshotRevision += 1;
      this.status = {
        ...this.status,
        state: 'ready',
        endpoint: config.klosok.gtfsRtUrl,
        lastSuccessAt: now.toISOString(),
        lastError: null,
        feedTimestamp: parsed.headerTimestamp !== null ? new Date(parsed.headerTimestamp * 1000).toISOString() : null,
        entities: parsed.stats.entities,
        vehiclePositions: parsed.stats.vehiclePositions,
        tripUpdates: parsed.tripUpdates.size,
        freshPositions: parsed.stats.freshPositions,
        ...counters,
        finalVehiclesAdded: added,
        dedupDroppedWroclaw: dropped,
      };
      logger.info(
        `Kłosok GTFS-RT: ${enriched.length} buses served (${counters.unmatched} unmatched) from ` +
          `${parsed.stats.freshPositions} fresh positions`,
      );
    } catch (error) {
      // Fail soft: keep the last good snapshot, and say why on /health.
      this.status.state = this.snapshot.count > 0 ? 'stale' : 'error';
      this.status.lastError = error.message;
      logger.error(`Kłosok GTFS-RT poll failed: ${error.message}`);
    }

    return this.status;
  }

  /**
   * Lay the Wrocław timetable over the realtime position: line and operator
   * from routes/agency, destination from the matched trip headsign, plus the
   * trip update's delay. Everything is from the timetable, never guessed from
   * GPS.
   */
  #enrich(vehicle, enrichment) {
    return {
      ...vehicle,
      operator: enrichment.agencyName ?? OPERATOR,
      line: enrichment.line,
      // The line's category decides the marker colour, exactly as on the
      // Wrocław side — a 9xx zone line must render pink, never the plain red
      // every vehicle would get from its initial `type: 'bus'`.
      type: enrichment.line ? lineToType(enrichment.line) : vehicle.type,
      // The trip headsign when the run is known; the operator's own label
      // destination when only the line is. Never invented.
      destination: enrichment.destination ?? enrichment.headsign,
      tripId: enrichment.tripId ?? vehicle.tripId ?? null,
      brigade: enrichment.brigade,
      updatedAt: new Date().toISOString(),
    };
  }

  /** The vehicle as /vehicle/:id should see it: fresh positions only. */
  getVehicle(id) {
    return this.#freshLocations().find((entry) => entry.id === id) ?? null;
  }

  /**
   * Compare the previous snapshot against the newly parsed fleet to decide
   * whether the snapshotRevision should advance. Only /locations-visible
   * fields participate: `updatedAt` is a per-poll freshness timestamp that
   * is not on the wire, so excluding it avoids a spurious content change every
   * poll.
   */
  #snapshotChanged(prev, next, stale) {
    if (!prev.locations || prev.locations.length !== next.length) return true;
    if (prev.stale !== stale) return true;
    for (let i = 0; i < next.length; i++) {
      const a = prev.locations[i];
      const b = next[i];
      if (
        a.id !== b.id ||
        a.line !== b.line ||
        a.type !== b.type ||
        a.lat !== b.lat ||
        a.lon !== b.lon ||
        a.heading !== b.heading ||
        a.positionUpdatedAt !== b.positionUpdatedAt ||
        a.delaySeconds !== b.delaySeconds
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Combine the Kłosok fleet with the Wrocław (MPK + Open Data + KD) list.
   * Kłosok wins when it is fresh: a Wrocław vehicle a Kłosok one is clearly
   * the same bus as is dropped rather than shown twice.
   */
  mergeLocations(wroclawLocations) {
    const klosokLocations = this.#freshLocations();
    if (!klosokLocations.length) return wroclawLocations;

    const drop = new Set();
    for (const kv of klosokLocations) {
      const duplicate = this.#findWroclawDuplicate(kv, wroclawLocations);
      if (duplicate) drop.add(duplicate.id);
    }

    return [...klosokLocations, ...wroclawLocations.filter((entry) => !drop.has(entry.id))];
  }

  /** How many of `vehicles` would survive merging with the Wrocław fleet. */
  #dedupCounts(vehicles) {
    const wroclaw = this.getWroclawLocations();
    const drop = new Set();
    for (const kv of vehicles) {
      const duplicate = this.#findWroclawDuplicate(kv, wroclaw);
      if (duplicate) drop.add(duplicate.id);
    }
    return { added: vehicles.length, dropped: drop.size };
  }

  /**
   * Is this Kłosok bus the same physical vehicle as one already served from
   * the Wrocław sources? In order: exact vehicle number, trip id, brigade on
   * the same line, then — as a last resort — the nearest same-line same-type
   * Wrocław vehicle within `KLOSOK_DEDUPE_METERS` at a similar time. Never
   * across lines: nearby is not the same if it is on a different route.
   */
  #findWroclawDuplicate(kv, wroclawLocations) {
    if (!wroclawLocations.length) return null;

    if (kv.vehicleId !== null && kv.vehicleId !== undefined) {
      const byNumber = wroclawLocations.find(
        (w) => w.vehicleNumber !== undefined && w.vehicleNumber !== null &&
          String(w.vehicleNumber) === String(kv.vehicleId),
      );
      if (byNumber) return byNumber;
    }

    if (kv.tripId != null) {
      const byTrip = wroclawLocations.find(
        (w) => w.trip?.tripId != null && w.trip.tripId === kv.tripId,
      );
      if (byTrip) return byTrip;
    }

    if (kv.brigade != null) {
      const byBrigade = wroclawLocations.find(
        (w) => w.brigade != null && w.brigade === kv.brigade && w.line === kv.line,
      );
      if (byBrigade) return byBrigade;
    }

    const candidates = wroclawLocations
      .filter((w) => w.line === kv.line && w.type === kv.type)
      .map((w) => ({ w, meters: distanceMeters(w.lat, w.lon, kv.lat, kv.lon) }))
      .filter((candidate) => candidate.meters <= DEDUPE_METERS && similarTimestamp(candidate.w, kv))
      .sort((a, b) => a.meters - b.meters);

    return candidates[0]?.w ?? null;
  }
}

module.exports = { KlosokService, OPERATOR };
