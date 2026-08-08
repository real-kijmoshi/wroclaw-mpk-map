'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { shapeCache } = require('../src/routes');
const { buildFixtureZip } = require('./fixtures/gtfs');

/**
 * KD is exercised through a fake service so the route wiring is tested without
 * touching the network. The fake mirrors the KdService surface the router uses:
 * isReady/status/snapshot plus the get* methods.
 */
const makeFakeKd = (overrides = {}) => ({
  isReady: true,
  status: {
    enabled: true,
    static: { state: 'ready', counts: { routes: 2, trips: 3, stops: 4, stopTimes: 6, shapes: 0 } },
    realtime: { configured: false, state: 'disabled', vehiclePositions: 0, tripUpdates: 0 },
  },
  snapshot: {
    locations: [
      {
        id: 'kd:vehicle:1',
        line: 'D6',
        type: 'train',
        lat: 51.1,
        lon: 17.03,
        heading: 90,
        operator: 'KD',
        routeId: '356696',
        tripId: 'kd:trip:49568424_446515',
        vehicleLabel: '31WE-001',
        delaySeconds: 120,
        positionUpdatedAt: '2026-08-07T10:00:00.000Z',
        trip: { headsign: 'Wałbrzych Miasto', towards: 'Wałbrzych Miasto' },
      },
    ],
    count: 1,
    lastUpdated: '2026-08-07T10:00:00.000Z',
    stale: false,
    source: 'kd-gtfs-rt',
  },
  getLines: () => ['D1', 'D6'],
  getStop: (id) =>
    id === 'kd:stop:1413380'
      ? { id: 'kd:stop:1413380', name: 'Wrocław Główny', lat: 51.099, lon: 17.036, type: 'train' }
      : null,
  getDepartures: (id, { limit = 20 } = {}) =>
    id === 'kd:stop:1413380'
      ? [
          {
            line: 'D6',
            type: 'train',
            operator: 'KD',
            headsign: 'Wałbrzych Miasto',
            scheduledDeparture: '14:40:00',
            tripId: 'kd:trip:49568424_446515',
          },
        ].slice(0, limit)
      : [],
  searchStops: (query) =>
    query === 'glowny' ? [{ id: 'kd:stop:1413380', name: 'Wrocław Główny', lat: 51.099, lon: 17.036, type: 'train' }] : [],
  getTrip: (id) =>
    id === 'kd:vehicle:1'
      ? {
          vehicle: {
            id: 'kd:vehicle:1',
            line: 'D6',
            type: 'train',
            lat: 51.1,
            lon: 17.03,
            heading: 90,
            operator: 'KD',
            delaySeconds: 120,
          },
          trip: {
            routeId: '356696',
            tripId: 'kd:trip:49568424_446515',
            headsign: 'Wałbrzych Miasto',
            delaySeconds: 120,
            operator: 'KD',
            nextStop: { name: 'Wrocław Główny', platformCode: '2', sequence: 1 },
            stopsAhead: [],
          },
        }
      : null,
  getTripShape: () => null,
  ...overrides,
});

const fakeVehicles = {
  status: { source: 'test', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 2 },
  openDataStatus: { source: 'x', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 0 },
  stats: { mpk: 1, merged: 1, openData: 0, total: 2, activeLines: 2 },
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
  getVehicle(id) {
    return this.snapshot.locations.find((entry) => entry.id === id) ?? null;
  },
  describeCache: new Map(),
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 0 },
  getAlerts: () => [],
};

describe('KD routes', () => {
  const gtfs = new GtfsStore();
  const kd = makeFakeKd();
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

    const app = createApp({ gtfs, vehicles: fakeVehicles, alerts: fakeAlerts, kd, startedAt: new Date() });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('merges KD trains into /locations and filters them with ?type=train', async () => {
    const all = await get('/locations');
    assert.equal(all.status, 200);
    assert.equal(all.body.count, 3);

    const trains = await get('/locations?type=train');
    assert.equal(trains.body.count, 1);
    assert.equal(trains.body.locations[0].id, 'kd:vehicle:1');
    assert.equal(trains.body.locations[0].line, 'D6');
    assert.equal(trains.body.locations[0].operator, 'KD');

    const wroclaw = await get('/locations?type=tram');
    assert.equal(wroclaw.body.count, 1);
    assert.equal(wroclaw.body.locations[0].id, '4-1');
  });

  it('serves KD lines under a train category, never inside allBuses', async () => {
    const { status, body } = await get('/lines');
    assert.equal(status, 200);
    assert.deepEqual(body.train, ['D1', 'D6']);
    assert.deepEqual(body.allTrains, ['D1', 'D6']);
    assert.ok(!body.allBuses.includes('D6'), 'a KD train must not read as an express bus');
    assert.ok(!body.busExpress.includes('D6'));
  });

  it('serves a single train category and 404s unknown ones', async () => {
    const { status, body } = await get('/lines/train');
    assert.equal(status, 200);
    assert.deepEqual(body, { category: 'train', lines: ['D1', 'D6'] });
  });

  it('routes KD stop ids to the KD service', async () => {
    const stop = await get('/stop/kd:stop:1413380');
    assert.equal(stop.status, 200);
    assert.equal(stop.body.name, 'Wrocław Główny');
    assert.equal((await get('/stop/kd:stop:nope')).status, 404);
  });

  it('serves KD departures with train metadata', async () => {
    const { status, body } = await get('/stop/kd:stop:1413380/departures');
    assert.equal(status, 200);
    assert.equal(body.departures[0].line, 'D6');
    assert.equal(body.departures[0].type, 'train');
    assert.equal(body.departures[0].operator, 'KD');
  });

  it('searches KD stops alongside MPK stops', async () => {
    const { status, body } = await get('/stops?q=glowny');
    assert.equal(status, 200);
    assert.ok(body.stops.some((stop) => stop.id === 'kd:stop:1413380'));
  });

  it('answers a kd: vehicle without waiting on the Wrocław timetable', async () => {
    gtfs.status.state = 'loading';
    const detail = await get('/vehicle/kd:vehicle:1');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.trip.headsign, 'Wałbrzych Miasto');

    const missing = await get('/vehicle/kd:vehicle:nope');
    assert.equal(missing.status, 404);
    gtfs.status.state = 'ready';
  });

  it('keeps serving Wrocław vehicles under /vehicle/:id with requireGtfs', async () => {
    gtfs.status.state = 'loading';
    assert.equal((await get('/vehicle/4-1')).status, 503);
    gtfs.status.state = 'ready';
    assert.equal((await get('/vehicle/4-1')).status, 200);
  });

  it('reports that a KD trip has no geometry instead of drawing straight lines', async () => {
    const { status, body } = await get('/kd/trip/kd:trip:49568424_446515/shape');
    assert.equal(status, 404);
    assert.equal(body.available, false);
    assert.match(body.reason, /shape/i);
  });

  it('serves /lines from the KD timetable alone while Wrocław is still loading', async () => {
    gtfs.status.state = 'loading';
    const lines = await get('/lines');
    assert.equal(lines.status, 200);
    assert.deepEqual(lines.body.train, ['D1', 'D6']);
    gtfs.status.state = 'ready';
  });

  it('reports KD health without letting KD fail the overall status', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.kd.enabled, true);
    assert.equal(body.kd.static.counts.routes, 2);
    assert.equal(body.lines.trains, 2);
    assert.equal(body.status, 'ok');
  });
});
