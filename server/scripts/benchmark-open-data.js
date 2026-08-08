'use strict';

/* global performance */

/**
 * Micro-benchmark for the Open Data merge hot path.
 *
 * Runs mergeFleet over a synthetic but realistic fleet — a few hundred MPK
 * vehicles clustered along per-line corridors (like trams on a track) plus a
 * few hundred Open Data records — and reports per-iteration wall time and an
 * approximate heap delta. No network, no dependencies.
 *
 * Why there is deliberately no spatial index:
 *
 * The per-poll cost of the merge is a handful of same-line distance checks
 * per Open Data record. At this project's real scale (a few hundred MPK
 * vehicles across a few dozen lines) the whole merge runs in a couple of
 * milliseconds against a ten-second poll interval — the old implementation's
 * waste was the per-record candidate array and the O(n log n) sort, not the
 * raw count of distanceMeters calls. A grid or kd-tree would need to be
 * *built* every poll (the fleet moves), and that build pass costs the same
 * order of magnitude as the naive pass it would accelerate. Only if the
 * fleet ever grew to tens of thousands of vehicles would the simple O(n)
 * pass stop being the right call.
 *
 * Allocation stats are approximate by design: heapUsed deltas between
 * explicit GC runs include V8's own noise, and this script avoids pulling in
 * a profiler dependency. Run with `npm run benchmark:open-data`, which
 * enables --expose-gc so the deltas mean something.
 */

const { mergeFleet } = require('../src/open-data');

const MERGE_OPTIONS = { matchMaxMeters: 250, dedupeMeters: 350, ambiguityMeters: 75 };

/** Deterministic PRNG (mulberry32) so the benchmark is reproducible. */
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randBetween = (rng, lo, hi) => lo + rng() * (hi - lo);

const LINE_NAMES = ['1', '4', '6', '11', '21', 'D', 'K', 'N', 'A', '128', '145', '241'];
const TYPES = ['tram', 'bus', 'busExpress', 'unknown'];

const makeFleet = (rng, lineCount, mpkCount, odCount) => {
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(LINE_NAMES[i % LINE_NAMES.length]);
  }

  // One corridor per line: vehicles bunch around the corridor's anchor.
  const anchor = new Map();
  for (const line of lines) {
    anchor.set(line, { lat: randBetween(rng, 50.9, 51.3), lon: randBetween(rng, 16.8, 17.35) });
  }

  const mpkFleet = new Map();
  const byLine = new Map();
  for (let i = 0; i < mpkCount; i += 1) {
    const line = lines[i % lineCount];
    const a = anchor.get(line);
    const id = `${line}-${i}`;
    const vehicle = {
      id,
      line,
      type: TYPES[i % TYPES.length],
      lat: a.lat + randBetween(rng, -0.003, 0.003),
      lon: a.lon + randBetween(rng, -0.003, 0.003),
      heading: null,
      updatedAt: 0,
    };
    mpkFleet.set(id, vehicle);
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(vehicle);
  }

  const openDataFleet = new Map();
  for (let i = 0; i < odCount; i += 1) {
    const line = lines[i % lineCount];
    const a = anchor.get(line);
    const lineVehicles = byLine.get(line);
    const r = rng();
    let lat;
    let lon;
    if (r < 0.5) {
      // On a real vehicle — the common merge case.
      const vehicle = lineVehicles[Math.floor(rng() * lineVehicles.length)];
      lat = vehicle.lat;
      lon = vehicle.lon;
    } else if (r < 0.7) {
      // Offset north of a real vehicle — straddles the merge/dedupe boundary.
      const vehicle = lineVehicles[Math.floor(rng() * lineVehicles.length)];
      const meters = [100, 250, 251, 349, 350, 351, 500, 800][Math.floor(rng() * 8)];
      lat = vehicle.lat + meters / 111_320;
      lon = vehicle.lon;
    } else {
      lat = a.lat + randBetween(rng, -0.008, 0.008);
      lon = a.lon + randBetween(rng, -0.008, 0.008);
    }
    const id = `open-data:${i}`;
    openDataFleet.set(id, {
      id,
      line,
      type: TYPES[i % TYPES.length],
      lat,
      lon,
      vehicleNumber: 1000 + i,
      brigade: '1',
      positionUpdatedAt: new Date(0).toISOString(),
      updatedAt: 0,
    });
  }

  return { mpkFleet, openDataFleet };
};

const main = () => {
  const rng = mulberry32(20260808);
  const lineCount = 60;
  const mpkCount = 600;
  const odCount = 400;
  const iterations = 100;

  const { mpkFleet, openDataFleet } = makeFleet(rng, lineCount, mpkCount, odCount);
  const distinctLines = new Set([...mpkFleet.values()].map((v) => v.line)).size;

  // Warm-up: JIT, and let the fleet reach a steady state.
  mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);
  mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);

  const gc = typeof global.gc === 'function' ? global.gc : null;
  if (gc) gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);
  }
  const elapsed = performance.now() - start;

  let heapDeltaBytes = null;
  if (gc) {
    gc();
    heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  }

  const totalMpk = mpkFleet.size;
  const totalOd = openDataFleet.size;
  const perIteration = elapsed / iterations;

  console.log('mergeFleet benchmark (single-pass implementation)');
  console.log(`  fleet:           ${totalMpk} MPK vehicles across ${distinctLines} lines, ${totalOd} Open Data records`);
  console.log(`  iterations:      ${iterations}`);
  console.log(`  total:           ${elapsed.toFixed(1)} ms`);
  console.log(`  per iteration:   ${perIteration.toFixed(3)} ms (${(totalOd / (perIteration / 1000)).toFixed(0)} records/s)`);
  if (heapDeltaBytes === null) {
    console.log('  heap delta:      skipped (run `npm run benchmark:open-data` for --expose-gc)');
  } else {
    const sign = heapDeltaBytes >= 0 ? '+' : '-';
    console.log(`  heap delta:      ${sign}${(Math.abs(heapDeltaBytes) / 1024).toFixed(1)} KiB per ${iterations} iterations`);
  }
};

main();
