'use strict';

/**
 * GTFS ingest memory/time benchmark.
 *
 * Builds the store from a real Wrocław archive (the GTFS cache by default) and
 * reports peak RSS / heapUsed / external / arrayBuffers during the build,
 * wall-clock build time, and steady-state memory afterwards.
 *
 * Usage:
 *   node scripts/benchmark-gtfs.js                # use the configured GTFS cache
 *   node scripts/benchmark-gtfs.js /path/file.zip # use a specific archive
 *
 * The sampler runs on a timer while the build awaits the streaming parsers,
 * which yield every 64k rows, so a build is sampled tens of thousands of times
 * and the reported peaks are within a handful of MB of the true ones.
 */

const fs = require('node:fs');
const path = require('node:path');

const { GtfsStore } = require('../src/gtfs/store');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Global GC if Node was started with --expose-gc. */
const gc = () => {
  if (global.gc) {
    global.gc();
    global.gc();
  }
};

const sample = () => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers ?? 0,
  };
};

const main = async () => {
  const arg = process.argv[2];
  const cacheZip = path.join(require('../src/config').gtfs.cacheDir, 'gtfs.zip');
  const zipPath = arg ?? cacheZip;
  if (!fs.existsSync(zipPath)) {
    console.error(`archive not found: ${zipPath}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(zipPath);

  gc();
  const baseline = sample();

  const store = new GtfsStore();
  const peak = { ...baseline };
  const peakAt = {};
  const sampler = setInterval(() => {
    const current = sample();
    for (const key of Object.keys(current)) {
      if (current[key] > peak[key]) {
        peak[key] = current[key];
        peakAt[key] = process.hrtime.bigint();
      }
    }
  }, 2);

  const startedAt = process.hrtime.bigint();
  await store.build(buffer);
  const buildMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  clearInterval(sampler);
  await sleep(100);
  gc();
  const steady = sample();

  const mb = (bytes) => (bytes / 1e6).toFixed(1);
  const delta = (now, before) => (now - before) / 1e6;
  const atMs = (bigint) => (Number(bigint - startedAt) / 1e6).toFixed(0);

  console.log(`archive: ${path.basename(zipPath)} (${(buffer.length / 1e6).toFixed(1)} MB)`);
  console.log(`build time: ${buildMs.toFixed(0)} ms`);
  console.log(`counts: ${JSON.stringify(store.status.counts)}`);
  console.log('--- peak (during build) ---');
  console.log(`  rss         ${mb(peak.rss)} MB (${delta(peak.rss, baseline.rss).toFixed(1)} over baseline, at ${atMs(peakAt.rss)} ms)`);
  console.log(`  heapUsed    ${mb(peak.heapUsed)} MB (${delta(peak.heapUsed, baseline.heapUsed).toFixed(1)} over baseline, at ${atMs(peakAt.heapUsed)} ms)`);
  console.log(`  external    ${mb(peak.external)} MB (at ${atMs(peakAt.external)} ms)`);
  console.log(`  arrayBuffers ${mb(peak.arrayBuffers)} MB (at ${atMs(peakAt.arrayBuffers)} ms)`);
  console.log('--- steady state (post-build, post-GC) ---');
  console.log(`  rss         ${mb(steady.rss)} MB`);
  console.log(`  heapUsed    ${mb(steady.heapUsed)} MB`);
  console.log(`  external    ${mb(steady.external)} MB`);
  console.log(`  arrayBuffers ${mb(steady.arrayBuffers)} MB`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
