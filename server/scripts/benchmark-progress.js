#!/usr/bin/env node
'use strict';

/**
 * Timing microbenchmark for matchTrip: the linear scan over every run of a
 * shape vs the binary search over the sorted tripStart array.
 *
 * Not part of `npm test` (CI stays offline and fast) and touches no network —
 * the schedule is synthesised here. Run it with `npm run benchmark:progress`.
 */

const { performance } = require('node:perf_hooks');

const { matchTrip } = require('../src/progress');
const { inWarsaw } = require('../src/gtfs/parse');

const DAY_SECONDS = 86_400;
const MAX_DELAY_SECONDS = 45 * 60;
const secondsOfDay = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

// The pre-binary-search scan, copied verbatim so the two can be timed against
// each other. It is the reference the differential tests pin the new code to.
const matchTripLinear = (gtfs, variant, progressOffset, now) => {
  const local = inWarsaw(now);
  const yesterday = new Date(local);
  yesterday.setDate(yesterday.getDate() - 1);

  const frames = [
    { seconds: secondsOfDay(local), date: local, label: 'today' },
    { seconds: secondsOfDay(local) + DAY_SECONDS, date: yesterday, label: 'yesterday' },
  ];

  let best = null;
  for (const frame of frames) {
    for (const tripIndex of variant.trips) {
      const start = gtfs.tripStart[tripIndex];
      if (start < 0) continue;

      const delaySeconds = frame.seconds - (start + progressOffset);
      if (Math.abs(delaySeconds) > MAX_DELAY_SECONDS) continue;
      if (best && Math.abs(delaySeconds) >= Math.abs(best.delaySeconds)) continue;

      const trip = gtfs.trips[tripIndex];
      if (!gtfs.isServiceActive(trip.serviceId, frame.date)) continue;

      best = { trip, start, delaySeconds: Math.round(delaySeconds), serviceDay: frame.label };
    }
  }

  return best;
};

// Lays the schedule out the way store.js does: trips addressed by index,
// tripStart as the parallel Int32Array, variant.trips holding the indices
// sorted by tripStart.
const makeVariant = (starts) => {
  const trips = starts.map((_, index) => ({ id: `t${index}`, serviceId: `s${index}` }));
  const indices = starts
    .map((start, index) => ({ start, index }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map(({ index }) => index);

  return {
    gtfs: {
      tripStart: Int32Array.from(starts),
      trips,
      isServiceActive: () => true,
    },
    variant: { trips: Int32Array.from(indices) },
  };
};

const randomNow = () => {
  const h = Math.floor(Math.random() * 24);
  const m = Math.floor(Math.random() * 60);
  const s = Math.floor(Math.random() * 60);
  return new Date(
    `2026-06-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+02:00`,
  );
};

const resultOf = (best) =>
  best === null
    ? null
    : { tripId: best.trip.id, start: best.start, delaySeconds: best.delaySeconds, serviceDay: best.serviceDay };

const benchmark = (starts, { label, lookups: lookupCount }) => {
  const { gtfs, variant } = makeVariant(starts);
  const lookups = Array.from({ length: lookupCount }, () => ({
    now: randomNow(),
    progressOffset: Math.random() * 7200,
  }));

  // Sanity first: the two must agree on the sampled positions, or the numbers
  // below are measuring a regression.
  for (const { now, progressOffset } of lookups) {
    const old = resultOf(matchTripLinear(gtfs, variant, progressOffset, now));
    const fresh = resultOf(matchTrip(gtfs, variant, progressOffset, now));
    if (JSON.stringify(old) !== JSON.stringify(fresh)) {
      throw new Error(`mismatch at now=${now} progressOffset=${progressOffset}: ${JSON.stringify({ old, fresh })}`);
    }
  }

  // Warm both paths so JIT and the date formatter are not measured.
  for (const { now, progressOffset } of lookups.slice(0, 500)) {
    matchTripLinear(gtfs, variant, progressOffset, now);
    matchTrip(gtfs, variant, progressOffset, now);
  }

  const linearStart = performance.now();
  for (const { now, progressOffset } of lookups) matchTripLinear(gtfs, variant, progressOffset, now);
  const linearMs = performance.now() - linearStart;

  const binaryStart = performance.now();
  for (const { now, progressOffset } of lookups) matchTrip(gtfs, variant, progressOffset, now);
  const binaryMs = performance.now() - binaryStart;

  const linearPer10k = (linearMs / lookupCount) * 10_000;
  const binaryPer10k = (binaryMs / lookupCount) * 10_000;
  const speedup = linearMs / binaryMs;
  const linearOps = (lookupCount / linearMs) * 1000;
  const binaryOps = (lookupCount / binaryMs) * 1000;

  console.log(
    `${String(label).padEnd(22)} ${String(starts.length).padStart(8)} trips  ` +
      `${String(lookupCount).padStart(7)} lookups  ` +
      `linear ${linearMs.toFixed(1)} ms (${linearOps.toFixed(0)}/s, ${linearPer10k.toFixed(2)} ms/10k)  ` +
      `binary ${binaryMs.toFixed(1)} ms (${binaryOps.toFixed(0)}/s, ${binaryPer10k.toFixed(2)} ms/10k)  ` +
      `${speedup.toFixed(1)}x faster`,
  );
};

console.log('matchTrip: linear scan vs binary search (identical results verified on every run)');
console.log();

// Uniform starts across the service day, the way a busy route looks.
const denseDay = Array.from({ length: 50_000 }, (_, i) => (i * 1.7) % 90_000);
benchmark(denseDay, { label: 'dense day', lookups: 10_000 });

// Sparse, night-line-like: a departure every few minutes.
const sparse = Array.from({ length: 5_000 }, (_, i) => 30_000 + i * 12);
benchmark(sparse, { label: 'sparse', lookups: 10_000 });

// A realistic single shape: ~60 runs a day.
const line = Array.from({ length: 60 }, (_, i) => 18_000 + i * 600);
benchmark(line, { label: 'one line', lookups: 50_000 });

// Random positions scattered over 24h including the overnight overlap.
const randomStarts = Array.from({ length: 20_000 }, () => Math.floor(Math.random() * 110_000));
benchmark(randomStarts, { label: 'random', lookups: 1_000 });
