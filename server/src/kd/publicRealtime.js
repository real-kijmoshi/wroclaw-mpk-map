'use strict';

const logger = require('../logger');
const { fetchWithTimeout } = require('../http');
const { OPERATOR } = require('./static');

/**
 * Live train positions read from kiedyprzyjedzie.pl's own network calls.
 *
 * KD's `kd_sample` account (src/kd/static.js) ships static GTFS only — there
 * is no public GTFS-RT URL to put in KD_GTFS_RT_URL. kiedyprzyjedzie.pl shows
 * real vehicle GPS for the same trains, so this module reproduces the two
 * calls its frontend makes (found by reading its bundled JS — chunk
 * `departures.<hash>.js` for the encoding, `trip.<hash>.js` for the endpoint
 * — not a documented API):
 *
 *   GET /api/departures?places=<id,id,...>                  batched departure boards
 *   GET /api/trip_execution/<base64(trip_execution_id)>/<index>   one train's live GPS
 *
 * A departure row is "live" once `is_estimated` is true and
 * `before_trip_start` is false — the train has actually left its origin, not
 * merely scheduled. A live trip shows up this way at *every* remaining stop
 * on its route, not only the next one, so scanning a spread of station-level
 * stops (GTFS location_type=1 — the parent stations, not individual
 * platforms) is enough to find every running train without querying all
 * ~1000 KD stops. `index` in the second call does not appear to change the
 * answer (every value tried against a live trip returned the same vehicle
 * position); 0 is used unconditionally.
 *
 * `trip_execution_id` (e.g. "69244:739835:0") only works against
 * /api/trip_execution once base64-encoded — kiedyprzyjedzie's own frontend
 * does the same (`btoa(String.fromCharCode(...new TextEncoder().encode(id)))`
 * in its minified `departures.<hash>.js`) before building the link a user
 * clicks. Skipping that step gets a 400 regardless of whether the id itself
 * is valid — this was the one non-obvious step in tracing the calls.
 *
 * This is unauthenticated and undocumented: it can change shape or disappear
 * without notice, exactly like the Nitter alerts source (see CLAUDE.md).
 * Every call here fails soft — a broken batch or a broken trip is dropped
 * and logged, never thrown past this module, so one bad response never empties
 * the whole scan.
 */

const encodeTripExecutionId = (raw) => Buffer.from(raw, 'utf8').toString('base64');

const fetchDeparturesBatch = async (baseUrl, placeIds, timeoutMs) => {
  const url = `${baseUrl}/api/departures?places=${placeIds.join(',')}`;
  const response = await fetchWithTimeout(url, { timeoutMs, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`departures HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.departures) ? body.departures : [];
};

const fetchTripExecution = async (baseUrl, tripExecutionId, timeoutMs) => {
  const encoded = encodeURIComponent(encodeTripExecutionId(tripExecutionId));
  const url = `${baseUrl}/api/trip_execution/${encoded}/0`;
  const response = await fetchWithTimeout(url, { timeoutMs, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`trip_execution HTTP ${response.status}`);
  return response.json();
};

/**
 * Every currently-running trip_execution_id, discovered by scanning
 * departure boards in batches. A failed batch is skipped, not fatal — the
 * other batches still contribute whatever trains they find.
 */
const discoverLiveTrips = async (baseUrl, stationIds, { chunkSize, timeoutMs }) => {
  const live = new Map();
  for (let i = 0; i < stationIds.length; i += chunkSize) {
    const chunk = stationIds.slice(i, i + chunkSize);
    let groups;
    try {
      groups = await fetchDeparturesBatch(baseUrl, chunk, timeoutMs);
    } catch (error) {
      logger.warn(`KD public departures scan failed for a batch of ${chunk.length}: ${error.message}`);
      continue;
    }
    for (const group of groups) {
      for (const row of group.rows ?? []) {
        if (!row.is_estimated || row.before_trip_start || row.canceled) continue;
        if (!row.trip_execution_id) continue;
        if (!live.has(row.trip_execution_id)) live.set(row.trip_execution_id, row);
      }
    }
  }
  return live;
};

/**
 * @param {{ baseUrl: string, stationIds: string[], chunkSize: number, timeoutMs: number }} options
 * @returns {Promise<object[]>} normalised vehicles — same field set service.js expects
 *   from parseRealtime() (id, operator, type, line, tripId, lat, lon, ...), so
 *   the same #enrichVehicle()/getTrip() logic in service.js handles both.
 */
const fetchLiveVehicles = async ({ baseUrl, stationIds, chunkSize, timeoutMs }) => {
  const live = await discoverLiveTrips(baseUrl, stationIds, { chunkSize, timeoutMs });

  const results = await Promise.all(
    [...live.entries()].map(async ([tripExecutionId, row]) => {
      try {
        const detail = await fetchTripExecution(baseUrl, tripExecutionId, timeoutMs);
        const lat = Number(detail?.vehicle?.lat);
        const lon = Number(detail?.vehicle?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const times = Array.isArray(detail.trip?.times) ? detail.trip.times : [];
        const last = times.length ? times[times.length - 1] : null;
        const nextIndex = detail.next_departure_index;
        const estimate = Number.isInteger(nextIndex) ? detail.estimates?.[nextIndex] : null;
        // The site's own time_diff is minutes (matches the whole-minute
        // values seen in /api/departures, e.g. a 27-minute-late row).
        const delaySeconds = Number.isFinite(estimate?.time_diff) ? Math.round(estimate.time_diff * 60) : null;

        return {
          id: `kd:vehicle:public:${tripExecutionId}`,
          operator: OPERATOR,
          type: 'train',
          line: detail.trip?.line?.name ?? row.line_name ?? null,
          routeId: null,
          tripId: row.trip_id != null ? String(row.trip_id) : null,
          startDate: null,
          vehicleLabel: detail.trip?.train?.num ?? row.train?.num ?? null,
          lat: Math.round(lat * 1e5) / 1e5,
          lon: Math.round(lon * 1e5) / 1e5,
          heading: null,
          speed: null,
          destination: last?.stop_name ?? null,
          delaySeconds,
          occupancyStatus: null,
          occupancyPercentage: null,
          positionUpdatedAt: new Date().toISOString(),
          source: 'kd-public-kiedyprzyjedzie',
          rawTripId: null,
        };
      } catch (error) {
        logger.warn(`KD public trip_execution failed for ${tripExecutionId}: ${error.message}`);
        return null;
      }
    }),
  );

  return results.filter(Boolean);
};

module.exports = { discoverLiveTrips, encodeTripExecutionId, fetchDeparturesBatch, fetchLiveVehicles, fetchTripExecution };
