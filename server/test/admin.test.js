'use strict';

// Env has to be set before requiring anything, because config reads it once.
process.env.ADMIN_TOKEN = 'test-admin-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { StatsTracker } = require('../src/stats');
const { buildFixtureZip } = require('./fixtures/gtfs');

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
  snapshot: {
    locations: [
      {
        id: '4-1',
        line: '4',
        type: 'tram',
        lat: 51.11,
        lon: 17.032,
        heading: 90,
        trip: { headsign: 'Oporów', towards: 'Oporów' },
        updatedAt: null,
      },
    ],
    count: 1,
    lastUpdated: null,
    source: 'test',
    stale: false,
  },
  getVehicle(id) {
    return this.snapshot.locations.find((entry) => entry.id === id) ?? null;
  },
  describeCache: new Map(),
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 1 },
  getAlerts: () => [],
};

describe('Admin dashboard', () => {
  const gtfs = new GtfsStore();
  const stats = new StatsTracker({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-')), 'stats.json'),
  });
  let server;
  let base;

  const get = async (path, { token } = {}) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${base}${path}`, { headers });
    const body = response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';

    const app = createApp({ gtfs, vehicles: fakeVehicles, alerts: fakeAlerts, stats });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    stats.stop();
    server?.close();
  });

  it('serves the admin page shell without a token', async () => {
    const { status, headers, body } = await get('/admin');
    assert.equal(status, 200);
    assert.ok(headers.get('content-type').includes('text/html'));
    assert.ok(body.includes('statystyki'));
  });

  it('rejects stats requests without a token', async () => {
    const { status, body } = await get('/admin/api/stats');
    assert.equal(status, 401);
    assert.equal(body.error, 'Unauthorized');
  });

  it('rejects a wrong token', async () => {
    const { status } = await get('/admin/api/stats', { token: 'nope' });
    assert.equal(status, 401);
  });

  it('serves a fresh snapshot to an authenticated caller', async () => {
    const { status, body } = await get('/admin/api/stats', { token: 'test-admin-secret' });
    assert.equal(status, 200);
    assert.equal(body.dau, 0);
    assert.equal(body.requestsToday, 0);
    assert.ok(Array.isArray(body.daily));
    assert.equal(body.hourly.length, 24);
  });

  it('counts API traffic but not the admin or health endpoints', async () => {
    await get('/locations');
    await get('/vehicle/4-1');
    await get('/vehicle/128-7');
    await get('/health');

    const { status, body } = await get('/admin/api/stats', { token: 'test-admin-secret' });
    assert.equal(status, 200);
    assert.equal(body.dau, 1, 'the test client is one active user');
    assert.equal(body.requestsToday, 3, '/health and /admin itself are not counted');
    // Different vehicle ids land in the same /vehicle/:id bucket.
    assert.deepEqual(body.topEndpointsToday, [
      { endpoint: '/vehicle/:id', count: 2 },
      { endpoint: '/locations', count: 1 },
    ]);
  });

  it('does not leak the snapshot to a client that hits a plain 404', async () => {
    const { status } = await get('/admin/api/stats/extra');
    assert.equal(status, 404);
  });
});
