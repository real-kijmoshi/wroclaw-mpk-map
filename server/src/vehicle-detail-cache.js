'use strict';

const { LruCache } = require('./cache');

/**
 * Bounded cache for `/vehicle/:id` detail payloads.
 *
 * A detail is the expensive part of `describeVehicle` — variant matching,
 * projection along the shape and the stop list — plus time-sensitive output
 * (run, delay, ETAs). The two have different invalidation rules, so the cache
 * layers three guards instead of trusting the position alone:
 *
 *   1. The cache key is namespaced by the GTFS generation, so a timetable
 *      refresh that swaps the live store never serves detail built from the old
 *      geometry. Generation is bumped only on a successful atomic commit, so a
 *      failed refresh keeps serving the working detail untouched.
 *   2. The key also carries the vehicle tracker's poll revision, which bumps on
 *      every accepted poll — the natural "this position/heading is stale"
 *      signal for a fleet that keeps refreshing.
 *   3. A short TTL bounds the time-sensitive part. A vehicle can sit still for
 *      minutes while its scheduled departure drifts, so position-matching alone
 *      would serve stale delays/ETAs indefinitely without a hard cap.
 *
 * `limit` and `history` are part of the key too: the same vehicle requested
 * with a different slice must not collide with a prior slice.
 */
class VehicleDetailCache extends LruCache {
  /**
   * @param {{ maxEntries?: number, ttlMs?: number }} options
   */
  constructor({ maxEntries = 512, ttlMs = 10_000 } = {}) {
    super(maxEntries);
    this.ttlMs = ttlMs;
  }

  #key(generation, revision, id, limit, history) {
    return `${generation}|${revision ?? 0}|${id}|${limit}|${history}`;
  }

  /**
   * @returns {object|null} the cached trip, or `null` when no fresh-enough
   *   detail is held for this vehicle.
   */
  get(generation, revision, id, limit, history, vehicle, now = Date.now()) {
    const key = this.#key(generation, revision, id, limit, history);
    const entry = this.map.get(key);
    if (!entry) return null;

    // A vehicle that has moved or turned invalidates the detail computed for
    // its previous spot — the position fingerprint must still match.
    if (
      entry.lat !== vehicle.lat ||
      entry.lon !== vehicle.lon ||
      entry.heading !== (vehicle.heading ?? null)
    ) {
      return null;
    }

    // The schedule keeps moving. Even with the same position and the same poll
    // revision, a detail older than the TTL is time-stale and must not be
    // served.
    if (this.ttlMs != null && now - entry.cachedAt > this.ttlMs) return null;

    // Cache hit: mark most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.trip;
  }

  set(generation, revision, id, limit, history, vehicle, trip, now = Date.now()) {
    const key = this.#key(generation, revision, id, limit, history);
    super.set(key, {
      lat: vehicle.lat,
      lon: vehicle.lon,
      heading: vehicle.heading ?? null,
      cachedAt: now,
      trip,
    });
  }
}

module.exports = { VehicleDetailCache };
