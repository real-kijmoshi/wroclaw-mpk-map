'use strict';

const config = require('../config');
const logger = require('../logger');
const { fetchWithTimeout } = require('../http');
const { KdStaticStore, OPERATOR } = require('./static');
const { findTripUpdate, parseRealtime } = require('./realtime');
const { fetchLiveVehicles: fetchPublicLiveVehicles } = require('./publicRealtime');

/**
 * Koleje Dolnośląskie as a standalone provider.
 *
 * Owns one KdStaticStore (the timetable) and the GTFS-RT poll (live trains),
 * and merges the two: a realtime position is enriched with the line and
 * destination from the static feed, and departures carry realtime delays.
 *
 * KD is deliberately NOT a VehicleTracker. The MPK tracker is Wrocław-only —
 * KD trains run across Lower Silesia — and its matching heuristics make no
 * sense here. This service fails soft: a KD outage never crashes the server,
 * never blocks MPK, and never makes /health unhealthy while Wrocław works.
 *
 * Live positions have two sources, tried in priority order like every other
 * multi-source config in this project: KD_GTFS_RT_URL (an official feed,
 * when someone has one) first, and failing that — since the kd_sample
 * account has no such feed — kiedyprzyjedzie.pl's own public network calls
 * (publicRealtime.js). Whichever one answers, the resulting vehicles are
 * enriched from the exact same static store through #enrichVehicle(), so
 * getTrip() and every route in routes.js are source-agnostic.
 */
class KdService {
  constructor() {
    this.static = new KdStaticStore();
    const hasRealtimeSource = Boolean(config.kd.realtimeUrl) || config.kd.publicRealtimeEnabled;
    this.realtimeStatus = {
      configured: hasRealtimeSource,
      mode: config.kd.realtimeUrl ? 'official-gtfs-rt' : config.kd.publicRealtimeEnabled ? 'public-fallback' : 'disabled',
      state: hasRealtimeSource ? 'idle' : 'disabled',
      source: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      vehiclePositions: 0,
      tripUpdates: 0,
      trackedVehicles: 0,
      newestTimestamp: null,
      oldestTimestamp: null,
    };
    this.snapshot = { locations: [], count: 0, lastUpdated: null, stale: false, source: 'kd-gtfs-rt' };
    /**
     * Content revision: bumps only when /locations-visible state in the KD
     * snapshot changes. Drives the combined-fleet key in /locations.
     */
    this.snapshotRevision = 0;
    /** @type {Map<string, object>} last parsed trip updates, startDate|tripId -> update */
    this.tripUpdates = new Map();
    this.staticTimer = null;
    this.realtimeTimer = null;
    this.started = false;
  }

  get isReady() {
    return this.static.isReady;
  }

  get status() {
    return {
      enabled: config.kd.enabled,
      static: this.static.status,
      realtime: this.realtimeStatus,
    };
  }

  /** Load the timetable, then start the periodic refresh and RT poll. */
  async start() {
    if (this.started) return;
    this.started = true;

    if (!config.kd.enabled) {
      logger.info('KD disabled — set KD_ENABLED=true to enable');
      return;
    }

    await this.refreshStatic();

    this.staticTimer = setInterval(() => {
      this.refreshStatic().catch(() => {});
    }, config.kd.refreshIntervalMs);

    if (config.kd.realtimeUrl) {
      await this.pollRealtime();
      this.realtimeTimer = setInterval(() => {
        this.pollRealtime().catch(() => {});
      }, config.kd.realtimePollIntervalMs);
    } else if (config.kd.publicRealtimeEnabled) {
      logger.info('KD GTFS-RT not configured — falling back to kiedyPrzyjedzie.pl public live positions');
      await this.pollRealtime();
      this.realtimeTimer = setInterval(() => {
        this.pollRealtime().catch(() => {});
      }, config.kd.publicRealtimePollIntervalMs);
    } else {
      logger.info('KD GTFS-RT not configured — live trains disabled');
    }
  }

  /** Stop both timers. Anything scheduled must be stoppable (CLAUDE.md). */
  stop() {
    if (this.staticTimer) clearInterval(this.staticTimer);
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    this.staticTimer = null;
    this.realtimeTimer = null;
    this.started = false;
  }

  async refreshStatic() {
    await this.static.refresh();
  }

  /** Dispatch to whichever live source is configured — see the class doc. */
  async pollRealtime() {
    if (config.kd.realtimeUrl) return this.#pollOfficialGtfsRt();
    if (config.kd.publicRealtimeEnabled) return this.#pollPublicRealtime();
  }

  /** One GTFS-RT poll: fetch, decode, and hold the resulting snapshot. */
  async #pollOfficialGtfsRt() {
    const { realtimeUrl, realtimeUsername, realtimePassword, realtimeTimeoutMs } = config.kd;
    if (!realtimeUrl) return;

    this.realtimeStatus.lastAttemptAt = new Date().toISOString();
    try {
      const headers = { Accept: 'application/x-protobuf' };
      if (realtimeUsername || realtimePassword) {
        headers.Authorization = `Basic ${Buffer.from(`${realtimeUsername}:${realtimePassword}`).toString('base64')}`;
      }
      const response = await fetchWithTimeout(realtimeUrl, {
        timeoutMs: realtimeTimeoutMs,
        redirect: 'follow',
        headers,
      });
      if (!response.ok) {
        throw new Error(`KD GTFS-RT responded HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const now = new Date();
      const parsed = parseRealtime(buffer, { now });

      this.tripUpdates = parsed.tripUpdates;
      const enriched = parsed.vehicles.map((vehicle) => this.#enrichVehicle(vehicle));

      const timestamps = enriched
        .map((vehicle) => Date.parse(vehicle.positionUpdatedAt))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

      // Bump the content revision only when /locations-visible state changed,
      // not on every poll that returned identical positions.
      const changed = this.#snapshotChanged(this.snapshot, enriched, parsed.stale);

      this.snapshot = {
        locations: enriched,
        count: enriched.length,
        lastUpdated: now.toISOString(),
        stale: parsed.stale,
        source: 'kd-gtfs-rt',
      };
      this.snapshotRevision += changed ? 1 : 0;
      this.realtimeStatus = {
        ...this.realtimeStatus,
        state: 'ready',
        source: realtimeUrl,
        lastSuccessAt: now.toISOString(),
        lastError: null,
        vehiclePositions: enriched.length,
        tripUpdates: parsed.tripUpdates.size,
        trackedVehicles: enriched.length,
        newestTimestamp: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
        oldestTimestamp: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
      };
      logger.info(`KD GTFS-RT: ${enriched.length} vehicles, ${parsed.tripUpdates.size} trip updates`);
    } catch (error) {
      // Fail soft: keep the last good snapshot, and say why on /health.
      this.realtimeStatus.state = this.snapshot.count > 0 ? 'stale' : 'error';
      this.realtimeStatus.lastError = error.message;
      logger.error(`KD GTFS-RT poll failed: ${error.message}`);
    }
  }

  /**
   * One scan of kiedyprzyjedzie.pl's public departure boards (see
   * publicRealtime.js), used only when no official GTFS-RT URL is
   * configured. Needs the static store for the list of stations to scan and
   * to join each vehicle's bare numeric trip_id back to a GTFS trip, so it
   * is a no-op until the timetable has loaded at least once.
   */
  async #pollPublicRealtime() {
    if (!this.static.isReady) return;

    const { publicRealtimeUrl: baseUrl, publicRealtimeChunkSize: chunkSize, publicRealtimeTimeoutMs: timeoutMs } =
      config.kd;
    const stationIds = [...this.static.stopsById.values()]
      .filter((stop) => stop.locationType === 1)
      .map((stop) => stop.rawId);
    if (!stationIds.length) return;

    this.realtimeStatus.lastAttemptAt = new Date().toISOString();
    try {
      const raw = await fetchPublicLiveVehicles({ baseUrl, stationIds, chunkSize, timeoutMs });
      const now = new Date();
      const enriched = raw.map((vehicle) => this.#enrichVehicle(this.#resolvePublicTrip(vehicle)));

      const timestamps = enriched
        .map((vehicle) => Date.parse(vehicle.positionUpdatedAt))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

      // Bump the content revision only when /locations-visible state changed.
      const changed = this.#snapshotChanged(this.snapshot, enriched, false);

      this.snapshot = {
        locations: enriched,
        count: enriched.length,
        lastUpdated: now.toISOString(),
        stale: false,
        source: 'kd-public-kiedyprzyjedzie',
      };
      this.snapshotRevision += changed ? 1 : 0;
      this.realtimeStatus = {
        ...this.realtimeStatus,
        state: 'ready',
        source: baseUrl,
        lastSuccessAt: now.toISOString(),
        lastError: null,
        vehiclePositions: enriched.length,
        tripUpdates: 0,
        trackedVehicles: enriched.length,
        newestTimestamp: timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
        oldestTimestamp: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
      };
      logger.info(`KD public live positions: ${enriched.length} train(s) across ${stationIds.length} stations`);
    } catch (error) {
      // Fail soft, same as the official path: keep the last good snapshot.
      this.realtimeStatus.state = this.snapshot.count > 0 ? 'stale' : 'error';
      this.realtimeStatus.lastError = error.message;
      logger.error(`KD public live-position scan failed: ${error.message}`);
    }
  }

  /**
   * kiedyPrzyjedzie.pl's `trip_id` is the bare numeric id shared with this
   * feed's own trip_id before its "_<variant>" suffix. Resolving it lets a
   * public-fallback vehicle reuse #enrichVehicle() exactly like an official
   * GTFS-RT one — same route name, same headsign, never a second code path.
   * When more than one of today's trips shares the number, the one whose
   * service actually runs today wins; otherwise the first is close enough.
   */
  #resolvePublicTrip(vehicle) {
    if (!vehicle.tripId) return vehicle;
    const candidates = this.static.resolveTripsByNumericId(vehicle.tripId);
    if (!candidates.length) return vehicle;

    const today = new Date();
    const rawTripId =
      candidates.find((id) => {
        const trip = this.static.tripsById.get(id);
        return trip && this.static.isServiceActive(trip.serviceId, today);
      }) ?? candidates[0];
    return { ...vehicle, rawTripId };
  }

  /**
   * Lay the realtime vehicle position over the static timetable record: the
   * line comes from the route short name and the destination from the trip
   * headsign — never guessed from GPS.
   */
  #enrichVehicle(vehicle) {
    const trip = vehicle.rawTripId ? this.static.tripsById.get(vehicle.rawTripId) : null;
    return {
      ...vehicle,
      line: trip?.routeId ? this.static.routeName(trip.routeId) ?? null : vehicle.line,
      destination: trip?.headsign ?? vehicle.destination,
    };
  }

  getVehicle(id) {
    return this.snapshot.locations.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Compare the previous snapshot against the newly parsed fleet to decide
   * whether snapshotRevision should advance. Only /locations-visible fields
   * participate: `updatedAt` is a per-poll freshness timestamp, not content.
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
   * Detail for one train: its trip record, the next stop, and the remaining
   * stops. The next stop prefers the GTFS-RT trip update's stop_time_updates;
   * without one, the static timetable answers — and the stop is marked
   * `predicted: false` so the client never presents a schedule as live.
   */
  getTrip(id) {
    const vehicle = this.getVehicle(id);
    if (!vehicle) return null;

    const trip = vehicle.rawTripId ? this.static.tripsById.get(vehicle.rawTripId) : null;
    if (!trip) {
      return {
        vehicle,
        trip: {
          routeId: vehicle.routeId,
          tripId: vehicle.tripId,
          headsign: vehicle.destination,
          delaySeconds: vehicle.delaySeconds,
          previousStop: null,
          nextStop: null,
          stopsAhead: [],
        },
      };
    }

    const route = this.static.routesById.get(trip.routeId);
    const scheduled = this.static.getTripStops(trip.rawId);
    const update = findTripUpdate(this.tripUpdates, trip.rawId, vehicle.startDate);

    const stopTimeUpdates = update?.stopTimeUpdates ?? [];
    const bySequence = new Map(stopTimeUpdates.map((entry) => [entry.stopSequence, entry]));

    const nextRealtime = update
      ? (() => {
          const first = [...stopTimeUpdates].sort(
            (a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0),
          )[0];
          if (!first) return null;
          return { stopSequence: first.stopSequence, stopId: first.stopId };
        })()
      : null;

    const stops = scheduled?.stops ?? [];
    const nextIndex = (() => {
      if (nextRealtime) {
        const found = nextRealtime.stopId
          ? stops.findIndex((stop) => stop.rawStopId === nextRealtime.stopId)
          : nextRealtime.stopSequence;
        if (found >= 0) return found;
      }
      return 0;
    })();

    const stopsAhead = stops.map((stop) => {
      const realtime = bySequence.get(stop.sequence);
      const delay = realtime?.departureDelay ?? realtime?.arrivalDelay ?? null;
      return {
        stopId: stop.stopId,
        rawStopId: stop.rawStopId,
        name: stop.name,
        platformCode: stop.platformCode,
        sequence: stop.sequence,
        scheduledArrival: stop.scheduledArrival,
        scheduledDeparture: stop.scheduledDeparture,
        predictedArrival: delay === null ? null : stop.scheduledArrival,
        predictedDeparture: delay === null ? null : stop.scheduledDeparture,
        delaySeconds: delay,
        predicted: delay !== null,
      };
    });

    return {
      vehicle,
      trip: {
        routeId: trip.routeId,
        routeName: route?.shortName ?? null,
        tripId: trip.id,
        rawTripId: trip.rawId,
        headsign: trip.headsign,
        delaySeconds: vehicle.delaySeconds,
        operator: OPERATOR,
        previousStop: nextIndex > 0 ? stopsAhead[nextIndex - 1] ?? null : null,
        nextStop: stopsAhead[nextIndex] ?? null,
        stopsAhead: stopsAhead.slice(nextIndex),
      },
    };
  }

  /** Raw GTFS id from a kd:stop:<id> wire id (passes plain ids through). */
  #rawStopId(id) {
    return id.startsWith('kd:stop:') ? id.slice('kd:stop:'.length) : id;
  }

  getStop(id) {
    return this.static.getStop(this.#rawStopId(id));
  }

  /** The KD route lines, from routes.txt — never hardcoded. */
  getLines() {
    const lines = [];
    for (const route of this.static.routesById.values()) {
      const name = this.static.routeName(route.rawId);
      if (name) lines.push(name);
    }
    const { compareLines } = require('../lines');
    return [...new Set(lines)].sort(compareLines);
  }

  searchStops(query, limit) {
    return this.static.searchStops(query, limit);
  }

  getDepartures(id, options) {
    return this.static.getDepartures(this.#rawStopId(id), options);
  }

  getTripShape(rawTripId) {
    return this.static.getTripShape(rawTripId);
  }
}

module.exports = { KdService };
