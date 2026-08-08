'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { buildFixtureZip } = require('./fixtures/gtfs');

const fixtureA = buildFixtureZip();
const fixtureB = buildFixtureZip({
  shapesText: [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    's4a,52.00000,18.00000,1',
    's4a,52.00100,18.00100,2',
    's4a,52.00200,18.00200,3',
    's4a,52.00300,18.00300,4',
    's4b,52.00300,18.00300,1',
    's4b,52.00200,18.00200,2',
    's4b,52.00100,18.00100,3',
    's128,52.00000,18.00000,1',
    's128,51.99900,17.99900,2',
    's128,51.99800,17.99800,3',
    'sn1,52.00000,18.00000,1',
    'sn1,51.99800,17.99800,2',
  ].join('\n'),
});

/** Mirrors downloadGtfs: validate the buffer, then hand back an archive. */
const archiveOf = (buffer) =>
  async ({ validate }) => {
    validate?.(buffer);
    return { buffer, source: 'test', snapshot: 'snap', fetchedAt: new Date().toISOString(), fromCache: false };
  };

const failingDownload = async () => {
  throw new Error('network down');
};

/** Build a store up to a healthy generation-N snapshot from `fixture`. */
const buildToGeneration = async (fixture = fixtureA) => {
  const store = new GtfsStore({ downloader: archiveOf(fixture) });
  await store.refresh();
  return store;
};

/**
 * Start a refresh toward `fixture` but park `build()` before it can commit, so
 * the candidate is constructed in isolation and never reaches #commit until the
 * caller releases. Returns the in-flight promise and a `release()` helper.
 */
const pauseRefresh = (store, fixture) => {
  const gate = new Promise((resolve) => (store._releaseBuild = resolve));
  const realBuild = store.build.bind(store);
  store.build = async (buffer) => {
    await gate;
    return realBuild(buffer);
  };
  store.downloader = archiveOf(fixture);
  const pending = store.refresh();
  return {
    pending,
    release: async () => {
      store._releaseBuild();
      return pending;
    },
  };
};

describe('atomic GTFS refresh', () => {
  it('successful initial load serves the timetable and is not ready until done', async () => {
    const store = new GtfsStore({ downloader: archiveOf(fixtureA) });
    // Before the first usable feed exists: isReady === false. GTFS-dependent
    // endpoints may return 503 (see the boot test).
    assert.equal(store.generation, 0);
    assert.equal(store.isReady, false);

    await store.refresh();

    assert.equal(store.isReady, true);
    assert.equal(store.generation, 1, 'generation bumped once on success');
    assert.equal(store.status.refreshing, false);
    assert.equal(store.status.error, null);
    assert.equal(store.getVariants('4').length, 2, 'both directions loaded');
  });

  it('overlapping refresh calls share a single in-flight refresh', async () => {
    const store = await buildToGeneration();
    const { pending, release } = pauseRefresh(store, fixtureB);
    // A second call while one is already in flight must reuse the same promise
    // instead of racing through download + build again.
    assert.equal(store.refresh(), pending, 'returns the in-flight promise');
    await release();
    assert.equal(store.generation, 2);
  });

  it('keeps isReady true and serves only the old snapshot while a refresh is in flight', async () => {
    const store = await buildToGeneration();
    const gen1Variant = store.getVariants('4')[0];
    const gen1Route = store.routesByLine.get('4');
    const gen1Stop = store.getStop('1');

    const { release } = pauseRefresh(store, fixtureB);
    // Let the download resolve and build() enter its pause — the candidate is
    // built in a local state and has not reached #commit yet.
    await new Promise((resolve) => setImmediate(resolve));

    // isReady must not dip: a valid snapshot exists, so state stays 'ready'.
    assert.equal(store.status.refreshing, true, 'refresh is in progress');
    assert.equal(store.isReady, true, 'isReady never dips while a snapshot exists');
    assert.equal(store.status.state, 'ready');
    // Generation is bumped only on commit, so it has not moved yet.
    assert.equal(store.generation, 1, 'generation held until commit');

    // No mixing of old and new: routes, stops and shapes all still reference the
    // gen-1 objects, because the candidate has not been swapped in.
    assert.equal(store.getVariants('4')[0], gen1Variant, 'old geometry');
    assert.equal(store.routesByLine.get('4'), gen1Route, 'old routes');
    assert.equal(store.getStop('1'), gen1Stop, 'old stops');

    await release();
    assert.equal(store.status.refreshing, false);
  });

  it('a successful refresh swaps every index together and bumps generation once', async () => {
    const store = await buildToGeneration();
    const gen1Variant = store.getVariants('4')[0];
    const gen1Route = store.routesByLine.get('4');
    const gen1Stop = store.getStop('1');
    assert.equal(store.generation, 1);

    const { release } = pauseRefresh(store, fixtureB);
    assert.equal(store.generation, 1, 'not yet committed');
    // Still the old snapshot while the candidate builds.
    assert.equal(store.getVariants('4')[0], gen1Variant);

    await release();

    // Everything swaps in one step — no index is left behind or half-rebuilt.
    assert.equal(store.generation, 2, 'generation bumped exactly once, on commit');
    assert.notEqual(store.getVariants('4')[0], gen1Variant, 'shapes swapped');
    assert.notEqual(store.routesByLine.get('4'), gen1Route, 'routes swapped');
    assert.notEqual(store.getStop('1'), gen1Stop, 'stops swapped');
    // ...and the swap carries the new timetable, not the old geometry.
    assert.equal(store.getVariants('4')[0].points[0], 52.0, 'new shape geometry');
    assert.equal(store.getVariants('4')[0].points[1], 18.0, 'new shape geometry');
  });

  it('a failed download keeps the previous dataset and does not bump generation', async () => {
    const store = await buildToGeneration();
    const gen1Variant = store.getVariants('4')[0];
    const gen1Generation = store.generation;
    store.downloader = failingDownload;

    await assert.rejects(() => store.refresh(), /network down/);
    assert.equal(store.generation, gen1Generation, 'generation not bumped on failure');
    assert.equal(store.isReady, true, 'still ready on the old snapshot');
    assert.equal(store.status.refreshing, false);
    assert.equal(store.status.error, 'network down');
    // The old snapshot is fully intact, down to the object identity.
    assert.equal(store.getVariants('4')[0], gen1Variant, 'old geometry intact');
  });

  it('an invalid zip keeps the previous dataset and does not bump generation', async () => {
    const store = await buildToGeneration();
    const gen1Variant = store.getVariants('4')[0];
    const gen1Generation = store.generation;
    // The downloader validates exactly like downloadGtfs does; a corrupt
    // archive is rejected before any index work starts.
    store.downloader = archiveOf(Buffer.from('this is not a zip file'));

    await assert.rejects(() => store.refresh(), /invalid or unsupported zip/i);
    assert.equal(store.generation, gen1Generation, 'generation not bumped');
    assert.equal(store.isReady, true, 'old snapshot still served');
    assert.equal(store.getVariants('4')[0], gen1Variant, 'old geometry intact');
  });

  it('a crash during the build keeps the previous dataset and does not bump generation', async () => {
    const store = await buildToGeneration();
    const gen1Variant = store.getVariants('4')[0];
    const gen1Route = store.routesByLine.get('4');
    const gen1Stop = store.getStop('1');
    const gen1Generation = store.generation;

    // Download succeeds (the candidate is well-formed); a failure inside a build
    // stage must still not reach #commit, so the live store is untouched.
    store.build = async () => {
      throw new Error('stop_times index crashed partway');
    };
    store.downloader = archiveOf(fixtureB);

    await assert.rejects(() => store.refresh(), /stop_times index crashed/);
    assert.equal(store.generation, gen1Generation, 'generation not bumped on build failure');
    assert.equal(store.isReady, true, 'still ready');
    assert.equal(store.status.refreshing, false);
    // The previous snapshot — routes, stops AND shapes — is wholly preserved.
    assert.equal(store.getVariants('4')[0], gen1Variant, 'old geometry intact');
    assert.equal(store.routesByLine.get('4'), gen1Route, 'old routes intact');
    assert.equal(store.getStop('1'), gen1Stop, 'old stops intact');
  });

  it('a failed refresh on a cold boot leaves the store not ready', async () => {
    const store = new GtfsStore({ downloader: failingDownload });
    assert.equal(store.isReady, false);
    await assert.rejects(() => store.refresh(), /network down/);
    assert.equal(store.isReady, false, 'no snapshot ever arrived');
    assert.equal(store.status.state, 'failed');
    assert.equal(store.generation, 0, 'no generation without a snapshot');
  });
});
