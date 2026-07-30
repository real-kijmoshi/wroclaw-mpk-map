'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { shapeCache } = require('../src/routes');
const { buildFixtureZip } = require('./fixtures/gtfs');

/** Minimal stand-ins so the API can be tested without touching the network. */
const fakeVehicles = {
  status: { source: 'test', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 2 },
  snapshot: {
    locations: [
      { id: '4-1', line: '4', type: 'tram', lat: 51.11, lon: 17.032, heading: 90, updatedAt: null },
      { id: '128-1', line: '128', type: 'bus', lat: 51.09, lon: 17.031, heading: 180, updatedAt: null },
    ],
    count: 2,
    lastUpdated: null,
    source: 'test',
    stale: false,
  },
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 1 },
  getAlerts: ({ since = 0, line = null } = {}) =>
    [{ id: 'a1', content: 'Linia 4 objazd', timestamp: 1_000, affected: ['4'], url: null, source: 'test' }].filter(
      (alert) => alert.timestamp >= since && (!line || alert.affected.includes(line)),
    ),
};

describe('HTTP API', () => {
  const gtfs = new GtfsStore();
  let server;
  let base;

  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    const body = response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
    shapeCache.clear();

    const app = createApp({ gtfs, vehicles: fakeVehicles, alerts: fakeAlerts });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('describes itself at the root', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.endpoints));
  });

  it('serves categorised lines', async () => {
    const { status, body } = await get('/lines');
    assert.equal(status, 200);
    assert.deepEqual(body.tram, ['4']);
    assert.deepEqual(body.allBuses, ['128', '240']);
  });

  it('serves a single category and 404s on unknown ones', async () => {
    assert.deepEqual((await get('/lines/tram')).body, { category: 'tram', lines: ['4'] });

    const missing = await get('/lines/nope');
    assert.equal(missing.status, 404);
    assert.ok(missing.body.availableCategories.includes('tram'));
  });

  it('serves vehicle positions and filters them', async () => {
    assert.equal((await get('/locations')).body.count, 2);

    const trams = await get('/locations?type=tram');
    assert.equal(trams.body.count, 1);
    assert.equal(trams.body.locations[0].line, '4');

    const byLine = await get('/locations?line=128');
    assert.equal(byLine.body.count, 1);
    assert.equal(byLine.body.locations[0].line, '128');
  });

  it('never lets a client cache live positions', async () => {
    const { headers } = await get('/locations');
    assert.equal(headers.get('cache-control'), 'no-store');
  });

  it('returns the legacy shape payload by default', async () => {
    const { status, body } = await get('/shapes/4');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.shapePoints));
    assert.ok('shape_pt_lat' in body.shapePoints[0], 'installed app builds read shape_pt_lat');
    assert.ok('stop_name' in body.stops[0].stop);
  });

  it('returns a compact payload on request', async () => {
    const { body } = await get('/shapes/4?format=compact');
    assert.ok(Array.isArray(body.points[0]), 'compact points are [lat, lon] pairs');
    assert.equal(body.line, '4');
    assert.ok(body.bounds.minLat < body.bounds.maxLat);
  });

  it('picks the variant nearest the supplied position', async () => {
    const near = await get('/shapes/4?lat=51.1&lon=17.099&format=compact');
    assert.equal(near.body.shapeId, 's4b');
  });

  it('lists every variant of a line', async () => {
    const { body } = await get('/shapes/4/variants');
    assert.equal(body.variants.length, 2);
    assert.equal(body.route.color, '#E30613');
  });

  it('404s for lines that do not exist', async () => {
    assert.equal((await get('/shapes/999')).status, 404);
    assert.equal((await get('/stops/999')).status, 404);
  });

  it('lists the union of stops served by a line', async () => {
    const { body } = await get('/stops/4');
    assert.deepEqual(
      body.stops.map((stop) => stop.name).sort(),
      ['Biskupin', 'Oporów', 'Rynek', 'Świdnicka'],
    );
  });

  it('searches stops', async () => {
    const { body } = await get('/stops?q=ryn');
    assert.equal(body.stops[0].name, 'Rynek');

    assert.equal((await get('/stops?q=')).status, 400);
  });

  it('serves stop details and departures', async () => {
    assert.equal((await get('/stop/1')).body.name, 'Rynek');
    assert.equal((await get('/stop/nope')).status, 404);

    const departures = await get('/stop/1/departures?limit=5');
    assert.equal(departures.status, 200);
    assert.ok(Array.isArray(departures.body.departures));
  });

  it('serves alerts and supports filtering', async () => {
    assert.equal((await get('/alerts')).body.alerts.length, 1);
    assert.equal((await get('/alerts?since=99999')).body.alerts.length, 0);
    assert.equal((await get('/alerts?from=99999')).body.alerts.length, 0, 'legacy ?from= still works');
    assert.equal((await get('/alerts?line=4')).body.alerts.length, 1);
    assert.equal((await get('/alerts?line=128')).body.alerts.length, 0);
  });

  it('reports health', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.lines.trams, 1);
  });

  it('404s unknown paths as JSON', async () => {
    const { status, body } = await get('/definitely-not-a-route');
    assert.equal(status, 404);
    assert.equal(body.error, 'Not found');
  });

  it('answers 503 while the timetable is still loading', async () => {
    gtfs.status.state = 'loading';
    const { status, headers } = await get('/lines');
    assert.equal(status, 503);
    assert.equal(headers.get('retry-after'), '15');
    gtfs.status.state = 'ready';
  });
});
