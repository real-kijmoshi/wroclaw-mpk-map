'use strict';

/**
 * /vehicle/:id load test: the O(n) scan + full re-match vs the O(1) id lookup
 * plus a bounded position-fingerprinted detail cache.
 *
 * Models the handler exactly. A "batch" is one poll interval during which many
 * clients tap vehicles: ~4000 requests skewed towards a small set of popular
 * vehicles, exactly the pattern a live map produces when riders open a stop
 * board. Between batches the fleet advances ~120 m, so a cached detail for a
 * moved vehicle is detected and recomputed.
 *
 * Baseline: `snapshot.locations.find(id)` and `describeVehicle` from scratch on
 * every request (what production ran before AGENT 8). Cached: a Map lookup
 * plus the LruCache keyed by id|limit|history and invalidated by position,
 * with the full describe seeded by the tracker's last projection state.
 *
 * Usage:
 *   node scripts/benchmark-vehicle-detail.js                # configured GTFS cache
 *   node scripts/benchmark-vehicle-detail.js /path/file.zip # a specific archive
 */

const fs = require('node:fs');
const path = require('node:path');

const { GtfsStore } = require('../src/gtfs/store');
const { describeVehicle } = require('../src/progress');
const { bearingDegrees } = require('../src/gtfs/geo');

const FLEET_SIZE = 400;
/** Requests per poll interval, skewed towards a few vehicles. */
const REQUESTS_PER_BATCH = 4_000;
const MEASURED_BATCHES = 5;
const WARMUP_BATCHES = 2;
/** Share of the fleet that is "popular" (tapped by most requests). */
const POPULAR_FRACTION = 0.1;
/** Share of requests aimed at popular vehicles. */
const POPULAR_REQUEST_SHARE = 0.75;
/** Capacity of the modelled detail cache, matching config's default. */
const DETAIL_CACHE_ENTRIES = 512;
const STEP_METERS = 120;
const JITTER_METERS = 3;

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
    const target = pointAt(vehicle.variant, 0.5);
    vehicle.along = 0.5;
    vehicle.lat = target.lat;
    vehicle.lon = target.lon;
    vehicle.heading = target.bearing;
    if (states) states.delete(vehicle.id);
    return;
  }
  vehicle.along = forward;
  const point = pointAt(vehicle.variant, vehicle.along);
  vehicle.lat = point.lat + (Math.random() - 0.5) * (JITTER_METERS / 111_320);
  vehicle.lon = point.lon + (Math.random() - 0.5) * (JITTER_METERS / 111_320);
  vehicle.heading = point.bearing;
};

/**
 * Simulate `REQUESTS_PER_BATCH` /vehicle/:id requests per poll interval.
 *
 * @param {object[]} fleet
 * @param {object[]} popular subset of the fleet that requests cluster on
 * @param {boolean} useCache O(1) id map + detail cache instead of the scan
 */
const simulate = (fleet, popular, useCache) => {
  const byId = new Map(fleet.map((vehicle) => [vehicle.id, vehicle]));
  const detailCache = new Map();
  const describeStates = new Map();
  let hits = 0;
  let misses = 0;

  const batches = WARMUP_BATCHES + MEASURED_BATCHES;
  let totalMs = 0;
  const perBatch = [];
  for (let batch = 0; batch < batches; batch += 1) {
    if (batch > 0) for (const vehicle of fleet) advance(vehicle, describeStates);

    const startedAt = process.hrtime.bigint();
    for (let request = 0; request < REQUESTS_PER_BATCH; request += 1) {
      const hot = Math.random() < POPULAR_REQUEST_SHARE;
      const vehicle = hot
        ? popular[Math.floor(Math.random() * popular.length)]
        : fleet[Math.floor(Math.random() * fleet.length)];
      if (!vehicle) continue;

      const id = vehicle.id;
      // AGENT 8 replaces this with byId.get(id): a scan that is the same
      // length as the fleet on every request.
      const found = useCache ? byId.get(id) : fleet.find((entry) => entry.id === id);
      if (!found) continue;

      const key = `${id}|40|2`;
      const cached = useCache ? detailCache.get(key) : undefined;
      if (
        cached &&
        cached.lat === found.lat &&
        cached.lon === found.lon &&
        cached.heading === found.heading
      ) {
        hits += 1;
        continue;
      }
      misses += 1;

      const previousState = useCache ? describeStates.get(id) ?? null : null;
      const trip = describeVehicle(store, found, {
        now: new Date(),
        limit: 40,
        history: 2,
        previousState,
      });
      if (useCache) {
        if (detailCache.size >= DETAIL_CACHE_ENTRIES) {
          detailCache.delete(detailCache.keys().next().value);
        }
        detailCache.set(key, {
          lat: found.lat,
          lon: found.lon,
          heading: found.heading ?? null,
          trip,
        });
      }
    }
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (batch >= WARMUP_BATCHES) {
      totalMs += ms;
      perBatch.push(ms);
    }
  }

  const requests = MEASURED_BATCHES * REQUESTS_PER_BATCH;
  return {
    avgMs: totalMs / MEASURED_BATCHES,
    msPerRequest: totalMs / requests,
    hits,
    misses,
    hitRate: hits / Math.max(hits + misses, 1),
    perBatch,
    detailCacheSize: detailCache.size,
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

  const fleet = buildFleet(store);
  const popular = fleet.filter((_, i) => i % Math.round(1 / POPULAR_FRACTION) === 0);
  console.log(
    `fleet: ${fleet.length} vehicles, ${popular.length} popular, ${REQUESTS_PER_BATCH} requests/poll interval`,
  );

  const before = simulate(fleet, popular, false);
  const after = simulate(fleet, popular, true);

  console.log('--- /vehicle/:id load (baseline: scan + full re-match every request) ---');
  console.log(
    `  avg ${before.avgMs.toFixed(0)} ms/batch  per-batch [${before.perBatch.map((m) => m.toFixed(0)).join(', ')}]`,
  );
  console.log(`  ${before.msPerRequest.toFixed(4)} ms/request`);
  console.log('--- /vehicle/:id load (O(1) id map + bounded detail cache) ---');
  console.log(
    `  avg ${after.avgMs.toFixed(0)} ms/batch  per-batch [${after.perBatch.map((m) => m.toFixed(0)).join(', ')}]`,
  );
  console.log(
    `  ${after.msPerRequest.toFixed(4)} ms/request  cache hits ${after.hits} / misses ${after.misses} (${(after.hitRate * 100).toFixed(0)}%)`,
  );
  console.log(`  speedup ${(before.avgMs / Math.max(after.avgMs, 0.001)).toFixed(2)}x`);
  console.log(`  detail cache: ${after.detailCacheSize}/${DETAIL_CACHE_ENTRIES} entries (bounded)`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
