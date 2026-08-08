'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, describe, it } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { VehicleTracker } = require('../src/vehicles');
const { shapeCache } = require('../src/routes');

const lines = { allTrams: ['4'], allBuses: ['128'] };
const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 0 },
  getAlerts: () => [],
};

const startEndpoint = (getRows) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getRows()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
};

const startApp = async (vehicles) => {
  const gtfs = new GtfsStore();
  gtfs.status.state = 'ready';
  shapeCache.clear();
  const app = createApp({ gtfs, vehicles, alerts: fakeAlerts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, opts = {}) => {
    const response = await fetch(`${base}${path}`, opts);
    const ct = response.headers.get('content-type') || '';
    const body = ct.includes('json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, body };
  };
  return { get, stop: () => server.close() };
};

describe('/locations body cache freshness', () => {
  const originalSources = config.vehicles.sources;
  const originalOpenDataUrl = config.vehicles.openDataUrl;
  const servers = [];

  after(() => {
    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    servers.forEach((s) => s.close());
  });

  const makeTracker = async (getRows) => {
    const server = await startEndpoint(getRows);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];
    config.vehicles.openDataUrl = null;
    const tracker = new VehicleTracker(() => lines);
    return tracker;
  };

  it('answers 304 when the fleet has not changed (Test 1)', async () => {
    const rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await makeTracker(() => rows);
    await tracker.poll();

    const app = await startApp(tracker);
    try {
      const first = await app.get('/locations');
      assert.equal(first.status, 200);
      const etag = first.headers.get('etag');
      assert.ok(etag, '/locations carries an ETag');

      const second = await app.get('/locations', { headers: { 'If-None-Match': etag } });
      assert.equal(second.status, 304, 'unchanged fleet → 304');
    } finally {
      await app.stop();
    }
  });

  it('returns a fresh body after the vehicle moves (Test 2)', async () => {
    let rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await makeTracker(() => rows);
    await tracker.poll();

    const app = await startApp(tracker);
    try {
      const first = await app.get('/locations?format=map');
      assert.equal(first.status, 200);
      const etagA = first.headers.get('etag');
      const latA = first.body.locations[0].lat;
      assert.equal(latA, 51.11);

      rows = [{ name: '4', type: 'tram', x: 51.12, y: 17.032, k: 1 }];
      await tracker.poll();

      const second = await app.get('/locations?format=map', {
        headers: { 'If-None-Match': etagA },
      });
      assert.equal(second.status, 200, 'movement must not 304');
      const etagB = second.headers.get('etag');
      assert.notEqual(etagB, etagA, 'ETag changed');
      assert.equal(second.body.locations[0].lat, 51.12, 'new position served');
    } finally {
      await app.stop();
    }
  });

  it('does not skip revision validation for a cached query variant (Test 3)', async () => {
    let rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await makeTracker(() => rows);
    await tracker.poll();

    const app = await startApp(tracker);
    try {
      // First request builds and caches the format=map variant body.
      const first = await app.get('/locations?format=map');
      assert.equal(first.status, 200);
      const etagA = first.headers.get('etag');

      // Same request hits the body cache → 304.
      const second = await app.get('/locations?format=map', {
        headers: { 'If-None-Match': etagA },
      });
      assert.equal(second.status, 304);

      // Now the vehicle moves. The *next* request for the SAME variant must
      // not return the stale cached body (the old bug).
      rows = [{ name: '4', type: 'tram', x: 51.12, y: 17.032, k: 1 }];
      await tracker.poll();

      const third = await app.get('/locations?format=map', {
        headers: { 'If-None-Match': etagA },
      });
      assert.equal(third.status, 200, 'must not 304 with stale body after movement');
      const etagB = third.headers.get('etag');
      assert.notEqual(etagB, etagA, 'new ETag issued');
      assert.equal(third.body.locations[0].lat, 51.12, 'new position served');
    } finally {
      await app.stop();
    }
  });
});
