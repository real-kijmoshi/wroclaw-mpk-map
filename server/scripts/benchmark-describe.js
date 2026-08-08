'use strict';

/**
 * Fleet-wide route-description benchmark: the full matcher vs the incremental
 * fast path (`describeVehicle` with `previousState`).
 *
 * Builds the store from a real Wrocław archive, synthesises a fleet of
 * vehicles spread across every line's variants, then simulates consecutive
 * polls where each vehicle advances ~120 m along its route (a tram at ~12 m/s
 * over a ten-second poll, plus a few metres of GPS jitter). The full-scan run
 * describes every vehicle from scratch each poll; the fast-path run feeds each
 * vehicle's previous projection state in and lets the incremental projection
 * skip the full scan where it can.
 *
 * Also re-runs one poll both ways for every vehicle and reports how many of
 * the answers were byte-identical — the fast path must never be *more* wrong
 * than the full matcher, only cheaper.
 *
 * Usage:
 *   node scripts/benchmark-describe.js                # use the configured GTFS cache
 *   node scripts/benchmark-describe.js /path/file.zip # use a specific archive
 */

const fs = require('node:fs');
const path = require('node:path');

const { GtfsStore } = require('../src/gtfs/store');
const { describeVehicle } = require('../src/progress');
const { bearingDegrees } = require('../src/gtfs/geo');

const FLEET_SIZE = 300;
const POLLS = 6;
const WARMUP_POLLS = 2;
/** Metres each vehicle advances between polls, plus a GPS jitter in metres. */
const STEP_METERS = 120;
const JITTER_METERS = 3;

/**
 * Two answers are a "tie" — not a disagreement — when both are on-route and
 * within a few metres of each other. The full matcher and the fast path can
 * legitimately pick different variants of a line where two of them run the
 * same street in the same direction: the vehicle is exactly on both, the
 * matcher breaks the tie by list order, the fast path by continuity. The fast
 * path must only ever diverge like this, never onto something it is far from.
 */
const TIE_DISTANCE_METERS = 30;

/** A lat/lon (and segment bearing) `alongMeters` into a variant's polyline. */
const pointAt = (variant, alongMeters) => {
  const { points, cumulative } = variant;
  const count = points.length / 2;
  const target = Math.min(Math.max(0, alongMeters), cumulative[cumulative.length - 1]);

  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.min(lo, count - 2);
  const span = cumulative[i + 1] - cumulative[i];
  const t = span > 0 ? (target - cumulative[i]) / span : 0;

  return {
    lat: points[i * 2] + (points[i * 2 + 2] - points[i * 2]) * t,
    lon: points[i * 2 + 1] + (points[i * 2 + 3] - points[i * 2 + 1]) * t,
    bearing: bearingDegrees(
      points[i * 2],
      points[i * 2 + 1],
      points[i * 2 + 2],
      points[i * 2 + 3],
    ),
  };
};

const buildFleet = (store) => {
  const variants = [];
  for (const line of [...store.lines.allTrams, ...store.lines.allBuses]) {
    for (const variant of store.getVariants(line)) {
      if (variant.points.length >= 4 && variant.lengthMeters > 300) variants.push(variant);
    }
  }

  const fleet = [];
  let cursor = 0;
  while (fleet.length < FLEET_SIZE) {
    const variant = variants[cursor % variants.length];
    cursor += 1;
    // Spread each vehicle over the middle of its route, and vary the phase so
    // consecutive fleet members do not march in lockstep.
    const length = variant.lengthMeters;
    const along = length * (0.05 + ((fleet.length * 7919) % 80) / 100);
    const base = pointAt(variant, along);
    fleet.push({
      id: `${variant.line}-${fleet.length}`,
      line: variant.line,
      lat: base.lat,
      lon: base.lon,
      heading: base.bearing,
      variant,
      along,
      lengthMeters: length,
    });
  }
  return fleet;
};

/** Advance one vehicle by `STEP_METERS` along its shape, then jitter it. */
const advance = (vehicle, states) => {
  const forward = vehicle.along + STEP_METERS;
  if (forward >= vehicle.lengthMeters - 1) {
    // Reached the terminus. A real vehicle turns around and runs the opposite
    // variant; the fleet keeps the geometry but a fresh start has no history,
    // so its next describe is a full match. Model that by re-seeding the
    // vehicle and dropping its previous projection state.
    const target = pointAt(vehicle.variant, 0.5);
    vehicle.along = 0.5;
    vehicle.lat = target.lat;
    vehicle.lon = target.lon;
    vehicle.heading = target.bearing;
    if (states) states.delete(vehicle.id);
    return true;
  }
  vehicle.along = forward;

  const point = pointAt(vehicle.variant, vehicle.along);
  // A few metres of perpendicular wobble, like a real GPS fix.
  vehicle.lat = point.lat + (Math.random() - 0.5) * (JITTER_METERS / 111_320);
  vehicle.lon = point.lon + (Math.random() - 0.5) * (JITTER_METERS / 111_320);
  vehicle.heading = point.bearing;
  return false;
};

/**
 * One poll over the fleet.
 *
 * @param {object[]} fleet
 * @param {boolean} useFastPath seed each vehicle with its previous projection
 * @param {Map<string, object|null>} states previous projection state per id
 */
const poll = (fleet, useFastPath, states) => {
  const now = new Date();
  const startedAt = process.hrtime.bigint();
  let misses = 0;
  for (const vehicle of fleet) {
    const previousState = useFastPath ? states.get(vehicle.id) ?? null : null;
    const described = describeVehicle(store, vehicle, { now, limit: 1, previousState });
    states.set(vehicle.id, described?.state ?? null);

    if (useFastPath && previousState?.shapeId) {
      // The fast path is "missed" when the seeded projection did not survive:
      // the vehicle changed shape, landed off route, or its answer jumped
      // beyond the forward window. In this synthetic fleet (no line changes,
      // no turnarounds, always on route) the count should be zero.
      const { state } = described ?? {};
      const beyond =
        state &&
        state.shapeId === previousState.shapeId &&
        Math.abs(state.alongMeters - previousState.alongMeters) > 700;
      if (!state || state.shapeId !== previousState.shapeId || beyond) misses += 1;
    }
  }
  return {
    ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
    misses,
  };
};

const store = new GtfsStore();

const main = async () => {
  const arg = process.argv[2];
  const cacheZip = path.join(require('../src/config').gtfs.cacheDir, 'gtfs.zip');
  const zipPath = arg ?? cacheZip;
  if (!fs.existsSync(zipPath)) {
    console.error(`archive not found: ${zipPath}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(zipPath);

  const buildStartedAt = process.hrtime.bigint();
  await store.build(buffer);
  store.status.state = 'ready';
  console.log(`build: ${(Number(process.hrtime.bigint() - buildStartedAt) / 1e6).toFixed(0)} ms`);
  console.log(`variants available: ${[...store.variantsByLine.values()].reduce((n, l) => n + l.length, 0)}`);

  const fleet = buildFleet(store);
  console.log(`fleet: ${fleet.length} vehicles over ${STEP_METERS} m/poll`);
  const run = (useFastPath) => {
    const states = new Map();
    for (let i = 0; i < WARMUP_POLLS; i += 1) {
      for (const vehicle of fleet) advance(vehicle, states);
      poll(fleet, useFastPath, states);
    }

    let totalMs = 0;
    let misses = 0;
    const perPoll = [];
    for (let i = 0; i < POLLS; i += 1) {
      for (const vehicle of fleet) advance(vehicle, states);
      const result = poll(fleet, useFastPath, states);
      totalMs += result.ms;
      misses += result.misses;
      perPoll.push(result.ms);
    }
    return { avg: totalMs / POLLS, misses, perPoll };
  };

  // Baseline: every vehicle full-matches every poll.
  const baseline = run(false);

  // Fast path: seeded from each vehicle's previous projection.
  const fast = run(true);

  // Differential correctness: one fresh poll, every vehicle described both
  // ways, the answers compared. A mismatch only matters if it is not a tie —
  // the fast path must never be *more* wrong, only cheaper.
  const states = new Map();
  for (const vehicle of fleet) advance(vehicle, states);
  poll(fleet, false, states);
  let identical = 0;
  let tied = 0;
  let disagree = 0;
  let seeded = 0;
  for (const vehicle of fleet) {
    advance(vehicle, states);
    const previous = states.get(vehicle.id) ?? null;
    const full = describeVehicle(store, vehicle, { now: new Date(), limit: 1 });
    const fastDescribe = describeVehicle(store, vehicle, {
      now: new Date(),
      limit: 1,
      previousState: previous,
    });
    if (previous && previous.shapeId) seeded += 1;
    if (JSON.stringify(full) === JSON.stringify(fastDescribe)) {
      identical += 1;
    } else if (
      full?.onRoute &&
      fastDescribe?.onRoute &&
      Math.abs((full.fromRouteMeters ?? Infinity) - (fastDescribe.fromRouteMeters ?? Infinity)) <=
        TIE_DISTANCE_METERS
    ) {
      tied += 1;
    } else {
      disagree += 1;
    }
  }

  console.log('--- full matcher (every poll re-matches the whole line) ---');
  console.log(`  avg ${baseline.avg.toFixed(2)} ms/poll  per-poll [${baseline.perPoll.map((m) => m.toFixed(1)).join(', ')}]`);
  console.log('--- incremental fast path (re-project only around last position) ---');
  console.log(`  avg ${fast.avg.toFixed(2)} ms/poll  per-poll [${fast.perPoll.map((m) => m.toFixed(1)).join(', ')}]`);
  console.log(`  fast-path misses: ${fast.misses} over ${POLLS} polls`);
  console.log(`  speedup ${(baseline.avg / Math.max(fast.avg, 0.001)).toFixed(2)}x`);
  console.log(`--- differential correctness (${seeded}/${fleet.length} vehicles seeded) ---`);
  console.log(`  identical: ${identical}  tied (shared street, both on-route): ${tied}  disagree: ${disagree}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
