#!/usr/bin/env node
'use strict';

/* global performance */

/**
 * Micro-benchmark for the Open Data merge hot path.
 *
 * Compares the pre-optimization reference implementation (filter/map/sort per
 * Open Data record) against the current one-pass implementation, across several
 * realistic fleet sizes. No network, no dependencies.
 *
 * Run with `npm run benchmark:open-data`, which enables --expose-gc so heap
 * deltas mean something.
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
 * a profiler dependency.
 */

const { mergeFleet } = require('../src/open-data');
const { distanceMeters } = require('../src/gtfs/geo');

const MERGE_OPTIONS = { matchMaxMeters: 250, dedupeMeters: 350, ambiguityMeters: 75 };

// ---------------------------------------------------------------------------
// Reference implementation (frozen in time).
//
// This is the pre-optimization version: for every Open Data record it builds a
// candidate array of same-line, same-type MPK vehicles, maps each to a distance,
// and sorts that array to find the nearest two. Deliberately duplicated here
// (not imported from tests) so the benchmark stays a standalone script.
// ---------------------------------------------------------------------------

const mergeFleetReference = (mpkFleet, openDataFleet, { matchMaxMeters, dedupeMeters, ambiguityMeters }) => {
  const fleet = new Map();
  for (const [id, vehicle] of mpkFleet) {
    fleet.set(id, { ...vehicle, source: 'mpk' });
  }

  const byLine = new Map();
  for (const vehicle of mpkFleet.values()) {
    if (!byLine.has(vehicle.line)) byLine.set(vehicle.line, []);
    byLine.get(vehicle.line).push(vehicle);
  }

  const used = new Set();

  for (const od of openDataFleet.values()) {
    const candidates = (byLine.get(od.line) ?? [])
      .filter((mpk) => mpk.type === od.type)
      .map((mpk) => ({ mpk, meters: distanceMeters(mpk.lat, mpk.lon, od.lat, od.lon) }))
      .sort((a, b) => a.meters - b.meters);

    const nearest = candidates[0];
    let matched = null;

    if (nearest && nearest.meters <= matchMaxMeters && !used.has(nearest.mpk.id)) {
      const second = candidates[1];
      const ambiguous =
        second &&
        second.meters <= matchMaxMeters &&
        second.meters - nearest.meters < ambiguityMeters;
      if (!ambiguous) matched = nearest.mpk;
    }

    if (matched) {
      used.add(matched.id);
      const entry = fleet.get(matched.id);
      entry.source = 'merged';
      entry.vehicleNumber = od.vehicleNumber;
      entry.brigade = od.brigade;
      entry.positionUpdatedAt = od.positionUpdatedAt;
      continue;
    }

    const nearMpk = (byLine.get(od.line) ?? []).some(
      (mpk) => distanceMeters(mpk.lat, mpk.lon, od.lat, od.lon) <= dedupeMeters,
    );
    if (nearMpk) continue;

    fleet.set(od.id, {
      id: od.id,
      line: od.line,
      type: od.type,
      lat: od.lat,
      lon: od.lon,
      heading: null,
      vehicleNumber: od.vehicleNumber,
      brigade: od.brigade,
      positionUpdatedAt: od.positionUpdatedAt,
      source: 'open-data',
      updatedAt: od.updatedAt,
    });
  }

  const stats = { mpk: 0, merged: 0, openData: 0, total: fleet.size, activeLines: 0 };
  const lines = new Set();
  for (const vehicle of fleet.values()) {
    lines.add(vehicle.line);
    if (vehicle.source === 'merged') stats.merged += 1;
    else if (vehicle.source === 'open-data') stats.openData += 1;
    else stats.mpk += 1;
  }
  stats.activeLines = lines.size;

  return { fleet, stats };
};

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

/**
 * Time a function over N iterations of the same fleet pair, returning the
 * total milliseconds and per-iteration average.
 */
const timeRun = (label, fn, iterations) => {
  // Warm-up: JIT and let V8 optimize both paths before measuring.
  fn();
  fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const elapsed = performance.now() - start;

  return { label, elapsed, perIteration: elapsed / iterations, iterations };
};

/** Sanity-check that the reference and optimized produce identical results. */
const assertSameFleet = (actual, expected, message) => {
  if (actual.size !== expected.size) {
    throw new Error(`${message}: size ${actual.size} !== ${expected.size}`);
  }
  const actualKeys = [...actual.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  for (let i = 0; i < actualKeys.length; i += 1) {
    if (actualKeys[i] !== expectedKeys[i]) {
      throw new Error(`${message}: key mismatch at ${i}`);
    }
  }
  for (const key of actualKeys) {
    const a = actual.get(key);
    const e = expected.get(key);
    if (JSON.stringify(a) !== JSON.stringify(e)) {
      throw new Error(`${message}: vehicle ${key} differs`);
    }
  }
};

const main = () => {
  const gc = typeof global.gc === 'function' ? global.gc : null;

  const configurations = [
    { label: 'small', mpk: 50, od: 20, lineCount: 6, iterations: 1000 },
    { label: 'typical', mpk: 250, od: 100, lineCount: 12, iterations: 200 },
    { label: 'heavy', mpk: 700, od: 300, lineCount: 24, iterations: 50 },
  ];

  console.log('Open Data merge: reference (filter/map/sort) vs optimized (one-pass)');
  console.log();

  for (const { label, mpk: mpkCount, od: odCount, lineCount, iterations } of configurations) {
    const rng = mulberry32(20260808);
    const { mpkFleet, openDataFleet } = makeFleet(rng, lineCount, mpkCount, odCount);

    // Correctness check: both implementations must agree.
    const ref = mergeFleetReference(mpkFleet, openDataFleet, MERGE_OPTIONS);
    const opt = mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);
    assertSameFleet(opt.fleet, ref.fleet, `${label}: fleet mismatch`);
    if (JSON.stringify(opt.stats) !== JSON.stringify(ref.stats)) {
      throw new Error(`${label}: stats mismatch ${JSON.stringify(opt.stats)} !== ${JSON.stringify(ref.stats)}`);
    }

    // Heap delta: measure only the difference in allocations between runs.
    if (gc) gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const refResult = timeRun('reference', () => mergeFleetReference(mpkFleet, openDataFleet, MERGE_OPTIONS), iterations);
    const optResult = timeRun('optimized', () => mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS), iterations);

    let heapDeltaBytes = null;
    if (gc) {
      gc();
      heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    }

    const speedup = refResult.elapsed / optResult.elapsed;

    console.log(`${label.toUpperCase()}: MPK=${mpkCount}, OpenData=${odCount} (${iterations} iterations)`);
    console.log();
    console.log(`  REFERENCE:   old filter/map/sort implementation`);
    console.log(`  reference:   ${refResult.elapsed.toFixed(1)} ms total, ${refResult.perIteration.toFixed(3)} ms/iter`);
    console.log();
    console.log(`  OPTIMIZED:   new one-pass implementation`);
    console.log(`  optimized:   ${optResult.elapsed.toFixed(1)} ms total, ${optResult.perIteration.toFixed(3)} ms/iter`);
    console.log(`  speedup:     ${speedup.toFixed(1)}x`);
    if (heapDeltaBytes !== null) {
      const sign = heapDeltaBytes >= 0 ? '+' : '-';
      console.log(`  heap delta:  ${sign}${(Math.abs(heapDeltaBytes) / 1024).toFixed(1)} KiB`);
    } else {
      console.log('  heap delta:  skipped (run with --expose-gc for allocation stats)');
    }
    console.log();
  }
};

main();
