'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { VehicleTracker } = require('../src/vehicles');
const { shapeCache } = require('../src/routes');
const { buildFixtureZip } = require('./fixtures/gtfs');

const lines = { allTrams: ['4'], allBuses: ['128'] };
const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 0 },
  getAlerts: () => [],
};

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

const startEndpoint = (getRows) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getRows()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
};

const startApp = async (services) => {
  shapeCache.clear();
  const app = createApp({ startedAt: new Date(), ...services });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, opts = {}) => {
    const response = await fetch(`${base}${path}`, opts);
    const ct = response.headers.get('content-type') || '';
    const body = ct.includes('json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, body };
  };
  return { get, base, stop: () => server.close() };
};

const load = async (store, fixture) => {
  await store.build(fixture);
  store.status.state = 'ready';
};

describe('Phase 1–3 integration: full lifecycle', () => {
  const originalSources = config.vehicles.sources;
  const originalOpenDataUrl = config.vehicles.openDataUrl;
  const servers = [];

  const cleanup = () => {
    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    servers.forEach((s) => s.close());
  };

  it('exercises GTFS start → poll → /locations 304 → movement → failure → fallback → shape refresh', async () => {
    // Two mock endpoints: primary first, fallback second.
    let primaryRows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    let fallbackRows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];

    const primary = await startEndpoint(() => primaryRows);
    const fallback = await startEndpoint(() => fallbackRows);
    servers.push(primary, fallback);

    config.vehicles.sources = [
      `http://127.0.0.1:${primary.address().port}/bus_position`,
      `http://127.0.0.1:${fallback.address().port}/bus_position`,
    ];
    config.vehicles.openDataUrl = null;

    const gtfs = new GtfsStore();
    await load(gtfs, buildFixtureZip());
    gtfs.status.state = 'ready';

    const vehicles = new VehicleTracker(() => lines, { gtfs });
    await vehicles.poll();

    const app = await startApp({ gtfs, vehicles, alerts: fakeAlerts });
    try {
      // --- GTFS gen 1 loaded, MPK poll succeeds ---
      assert.equal(gtfs.generation, 1, 'fixtureA is generation 1');
      assert.equal(vehicles.snapshot.stale, false, 'first successful poll is not stale');
      assert.equal(vehicles.snapshot.source, config.vehicles.sources[0], 'snapshot.source = primary');
      assert.equal(vehicles.snapshot.locations[0].lat, 51.11, 'vehicle at position X');

      // --- GET /locations → store ETag A ---
      const r1 = await app.get('/locations?format=map');
      assert.equal(r1.status, 200);
      const etagA = r1.headers.get('etag');
      assert.ok(etagA, 'first response carries an ETag');
      assert.equal(r1.body.locations[0].lat, 51.11);

      // --- GET again → 304 ---
      const r2 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
      assert.equal(r2.status, 304, 'unchanged fleet returns 304');

      // --- Vehicle moves to Y ---
      primaryRows = [{ name: '4', type: 'tram', x: 51.12, y: 17.032, k: 1 }];
      await vehicles.poll();

      // --- GET same URL with ETag A → 200, ETag B, position Y ---
      const r3 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
      assert.equal(r3.status, 200, 'movement must not 304');
      const etagB = r3.headers.get('etag');
      assert.notEqual(etagB, etagA, 'ETag changed after movement');
      assert.equal(r3.body.locations[0].lat, 51.12, 'new position served');
      assert.equal(r3.body.stale, false, 'still fresh');

      // --- MPK poll fails → stale=true ---
      primaryRows = [];
      fallbackRows = [];
      await vehicles.poll();
      assert.equal(vehicles.snapshot.stale, true, 'failed poll sets snapshot.stale = true');
      assert.equal(vehicles.status.consecutiveFailures, 1, 'failure recorded on status');

      // --- GET /locations → fresh representation with stale=true ---
      const r4 = await app.get('/locations?format=map');
      assert.equal(r4.status, 200);
      assert.equal(r4.body.stale, true, 'stale flag visible in /locations');
      const etagC = r4.headers.get('etag');
      assert.notEqual(etagC, etagB, 'ETag changed because stale is visible content');

      // --- Fallback source succeeds → stale=false immediately, source=fallback ---
      primaryRows = [];
      fallbackRows = [{ name: '4', type: 'tram', x: 51.12, y: 17.032, k: 1 }];
      await vehicles.poll();
      assert.equal(vehicles.snapshot.stale, false, 'recovery clears stale immediately');
      assert.equal(vehicles.status.consecutiveFailures, 0, 'failures reset immediately');
      assert.equal(vehicles.snapshot.source, config.vehicles.sources[1], 'snapshot.source = fallback');

      // --- GET /locations → changed body / ETag ---
      const r5 = await app.get('/locations?format=map');
      assert.equal(r5.status, 200);
      assert.notEqual(r5.headers.get('etag'), etagC, 'ETag changed on stale→fresh transition');
      assert.equal(r5.body.stale, false, 'stale cleared in /locations');
      assert.equal(r5.body.source, config.vehicles.sources[1], 'fallback source visible in /locations');

      // --- GTFS generation 2 installed, shape changes ---
      const shape1 = await app.get('/shapes/4?format=compact');
      assert.equal(shape1.status, 200);
      const shapeEtagA = shape1.headers.get('etag');
      assert.ok(shapeEtagA, 'shape response carries an ETag');
      assert.deepEqual(shape1.body.points[0], [51.11, 17.032], 'gen 1 geometry');

      // Same generation, same ETag → 304
      const shape2 = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': shapeEtagA },
      });
      assert.equal(shape2.status, 304, 'same generation and geometry returns 304');

      // Now swap to fixtureB (different geometry, same shape ids)
      await load(gtfs, fixtureB);
      assert.equal(gtfs.generation, 2, 'generation advanced');

      // Old ETag must not 304 — the body changed
      const shape3 = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': shapeEtagA },
      });
      assert.equal(shape3.status, 200, 'old ETag must not 304 after generation change');
      const shapeEtagB = shape3.headers.get('etag');
      assert.notEqual(shapeEtagB, shapeEtagA, 'gen 2 ETag differs from gen 1');
      assert.notDeepEqual(shape3.body.points, shape1.body.points, 'gen 2 geometry differs');
      assert.deepEqual(shape3.body.points[0], [52, 18], 'fixtureB geometry');

      // Same gen 2 ETag → 304
      const shape4 = await app.get('/shapes/4?format=compact', {
        headers: { 'If-None-Match': shapeEtagB },
      });
      assert.equal(shape4.status, 304, 'same generation and geometry returns 304');
    } finally {
      await app.stop();
      cleanup();
    }
  });
});
