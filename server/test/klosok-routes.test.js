'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { KlosokService } = require('../src/klosok/service');
const { shapeCache } = require('../src/routes');
const { buildKlosokFixtureZip } = require('./fixtures/klosok-gtfs');

const fakeVehicles = {
  status: { source: 'test', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 2 },
  openDataStatus: { source: 'x', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 0 },
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
        updatedAt: null,
      },
      {
        id: '911-wroclaw',
        line: '911',
        type: 'busZone',
        lat: 51.105,
        lon: 17.033,
        heading: 90,
        updatedAt: null,
        vehicleNumber: 1201,
      },
    ],
    count: 2,
    lastUpdated: null,
    source: 'test',
    stale: false,
  },
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 0 },
  getAlerts: () => [],
};

const klosokVehicle = (overrides = {}) => ({
  id: overrides.id ?? 'klosok:1201',
  operator: 'PT KŁOSOK',
  type: 'busZone',
  line: '911',
  routeId: '911',
  tripId: 't911a',
  vehicleId: '1201',
  vehicleLabel: '911/12',
  brigade: '12',
  lat: 51.105,
  lon: 17.033,
  heading: 90,
  destination: 'WIEPRZYCE',
  delaySeconds: 60,
  currentStopSequence: 1,
  positionUpdatedAt: overrides.positionUpdatedAt ?? new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: 'klosok-gtfs-rt',
  ...overrides,
});

const nowIso = () => new Date().toISOString();

describe('KlosokService', () => {
  let gtfs;

  before(async () => {
    gtfs = new GtfsStore();
    await gtfs.build(buildKlosokFixtureZip());
    gtfs.status.state = 'ready';
  });

  it('is enabled from configuration', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    assert.equal(service.enabled, true);
    assert.equal(service.status.enabled, true);
  });

  it('serves only fresh positions from getVehicle', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = {
      locations: [
        klosokVehicle(),
        klosokVehicle({ id: 'klosok:stale', vehicleId: '2101', positionUpdatedAt: new Date(Date.now() - 300000).toISOString() }),
      ],
      count: 2,
      lastUpdated: nowIso(),
      stale: false,
      source: 'klosok-gtfs-rt',
    };
    assert.equal(service.getVehicle('klosok:1201').id, 'klosok:1201');
    assert.equal(service.getVehicle('klosok:stale'), null);
  });

  it('drops a Wrocław bus with the same vehicle number', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = { locations: [klosokVehicle()], count: 1, lastUpdated: nowIso(), stale: false, source: 'klosok-gtfs-rt' };
    const wroclaw = [{ ...fakeVehicles.snapshot.locations[1] }];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'klosok:1201');
  });

  it('drops a Wrocław vehicle carrying the same trip id', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = { locations: [klosokVehicle({ vehicleId: null })], count: 1, lastUpdated: nowIso(), stale: false, source: 'klosok-gtfs-rt' };
    const wroclaw = [{ ...fakeVehicles.snapshot.locations[1], vehicleNumber: null, trip: { tripId: 't911a' } }];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'klosok:1201');
  });

  it('drops a Wrocław bus on the same line running the same brigade', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = { locations: [klosokVehicle({ vehicleId: null })], count: 1, lastUpdated: nowIso(), stale: false, source: 'klosok-gtfs-rt' };
    const wroclaw = [{ ...fakeVehicles.snapshot.locations[1], vehicleNumber: null, brigade: '12' }];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'klosok:1201');
  });

  it('drops a Wrocław bus of the same line within the dedupe radius at a similar time', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = { locations: [klosokVehicle({ vehicleId: null })], count: 1, lastUpdated: nowIso(), stale: false, source: 'klosok-gtfs-rt' };
    const wroclaw = [
      {
        ...fakeVehicles.snapshot.locations[1],
        vehicleNumber: null,
        lat: 51.105 + 0.001, // ~110 m away
        lon: 17.033,
      },
    ];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'klosok:1201');
  });

  it('keeps two nearby buses that are on different lines', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = { locations: [klosokVehicle()], count: 1, lastUpdated: nowIso(), stale: false, source: 'klosok-gtfs-rt' };
    const wroclaw = [
      {
        id: '911-wroclaw',
        line: '921',
        type: 'busZone',
        lat: 51.105,
        lon: 17.033,
        updatedAt: nowIso(),
      },
    ];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 2);
  });

  it('keeps the Wrocław fleet unchanged when no Kłosok position is fresh', () => {
    const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
    service.snapshot = {
      locations: [klosokVehicle({ positionUpdatedAt: new Date(Date.now() - 300000).toISOString() })],
      count: 1,
      lastUpdated: nowIso(),
      stale: true,
      source: 'klosok-gtfs-rt',
    };
    const wroclaw = [...fakeVehicles.snapshot.locations];
    const merged = service.mergeLocations(wroclaw);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((v) => v.id), ['4-1', '911-wroclaw']);
  });

  it('types a served bus by its GTFS line, not by the raw feed type', async () => {
    const originalFetch = global.fetch;
    const nowSec = Math.floor(Date.now() / 1000);
    const feedBuffer = Buffer.from(
      rt.FeedMessage.encode(
        rt.FeedMessage.create({
          header: rt.FeedHeader.create({ gtfsRealtimeVersion: '2.0', timestamp: nowSec }),
          entity: [
            rt.FeedEntity.create({
              id: 'e1',
              vehicle: rt.VehiclePosition.create({
                trip: rt.TripDescriptor.create({ tripId: 't911a', routeId: '911', startDate: '20260807' }),
                vehicle: rt.VehicleDescriptor.create({ id: '1201', label: '911/12' }),
                position: rt.Position.create({ latitude: 51.105123, longitude: 17.032987, bearing: 90 }),
                timestamp: nowSec,
                currentStopSequence: 1,
              }),
            }),
          ],
        }),
      ).finish(),
    );

    try {
      global.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => feedBuffer });
      const service = new KlosokService({ gtfs, getWroclawLocations: () => [] });
      const status = await service.poll();
      assert.equal(status.state, 'ready');
      assert.equal(status.matchedByTripId, 1);
      const served = service.snapshot.locations[0];
      assert.equal(served.line, '911');
      // A 9xx line is a zone bus: pink on the map, never the plain red 'bus'.
      assert.equal(served.type, 'busZone');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Kłosok routes', () => {
  let gtfs;
  let klosok;
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
    // The Kłosok fixture carries line 911 with real stop times, which the
    // base fixture does not — /vehicle/klosok:1201 describes that line.
    gtfs = new GtfsStore();
    await gtfs.build(buildKlosokFixtureZip());
    gtfs.status.state = 'ready';

    klosok = new KlosokService({
      gtfs,
      getWroclawLocations: () => fakeVehicles.snapshot.locations,
    });
    klosok.snapshot = {
      locations: [klosokVehicle()],
      count: 1,
      lastUpdated: nowIso(),
      stale: false,
      source: 'klosok-gtfs-rt',
    };

    shapeCache.clear();
    const app = createApp({ gtfs, vehicles: fakeVehicles, alerts: fakeAlerts, klosok, startedAt: new Date() });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('merges fresh Kłosok buses into /locations and deduplicates the Wrocław bus', async () => {
    const { status, body } = await get('/locations');
    assert.equal(status, 200);
    assert.equal(body.count, 2); // 4-1 tram + klosok bus (911-wroclaw deduped)
    const klosokEntry = body.locations.find((vehicle) => vehicle.id === 'klosok:1201');
    assert.ok(klosokEntry);
    assert.equal(klosokEntry.line, '911');
    assert.equal(klosokEntry.type, 'busZone');
    assert.equal(klosokEntry.operator, 'PT KŁOSOK');
    assert.equal(klosokEntry.source, 'klosok-gtfs-rt');
    assert.equal(klosokEntry.destination, 'WIEPRZYCE');
    assert.ok(!body.locations.some((vehicle) => vehicle.id === '911-wroclaw'));
  });

  it('filters Kłosok buses like any other bus', async () => {
    const zones = await get('/locations?type=busZone');
    assert.equal(zones.body.count, 1);
    assert.equal(zones.body.locations[0].id, 'klosok:1201');

    const trams = await get('/locations?type=tram');
    assert.equal(trams.body.count, 1);
    assert.equal(trams.body.locations[0].id, '4-1');
  });

  it('serves Kłosok vehicles in the compact map format', async () => {
    const { status, body } = await get('/locations?format=map');
    assert.equal(status, 200);
    const klosokEntry = body.locations.find((vehicle) => vehicle.id === 'klosok:1201');
    assert.ok(klosokEntry);
    assert.equal(klosokEntry.trip.headsign, 'WIEPRZYCE');
    assert.equal(klosokEntry.vehicleNumber, undefined);
  });

  it('describes a klosok: vehicle with the Wrocław timetable', async () => {
    const { status, body } = await get('/vehicle/klosok:1201');
    assert.equal(status, 200);
    assert.equal(body.vehicle.id, 'klosok:1201');
    assert.ok(body.trip, 'expected describeVehicle output');
    assert.equal(body.trip.line, '911');
    assert.equal(body.trip.direction, 'Rynek → Oporów');

    const missing = await get('/vehicle/klosok:gone');
    assert.equal(missing.status, 404);
  });

  it('still 503s a klosok: vehicle while the Wrocław timetable loads', async () => {
    gtfs.status.state = 'loading';
    assert.equal((await get('/vehicle/klosok:1201')).status, 503);
    gtfs.status.state = 'ready';
  });

  it('reports Kłosok health without letting it fail the overall status', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.klosok.enabled, true);
    assert.equal(body.status, 'ok');
    assert.equal(body.klosok.endpoint, 'https://mapadlugoleka.klosok.eu/vehicle_positions.pb');
  });
});
