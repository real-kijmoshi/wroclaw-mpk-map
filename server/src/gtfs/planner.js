'use strict';

/**
 * Journey planning: "how do I get from here to there, leaving now".
 *
 * This is a RAPTOR search (round-based, one round per vehicle boarded) over the
 * timetable the store already holds, and it deliberately reuses the *variants*
 * rather than reading stop_times again. A variant is a shape with its ordered
 * stops and, on each stop, `departureOffset` / `arrivalOffset` — seconds from
 * the moment its trip left the first stop. Invariant 18 in AGENTS.md is what
 * makes that legal: every trip of a shape shares one relative profile in this
 * feed, so a pattern's whole timetable is `tripStart[trip] + offset`, and the
 * planner never needs the per-row stop ids that `stopTimes` does not carry.
 *
 * That also decides the shape of the search: RAPTOR wants patterns, and the
 * variants already *are* the patterns, sorted by trip start.
 *
 * What comes out is a Pareto front over arrival time and number of transfers —
 * round k is "the best you can do having boarded k vehicles" — because the
 * fastest plan and the plan with no changes are different answers and a rider
 * asked for both. Nothing here is ranked by "best": they are handed over in
 * arrival order and the client shows the trade-off.
 */

const config = require('../config');
const { lineToType } = require('../lines');
const { distanceMeters } = require('./geo');
const { inWarsaw } = require('./parse');

const DAY_SECONDS = 86_400;

/**
 * The three service days any departure can be served by.
 *
 * A trip that began before midnight is still running after it, and GTFS
 * encodes that as a time past 24:00:00 on the *previous* service day — so
 * yesterday's calendar has to be consulted with its times shifted back a day.
 * Tomorrow is the mirror image and is what keeps the planner answering at
 * 01:00, when tonight's timetable is nearly spent. Same three-day window
 * `getDepartures()` uses, for the same reason.
 */
const SERVICE_DAYS = [
  { dayOffset: -1, shift: -DAY_SECONDS },
  { dayOffset: 0, shift: 0 },
  { dayOffset: 1, shift: DAY_SECONDS },
];

/** Metres per degree of latitude; near enough anywhere, and exact enough here. */
const LAT_DEGREE_METERS = 111_320;

const lonDegreeMeters = (lat) => Math.max(1, LAT_DEGREE_METERS * Math.cos((lat * Math.PI) / 180));

/**
 * Index built once per timetable generation.
 *
 * Two things the search needs on every round and the store does not keep:
 * which patterns call at a stop (RAPTOR's route-scan is driven by exactly
 * that), and a spatial grid so a footpath lookup is not a scan of every stop
 * in the city. Both are derived, so they are rebuilt rather than invalidated:
 * `generation` moves only on a committed build (see GtfsStore#commit).
 */
let indexCache = { generation: -1, index: null };

function buildIndex(gtfs) {
  /** @type {Map<string, Array<{ variant: object, stopIndex: number }>>} */
  const patternsByStop = new Map();

  for (const variants of gtfs.variantsByLine.values()) {
    for (const variant of variants) {
      // A pattern with no usable offsets cannot be timetabled — its
      // representative trip had no start time — so it is not boardable and
      // must not enter the scan.
      if (!variant.trips?.length) continue;
      for (let stopIndex = 0; stopIndex < variant.stops.length; stopIndex += 1) {
        const stop = variant.stops[stopIndex];
        if (stop.departureOffset === null && stop.arrivalOffset === null) continue;
        const bucket = patternsByStop.get(stop.id);
        if (bucket) bucket.push({ variant, stopIndex });
        else patternsByStop.set(stop.id, [{ variant, stopIndex }]);
      }
    }
  }

  // Cell size follows the largest footpath the planner will ever walk, so a
  // neighbour search is always the 3×3 block around a stop and never a scan.
  const cellMeters = Math.max(config.planner.maxAccessMeters, config.planner.maxTransferMeters);
  const latCell = cellMeters / LAT_DEGREE_METERS;
  /** @type {Map<string, object[]>} cell key -> stops in it */
  const grid = new Map();
  const cellKey = (lat, lon) => {
    const row = Math.floor(lat / latCell);
    const lonCell = cellMeters / lonDegreeMeters(lat);
    return `${row}:${Math.floor(lon / lonCell)}`;
  };

  for (const stop of gtfs.stopsById.values()) {
    // Only stops something actually calls at can start or end a leg. The feed
    // carries poles no pattern serves, and offering a walk to one is a plan
    // that strands the rider.
    if (!patternsByStop.has(stop.id)) continue;
    const key = cellKey(stop.lat, stop.lon);
    const bucket = grid.get(key);
    if (bucket) bucket.push(stop);
    else grid.set(key, [stop]);
  }

  /** Stops within `radiusMeters` of a point, from the 3×3 block around it. */
  const stopsNear = (lat, lon, radiusMeters) => {
    const row = Math.floor(lat / latCell);
    const lonCell = cellMeters / lonDegreeMeters(lat);
    const column = Math.floor(lon / lonCell);

    const found = [];
    for (let dRow = -1; dRow <= 1; dRow += 1) {
      for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
        const bucket = grid.get(`${row + dRow}:${column + dColumn}`);
        if (!bucket) continue;
        for (const stop of bucket) {
          const meters = distanceMeters(lat, lon, stop.lat, stop.lon);
          if (meters <= radiusMeters) found.push({ stop, meters });
        }
      }
    }
    return found.sort((a, b) => a.meters - b.meters);
  };

  return { patternsByStop, stopsNear };
}

function getIndex(gtfs) {
  if (indexCache.generation === gtfs.generation && indexCache.index) return indexCache.index;
  const index = buildIndex(gtfs);
  indexCache = { generation: gtfs.generation, index };
  return index;
}

/** Forget the cached index. Tests build several stores in one process. */
function resetPlannerIndex() {
  indexCache = { generation: -1, index: null };
}

/** Seconds a rider needs to cover `meters` on foot. */
const walkSeconds = (meters) => Math.round(meters / config.planner.walkSpeedMps);

/** Local midnight in Warsaw for the day `when` falls on, and the time within it. */
function serviceClock(when) {
  const local = inWarsaw(when);
  const secondsOfDay = local.getHours() * 3600 + local.getMinutes() * 60 + local.getSeconds();
  return { local, secondsOfDay };
}

/**
 * A stop's departure offset, falling back to its arrival.
 *
 * A terminus often carries only one of the two, and a pattern's last stop is
 * never boarded anyway — but the first stop of a short-turn sometimes arrives
 * without departing in the feed, and dropping it would make the pattern
 * unboardable there.
 */
const departureOffsetOf = (stop) => (stop.departureOffset ?? stop.arrivalOffset);
const arrivalOffsetOf = (stop) => (stop.arrivalOffset ?? stop.departureOffset);

/**
 * The first run of `variant` that leaves stop `stopIndex` at or after `earliest`.
 *
 * `variant.trips` is sorted by `tripStart` and every stop's offset is the same
 * for all of them, so departures at a fixed stop are sorted too and a binary
 * search lands on the answer. The forward walk after it only steps over runs
 * whose calendar says they are not out today.
 *
 * @returns {{ tripIndex: number, departure: number, day: object }|null}
 *   `departure` is in seconds from midnight of the *query's* day, so a run
 *   from yesterday's calendar comes back negative-shifted and comparable.
 */
function earliestTrip(gtfs, variant, stopIndex, earliest, days) {
  const offset = departureOffsetOf(variant.stops[stopIndex]);
  if (offset === null) return null;

  let best = null;
  for (const day of days) {
    const target = earliest - day.shift - offset;

    let low = 0;
    let high = variant.trips.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (gtfs.tripStart[variant.trips[mid]] < target) low = mid + 1;
      else high = mid;
    }

    for (let i = low; i < variant.trips.length; i += 1) {
      const tripIndex = variant.trips[i];
      const departure = gtfs.tripStart[tripIndex] + offset + day.shift;
      if (best && departure >= best.departure) break;
      if (!gtfs.isServiceActive(gtfs.trips[tripIndex].serviceId, day.date)) continue;
      best = { tripIndex, departure, day };
      break;
    }
  }

  return best;
}

/**
 * Plan journeys from one point to another.
 *
 * @param {object} gtfs a ready GtfsStore
 * @param {{
 *   from: { lat: number, lon: number, name?: string|null },
 *   to: { lat: number, lon: number, name?: string|null },
 *   departAt?: Date,
 *   maxTransfers?: number,
 *   maxAccessMeters?: number,
 * }} options
 */
function planJourney(gtfs, options) {
  const { from, to } = options;
  const departAt = options.departAt ?? new Date();
  const maxTransfers = Math.min(
    Math.max(Number.isFinite(options.maxTransfers) ? options.maxTransfers : config.planner.maxTransfers, 0),
    config.planner.maxTransfers,
  );
  const maxAccessMeters = Math.min(
    options.maxAccessMeters || config.planner.maxAccessMeters,
    config.planner.maxAccessMeters,
  );

  const { patternsByStop, stopsNear } = getIndex(gtfs);
  const { local, secondsOfDay } = serviceClock(departAt);

  // Each service day carries the calendar date it must be checked against, so
  // `isServiceActive` is asked about the day the trip *started*, not the day
  // the rider is standing there.
  const days = SERVICE_DAYS.map((day) => {
    const date = new Date(local);
    date.setDate(date.getDate() + day.dayOffset);
    return { ...day, date };
  });

  const directMeters = distanceMeters(from.lat, from.lon, to.lat, to.lon);

  /** @type {Map<string, {arrival: number, label: object|null}>} best over all rounds */
  const best = new Map();
  /** Per-round arrivals; round 0 is "on foot from the origin". */
  const rounds = [new Map()];

  const relax = (round, stopId, arrival, label) => {
    const known = best.get(stopId);
    if (known && known.arrival <= arrival) return false;
    best.set(stopId, { arrival, label });
    rounds[round].set(stopId, { arrival, label });
    return true;
  };

  let marked = new Set();
  for (const { stop, meters } of stopsNear(from.lat, from.lon, maxAccessMeters)) {
    // Walking straight past the destination to a stop is never a plan worth
    // making; it is also what produces the absurd "walk 700 m to ride one
    // stop back" suggestion.
    if (meters > directMeters) continue;
    const arrival = secondsOfDay + walkSeconds(meters);
    if (relax(0, stop.id, arrival, { type: 'access', meters })) marked.add(stop.id);
  }

  /** @type {Array<{arrival: number, stopId: string, meters: number, round: number}>} */
  const arrivals = [];
  const considerEgress = (round) => {
    for (const [stopId, entry] of rounds[round]) {
      const stop = gtfs.stopsById.get(stopId);
      if (!stop) continue;
      const meters = distanceMeters(stop.lat, stop.lon, to.lat, to.lon);
      if (meters > maxAccessMeters) continue;
      arrivals.push({ arrival: entry.arrival + walkSeconds(meters), stopId, meters, round });
    }
  };

  for (let round = 1; round <= maxTransfers + 1 && marked.size; round += 1) {
    rounds[round] = new Map();

    // RAPTOR's route scan: every pattern touched by a marked stop is ridden
    // once, from the earliest marked position it can be boarded at.
    /** @type {Map<object, number>} variant -> earliest marked stop index */
    const queue = new Map();
    for (const stopId of marked) {
      for (const { variant, stopIndex } of patternsByStop.get(stopId) ?? []) {
        const existing = queue.get(variant);
        if (existing === undefined || stopIndex < existing) queue.set(variant, stopIndex);
      }
    }

    const nextMarked = new Set();

    for (const [variant, fromIndex] of queue) {
      /** @type {{tripIndex: number, departure: number, day: object, boardIndex: number}|null} */
      let riding = null;

      for (let stopIndex = fromIndex; stopIndex < variant.stops.length; stopIndex += 1) {
        const stop = variant.stops[stopIndex];

        if (riding) {
          const offset = arrivalOffsetOf(stop);
          if (offset !== null) {
            const arrival =
              gtfs.tripStart[riding.tripIndex] + offset + riding.day.shift;
            if (
              relax(round, stop.id, arrival, {
                type: 'ride',
                variant,
                tripIndex: riding.tripIndex,
                boardIndex: riding.boardIndex,
                alightIndex: stopIndex,
                departure: riding.departure,
                arrival,
                fromStopId: variant.stops[riding.boardIndex].id,
                fromRound: round - 1,
              })
            ) {
              nextMarked.add(stop.id);
            }
          }
        }

        // Board here when the previous round got the rider to this stop before
        // the run being ridden would. Comparing against the *previous* round
        // rather than `best` is what keeps a journey from boarding a vehicle
        // it could only reach by having already ridden it.
        const reached = rounds[round - 1].get(stop.id);
        if (!reached) continue;

        // Changing vehicles costs the walk between platforms plus a buffer;
        // stepping onto the first vehicle of the journey costs neither.
        const ready =
          reached.arrival +
          (round === 1 ? 0 : config.planner.transferBufferSeconds);

        if (riding) {
          const currentDeparture =
            gtfs.tripStart[riding.tripIndex] + departureOffsetOf(stop) + riding.day.shift;
          if (currentDeparture <= ready) continue;
        }

        const candidate = earliestTrip(gtfs, variant, stopIndex, ready, days);
        if (!candidate) continue;
        if (riding && candidate.departure >= riding.departure) continue;
        riding = { ...candidate, boardIndex: stopIndex };
      }
    }

    // Footpaths: a change is often to the pole across the street, and without
    // this the search can only ever transfer between lines that share a stop
    // id — which in this feed means missing most real interchanges.
    for (const stopId of [...nextMarked]) {
      const entry = rounds[round].get(stopId);
      const stop = gtfs.stopsById.get(stopId);
      if (!entry || !stop) continue;
      for (const near of stopsNear(stop.lat, stop.lon, config.planner.maxTransferMeters)) {
        if (near.stop.id === stopId) continue;
        const arrival = entry.arrival + walkSeconds(near.meters);
        if (
          relax(round, near.stop.id, arrival, {
            type: 'transfer',
            fromStopId: stopId,
            meters: near.meters,
            fromRound: round,
          })
        ) {
          nextMarked.add(near.stop.id);
        }
      }
    }

    considerEgress(round);
    marked = nextMarked;
  }

  // One plan per round: the Pareto front over (arrival, transfers). A later
  // round only earns a place by arriving sooner than every rounder before it.
  const byRound = new Map();
  for (const arrival of arrivals.sort((a, b) => a.arrival - b.arrival)) {
    if (!byRound.has(arrival.round)) byRound.set(arrival.round, arrival);
  }

  const epochAt = (seconds) =>
    new Date(departAt.getTime() + (seconds - secondsOfDay) * 1000).toISOString();

  const plans = [];
  let bestSoFar = Infinity;
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const arrival = byRound.get(round);
    if (arrival.arrival >= bestSoFar) continue;
    bestSoFar = arrival.arrival;
    const plan = buildPlan(gtfs, { arrival, rounds, from, to, epochAt, secondsOfDay });
    if (plan) plans.push(plan);
  }

  const walkOnly =
    directMeters <= config.planner.maxWalkOnlyMeters
      ? {
          departure: epochAt(secondsOfDay),
          arrival: epochAt(secondsOfDay + walkSeconds(directMeters)),
          durationSeconds: walkSeconds(directMeters),
          transfers: 0,
          walkMeters: Math.round(directMeters),
          legs: [
            {
              mode: 'walk',
              meters: Math.round(directMeters),
              seconds: walkSeconds(directMeters),
              from: { name: from.name ?? null, lat: from.lat, lon: from.lon },
              to: { name: to.name ?? null, lat: to.lat, lon: to.lon },
            },
          ],
        }
      : null;

  return {
    from: { ...from, name: from.name ?? null },
    to: { ...to, name: to.name ?? null },
    departAt: departAt.toISOString(),
    walkOnly,
    plans: plans.sort((a, b) => a.durationSeconds - b.durationSeconds),
  };
}

/** Walk the parent pointers back from an egress and turn them into legs. */
function buildPlan(gtfs, { arrival, rounds, from, to, epochAt, secondsOfDay }) {
  const steps = [];
  let stopId = arrival.stopId;
  let round = arrival.round;
  let guard = 0;

  while (guard < 64) {
    guard += 1;
    const entry = rounds[round]?.get(stopId);
    if (!entry?.label) return null;
    const label = entry.label;
    steps.push({ stopId, arrival: entry.arrival, label });
    if (label.type === 'access') break;
    stopId = label.fromStopId;
    round = label.fromRound;
  }

  steps.reverse();

  const legs = [];
  let walkMeters = 0;
  let transfers = -1;

  for (const step of steps) {
    const label = step.label;
    if (label.type === 'access') {
      const stop = gtfs.stopsById.get(step.stopId);
      walkMeters += label.meters;
      legs.push({
        mode: 'walk',
        meters: Math.round(label.meters),
        seconds: Math.round(label.meters / config.planner.walkSpeedMps),
        from: { name: from.name ?? null, lat: from.lat, lon: from.lon },
        to: stopSummary(gtfs, stop),
      });
      continue;
    }

    if (label.type === 'transfer') {
      const stop = gtfs.stopsById.get(step.stopId);
      walkMeters += label.meters;
      legs.push({
        mode: 'walk',
        meters: Math.round(label.meters),
        seconds: Math.round(label.meters / config.planner.walkSpeedMps),
        from: stopSummary(gtfs, gtfs.stopsById.get(label.fromStopId)),
        to: stopSummary(gtfs, stop),
      });
      continue;
    }

    transfers += 1;
    const variant = label.variant;
    const trip = gtfs.trips[label.tripIndex];
    const ridden = variant.stops.slice(label.boardIndex, label.alightIndex + 1);
    legs.push({
      mode: 'ride',
      line: variant.line,
      type: lineToType(variant.line),
      headsign: variant.headsign,
      direction: variant.direction,
      tripId: trip.id,
      shapeId: variant.shapeId,
      departure: epochAt(label.departure),
      arrival: epochAt(label.arrival),
      seconds: label.arrival - label.departure,
      from: stopSummary(gtfs, gtfs.stopsById.get(variant.stops[label.boardIndex].id)),
      to: stopSummary(gtfs, gtfs.stopsById.get(variant.stops[label.alightIndex].id)),
      stops: ridden.map((stop) => ({ id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon })),
    });
  }

  const last = gtfs.stopsById.get(arrival.stopId);
  if (arrival.meters > 0) {
    walkMeters += arrival.meters;
    legs.push({
      mode: 'walk',
      meters: Math.round(arrival.meters),
      seconds: Math.round(arrival.meters / config.planner.walkSpeedMps),
      from: stopSummary(gtfs, last),
      to: { name: to.name ?? null, lat: to.lat, lon: to.lon },
    });
  }

  const rides = legs.filter((leg) => leg.mode === 'ride');
  if (!rides.length) return null;

  // A plan starts when the rider has to *leave*, which is the first ride's
  // departure less the walk to reach it — not "now". Printing the query time
  // there is what makes an app say "leave at 08:00" for a tram at 08:12, and
  // then a rider who left at 08:00 stands on the pavement for twelve minutes.
  const firstRide = steps.find((step) => step.label.type === 'ride').label;
  const firstWalkSeconds = legs[0].mode === 'walk' ? legs[0].seconds : 0;
  const departureSeconds = Math.max(secondsOfDay, firstRide.departure - firstWalkSeconds);

  return {
    departure: epochAt(departureSeconds),
    arrival: epochAt(arrival.arrival),
    durationSeconds: arrival.arrival - departureSeconds,
    // Waiting at the origin is not part of the journey, but a rider planning
    // an evening does need to know how long "now until there" is.
    startsInSeconds: departureSeconds - secondsOfDay,
    transfers: Math.max(transfers, 0),
    walkMeters: Math.round(walkMeters),
    legs,
  };
}

function stopSummary(gtfs, stop) {
  if (!stop) return null;
  return {
    id: stop.id,
    name: stop.name,
    code: stop.code ?? null,
    lat: stop.lat,
    lon: stop.lon,
    lines: gtfs.getLinesForStop(stop.id),
  };
}

module.exports = { planJourney, resetPlannerIndex };
