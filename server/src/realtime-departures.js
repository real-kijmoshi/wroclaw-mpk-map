'use strict';

/**
 * High-confidence live ETAs for the departure board.
 *
 * A live prediction is attached to a scheduled departure only when the server
 * can say, with narrow certainty, that a tracked vehicle is on its way to the
 * requested stop *right now*: the vehicle's matched GTFS trip id must equal the
 * scheduled departure row's trip id, and the vehicle has named this stop as its
 * immediate next stop. Anything else — a different trip, a different stop ahead,
 * a stale observation — falls back to the timetable without pretending.
 *
 * This is deliberately conservative. The server does not project vehicles into
 * the future, so a departure whose stop is merely further down the vehicle's
 * run is served from the schedule alone.
 */

/**
 * A vehicle observation older than this is not trusted for departure enrichment.
 *
 * The fleet snapshot lingers for up to `staleAfterMs` (2 min) on the map, but an
 * ETA on a stop board needs a tighter bound — a tram's position ten seconds ago
 * is useful; one that is 45 s old is already a guess about traffic that has
 * since changed.
 */
const MAX_LIVE_AGE_MS = 45_000;

/**
 * The fields every departure carries, live or not.
 *
 * `realtime` true means the `predictedInSeconds` value came from a tracked
 * vehicle whose next stop is this stop; false means it is the schedule.
 */
const LIVE_CLEAR = { realtime: false, predictedInSeconds: null, vehicleId: null };

/**
 * Pick the single most-recent vehicle that claims a departure's trip, from a
 * list of candidates already filtered to this stop and this trip.
 *
 * If two vehicles tie on observation time, neither is trusted — that is the
 * one ambiguity the matching cannot resolve from position alone, and guessing
 * would pick the wrong run about half the time.
 *
 * @param {Array<{vehicleId: string, tripId: string, etaSeconds: number, updatedAt: number}>} candidates
 * @param {string} tripId
 * @param {number} nowMs
 * @returns {{vehicleId: string, etaSeconds: number} | null}
 */
function pickLiveVehicle(candidates, tripId, nowMs) {
  let best = null;
  let tieAtTop = false;

  for (const candidate of candidates) {
    // Trust conditions: the trip must match, the ETA must be a real number
    // and not negative, and the observation must be fresh enough.
    if (candidate.tripId !== tripId) continue;
    if (!Number.isFinite(candidate.etaSeconds) || candidate.etaSeconds < 0) continue;
    if (nowMs - candidate.updatedAt > MAX_LIVE_AGE_MS) continue;

    if (!best) {
      best = candidate;
    } else if (candidate.updatedAt > best.updatedAt) {
      best = candidate;
      tieAtTop = false;
    } else if (candidate.updatedAt === best.updatedAt) {
      tieAtTop = true;
    }
  }

  if (!best || tieAtTop) return null;
  return { vehicleId: best.vehicleId, etaSeconds: best.etaSeconds };
}

/**
 * Attach live ETA fields to every scheduled departure for a stop.
 *
 * `vehicles` is the live `VehicleTracker` (or a compatible shape): its
 * `snapshot.stale` flag gates the whole lookup, and `nextStopIndex` maps a
 * stop id to the live vehicles whose current next stop is that stop.
 *
 * @param {Array<object>} departures — from `gtfs.getDepartures(stopId)`
 * @param {string} stopId
 * @param {{ snapshot?: { stale?: boolean }, nextStopIndex?: Map }} vehicles
 * @param {number} [nowMs] — injectable for tests
 * @returns {Array<object>} departures with `realtime`, `predictedInSeconds`,
 *   `vehicleId` added to each
 */
function enrichDepartures(departures, stopId, vehicles, nowMs = Date.now()) {
  if (!Array.isArray(departures) || departures.length === 0) return departures;

  // A stale snapshot means the fleet stopped updating — live ETAs would be
  // guesses served as certainty, so every departure stays scheduled.
  const isStale = !vehicles || !vehicles.snapshot || vehicles.snapshot.stale;
  const index = vehicles?.nextStopIndex;

  return departures.map((departure) => {
    const tripId = typeof departure.tripId === 'string' ? departure.tripId : null;
    if (tripId && index && !isStale) {
      const candidates = index.get(stopId);
      if (candidates && candidates.length) {
        const live = pickLiveVehicle(candidates, tripId, nowMs);
        if (live) {
          return {
            ...departure,
            realtime: true,
            predictedInSeconds: live.etaSeconds,
            vehicleId: live.vehicleId,
          };
        }
      }
    }

    return { ...departure, ...LIVE_CLEAR };
  });
}

module.exports = { enrichDepartures, MAX_LIVE_AGE_MS, LIVE_CLEAR };
