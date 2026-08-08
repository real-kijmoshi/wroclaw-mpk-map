'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { shapeCache } = require('../src/routes');
const { buildFixtureZip } = require('./fixtures/gtfs');

const fixtureA = buildFixtureZip();
// The same timetable with shifted shape geometry — same shape ids, so variant
// selection is stable, but the drawn points differ, which proves a refreshed
// generation is not served the old cached shape.
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

const fakeVehicles = {
  status: { source: 'test', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 2 },
  openDataStatus: {
    source: 'https://open-data.cui.wroclaw.pl/hdb/db/14?download=json',
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    count: 0,
  },
  stats: { mpk: 1, merged: 1, openData: 0, total: 2, activeLines: 2 },
  snapshot: { locations: [], count: 0, lastUpdated: null, source: 'test', stale: false },
  getVehicle: () => null,
  describeCache: new Map(),
  performanceSnapshot: () => ({}),
};
const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 1 },
  getAlerts: () => [],
};

/** Start a fresh app against a store, returning a fetch helper and a closer. */
const withApp = async (store) => {
  shapeCache.clear();
  const app = createApp({ gtfs: store, vehicles: fakeVehicles, alerts: fakeAlerts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    const ct = response.headers.get('content-type') || '';
    const body = ct.includes('json') ? await response.json() : await response.text();
    return { status: response.status, body };
  };
  return {
    get,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

/** Count getBestVariant calls — it runs only on a shape cache miss. */
const countShapeMisses = (store) => {
  const counter = { calls: 0 };
  const real = store.getBestVariant.bind(store);
  store.getBestVariant = (...args) => {
    counter.calls += 1;
    return real(...args);
  };
  return counter;
};

const load = async (store, fixture) => {
  await store.build(fixture);
  store.status.state = 'ready';
};

describe('shape cache is bound to the GTFS generation', () => {
  it('serves a repeated request from the cache within a generation', async () => {
    const store = new GtfsStore();
    const spy = countShapeMisses(store);
    const app = await withApp(store);
    await load(store, fixtureA);

    const first = await app.get('/shapes/4?format=compact');
    assert.equal(first.status, 200);
    assert.equal(spy.calls, 1, 'first request computes the shape');

    const second = await app.get('/shapes/4?format=compact');
    assert.equal(spy.calls, 1, 'second request is served from cache');
    assert.deepEqual(second.body, first.body, 'an unchanged request is answered verbatim');
    assert.equal(shapeCache.size, 1);

    await app.stop();
  });

  it('serves fresh geometry after a refresh and never the old cached shape', async () => {
    const store = new GtfsStore();
    const spy = countShapeMisses(store);
    const app = await withApp(store);
    await load(store, fixtureA);

    const first = await app.get('/shapes/4?format=compact');
    assert.deepEqual(first.body.points[0], [51.11, 17.032], 'fixtureA s4a first point');

    // build() commits a new generation atomically; the old cache entry (keyed
    // on generation 1) is now unreachable, so the next request recomputes.
    await load(store, fixtureB);
    assert.equal(store.generation, 2, 'generation advanced on the swap');

    const second = await app.get('/shapes/4?format=compact');
    assert.equal(spy.calls, 2, 'the new generation misses the stale cache key');
    assert.notDeepEqual(second.body.points, first.body.points, 'geometry was refreshed');
    assert.deepEqual(second.body.points[0], [52, 18], 'fixtureB s4a first point');
    assert.equal(shapeCache.size, 2, 'old generation stays resident, unreachable');

    await app.stop();
  });

  it('survives a failed refresh without clearing the working cache', async () => {
    const store = new GtfsStore({ downloader: async () => { throw new Error('network down'); } });
    const spy = countShapeMisses(store);
    const app = await withApp(store);
    await load(store, fixtureA); // load directly so the cold-boot failure can be simulated

    const first = await app.get('/shapes/4?format=compact');
    assert.equal(spy.calls, 1);

    // A failed refresh: download throws before build, generation does not move.
    await assert.rejects(() => store.refresh(), /network down/);
    assert.equal(store.generation, 1, 'failed refresh did not bump generation');

    const second = await app.get('/shapes/4?format=compact');
    assert.equal(spy.calls, 1, 'cache was not cleared by the failed refresh');
    assert.deepEqual(second.body, first.body, 'served from the surviving cache');

    await app.stop();
  });
});

describe('shape ETag and Cache-Control', () => {
  /** Same as withApp but exposes headers on the response so we can assert ETag/304. */
  const withAppHeaders = async (store) => {
    shapeCache.clear();
    const app = createApp({ gtfs: store, vehicles: fakeVehicles, alerts: fakeAlerts });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, opts = {}) => {
      const response = await fetch(`${base}${path}`, opts);
      const ct = response.headers.get('content-type') || '';
      const body = ct.includes('json') ? await response.json() : await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body,
        cacheControl: response.headers.get('cache-control'),
      };
    };
    return { get, stop: () => new Promise((resolve) => server.close(() => resolve())) };
  };

  it('serves Cache-Control: public, no-cache on shape endpoints', async () => {
    const store = new GtfsStore();
    const app = await withAppHeaders(store);
    try {
      await load(store, fixtureA);

      const res = await app.get('/shapes/4?format=compact');
      assert.equal(res.status, 200);
      assert.equal(res.cacheControl, 'public, no-cache', 'shapes must revalidate, not blind-cache for an hour');
    } finally {
      await app.stop();
    }
  });

  it('returns a fresh ETag and body after a generation change (BLOCKER 4)', async () => {
    const store = new GtfsStore();
    const app = await withAppHeaders(store);
    try {
      await load(store, fixtureA);

      const first = await app.get('/shapes/4?format=compact');
      assert.equal(first.status, 200);
      const etagA = first.headers.get('etag');
      assert.ok(etagA, 'shape response carries an ETag');
      const pointsA = first.body.points;
      assert.deepEqual(pointsA[0], [51.11, 17.032], 'fixtureA first point');

      // Same request with same ETag → 304 (unchanged generation).
      const same = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': etagA },
      });
      assert.equal(same.status, 304, 'same generation → 304');

      // Swap to fixtureB: same shape ids, different geometry, new generation.
      await load(store, fixtureB);
      assert.equal(store.generation, 2, 'generation advanced on the swap');

      const second = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': etagA },
      });
      assert.equal(second.status, 200, 'must not 304 after generation change');
      const etagB = second.headers.get('etag');
      assert.notEqual(etagB, etagA, 'ETag changed with the new generation');
      assert.notDeepEqual(second.body.points, pointsA, 'geometry was refreshed');
      assert.deepEqual(second.body.points[0], [52, 18], 'fixtureB first point');
    } finally {
      await app.stop();
    }
  });

  it('still 304s when geometry is unchanged within the same generation', async () => {
    const store = new GtfsStore();
    const app = await withAppHeaders(store);
    try {
      await load(store, fixtureA);

      const first = await app.get('/shapes/4?format=compact');
      const etag = first.headers.get('etag');

      const second = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': etag },
      });
      assert.equal(second.status, 304, 'same generation and geometry → 304');
    } finally {
      await app.stop();
    }
  });
});
