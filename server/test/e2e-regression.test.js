'use strict';

const assert = require('assert');
const { test, describe, beforeEach, afterEach } = require('node:test');

const { createApp } = require('../src/app');
const { KlosokService } = require('../src/klosok/service');
const config = require('../src/config');

let server;
let base;
let realDateNow;
let now = 0;

const installFakeClock = () => {
  now = 0;
  realDateNow = Date.now;
  Date.now = () => now;
  return {
    now: () => now,
    setNow: (v) => { now = v; },
    uninstall: () => { Date.now = realDateNow; },
  };
};

describe('e2e regression: merged cache phase 1-3 integration', () => {
  let clock;
  let app;
  let vehicles;
  let klosok;

  const mkVehicle = (id, overrides = {}) => ({
    id: `mpk:${id}`,
    line: '130',
    type: 'tram',
    lat: 51.1 + id * 0.001,
    lon: 17.0 + id * 0.001,
    heading: 180,
    trip: { headsign: 'dworzec', towards: 'dworzec' },
    updatedAt: new Date(0).toISOString(),
    source: 'mpk-gtfs-rt',
    positionUpdatedAt: new Date(0).toISOString(),
    ...overrides,
  });

  const mkKlosokVehicle = (id, overrides = {}) => ({
    id: `klosok:${id}`,
    operator: 'MZK',
    type: 'bus',
    line: '150',
    routeId: 'route:k1',
    tripId: 'trip:k1',
    vehicleId: 'vid:k1',
    vehicleLabel: 'BUS-1',
    lat: 51.3,
    lon: 17.2,
    heading: 0,
    destination: 'Dworzec',
    delaySeconds: 0,
    currentStopSequence: 2,
    startDate: '2026-08-08',
    positionUpdatedAt: new Date(0).toISOString(),
    source: 'klosok-gtfs-rt',
    brigade: 'B1',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    now = 0;
    clock = installFakeClock();

    const origKlosokEnabled = config.klosok.enabled;
    const origKlosokUrl = config.klosok.gtfsRtUrl;
    const origKlosokMaxAge = config.klosok.maxAgeMs;
    config.klosok.enabled = true;
    config.klosok.gtfsRtUrl = 'https://example.test/klosok.pb';
    config.klosok.maxAgeMs = 90000;

    const mpkVehicle = mkVehicle(1);
    vehicles = {
      snapshot: {
        locations: [mpkVehicle],
        count: 1,
        lastUpdated: new Date(0).toISOString(),
        source: 'mpk-gtfs-rt',
        stale: false,
      },
      mapRevision: 0,
      fullRevision: 0,
      pollRevision: 0,
      getVehicle: () => null,
    };

    klosok = new KlosokService();
    klosok.snapshot = {
      locations: [mkKlosokVehicle(1)],
      count: 1,
      lastUpdated: new Date(0).toISOString(),
      source: 'klosok-gtfs-rt',
      stale: false,
    };

    app = createApp({ startedAt: new Date(0), vehicles, klosok });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;

    // Store originals for restoration
    beforeEach._origConfig = {
      klosokEnabled: origKlosokEnabled,
      klosokUrl: origKlosokUrl,
      klosokMaxAge: origKlosokMaxAge,
    };
  });

  afterEach(() => {
    clock.uninstall();
    server.close();
    config.klosok.enabled = beforeEach._origConfig.klosokEnabled;
    config.klosok.gtfsRtUrl = beforeEach._origConfig.klosokUrl;
    config.klosok.maxAgeMs = beforeEach._origConfig.klosokMaxAge;
  });

  const get = async (path, opts = {}) => {
    const response = await fetch(`${base}${path}`, opts);
    const ct = response.headers.get('content-type') || '';
    const body = ct.includes('json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  const etag = (r) => r.headers.get('etag');

  test('initial map + 304', async () => {
    const r1 = await get('/locations?format=map');
    assert.equal(r1.status, 200);
    const mapEtag = etag(r1);
    assert.equal(r1.body.count, 2, 'one vehicle per provider');

    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': mapEtag } });
    assert.equal(r2.status, 304);
  });

  test('quiet MPK poll: map returns 304, full returns 200 with new ETag', async () => {
    // Initial map request
    const r1 = await get('/locations?format=map');
    const mapEtag = etag(r1);
    assert.equal(r1.status, 200);

    // Initial full request
    const f1 = await get('/locations');
    const fullEtag = etag(f1);
    assert.equal(f1.status, 200);

    // Simulate quiet MPK poll: fullRevision advances, mapRevision does not.
    // lastUpdated always ticks on a real quiet poll (even if positions are unchanged).
    const before = vehicles.snapshot.lastUpdated;
    vehicles.fullRevision += 1;
    vehicles.snapshot.lastUpdated = new Date(99999).toISOString();
    assert.notEqual(vehicles.snapshot.lastUpdated, before, 'lastUpdated should advance');

    // Map should return 304
    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': mapEtag } });
    assert.equal(r2.status, 304, 'quiet poll does not invalidate map response');

    // Full should return 200 with new ETag and updated lastUpdated
    clock.setNow(90000);
    const f2 = await get('/locations', { headers: { 'If-None-Match': fullEtag } });
    assert.equal(f2.status, 200, 'quiet poll invalidates full response');
    assert.notEqual(etag(f2), fullEtag, 'full ETag changed');
    assert.notEqual(f2.body.lastUpdated, f1.body.lastUpdated, 'lastUpdated updated');

    // Map ETag unchanged
    assert.equal(etag(r2), undefined, 'no ETag on 304');
  });

  test('quiet Kłosok poll: map returns 304, full returns 200 with new ETag', async () => {
    // Regression: a quiet Kłosok poll advances fullRevision (per-vehicle
    // updatedAt changes) without touching mapRevision. The map cache must NOT
    // be rebuilt (304 stays valid) while the full cache IS rebuilt from fresh
    // provider snapshots — never from stale merged objects.
    const r1 = await get('/locations?format=map');
    const mapEtag = etag(r1);
    assert.equal(r1.status, 200);

    const f1 = await get('/locations');
    const fullEtag = etag(f1);
    assert.equal(f1.status, 200);

    // Simulate quiet Kłosok poll: fullRevision advances, mapRevision does not.
    const beforeUpdatedAt = klosok.snapshot.locations[0].updatedAt;
    klosok.fullRevision += 1;
    klosok.snapshot.locations[0].updatedAt = new Date(99999).toISOString();
    assert.notEqual(klosok.snapshot.locations[0].updatedAt, beforeUpdatedAt);

    // Map should return 304
    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': mapEtag } });
    assert.equal(r2.status, 304, 'quiet Kłosok poll does not invalidate map response');

    // Full should return 200 with new ETag and the updated per-vehicle updatedAt
    clock.setNow(50000);
    const f2 = await get('/locations', { headers: { 'If-None-Match': fullEtag } });
    assert.equal(f2.status, 200, 'quiet Kłosok poll invalidates full response');
    assert.notEqual(etag(f2), fullEtag, 'full ETag changed');
    assert.equal(f2.body.lastUpdated, f1.body.lastUpdated, 'full snapshot lastUpdated unchanged (quiet poll)');

    // The full body must reflect the updated updatedAt — proving the cache was
    // rebuilt from the current snapshot, not a stale merged object.
    const klosokVehicle = f2.body.locations.find((v) => v.id === 'klosok:1');
    assert.equal(klosokVehicle.updatedAt, new Date(99999).toISOString(), 'full body carries fresh updatedAt');
  });

  test('Kłosok metadata-only update: map returns 200 with new ETag', async () => {
    const r1 = await get('/locations?format=map');
    const mapEtag = etag(r1);
    assert.equal(r1.status, 200);

    // Simulate Kłosok metadata change: destination changes, coordinates unchanged
    klosok.snapshot.locations[0].destination = 'HUBAL - Rondo Hallera';
    klosok.mapRevision += 1;
    klosok.fullRevision += 1;

    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': mapEtag } });
    assert.equal(r2.status, 200, 'Kłosok metadata change invalidates map response');
    assert.notEqual(etag(r2), mapEtag, 'map ETag changed');
  });

  test('Kłosok expiry: vehicle evicted without a poll', async () => {
    // Kłosok vehicle at positionUpdatedAt = 0, maxAgeMs = 90000
    // nextExpiryAt = 90000

    // Initial request
    const r1 = await get('/locations?format=map');
    const etagA = etag(r1);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.count, 2, 'one vehicle per provider');

    // Before expiry: still 304
    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
    assert.equal(r2.status, 304, 'cache valid before expiry');

    // Past expiry: vehicle gone (count drops to 1)
    clock.setNow(90000);
    const r3 = await get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
    assert.equal(r3.status, 200, 'cache invalidated at expiry');
    assert.notEqual(etag(r3), etagA, 'new ETag after eviction');
    assert.equal(r3.body.count, 1, 'Kłosok vehicle evicted');
    assert.ok(r3.body.locations.every((v) => v.id !== 'klosok:1'), 'Kłosok vehicle absent');

    // Unchanged request: 304
    const r4 = await get('/locations?format=map', { headers: { 'If-None-Match': etag(r3) } });
    assert.equal(r4.status, 304, 'stable after eviction');
  });

  test('two Kłosok vehicles expire independently', async () => {
    // Vehicle A at t=0, vehicle B at t=45000
    klosok.snapshot = {
      locations: [
        mkKlosokVehicle(1),  // positionUpdatedAt at 0, expires at 90000
        mkKlosokVehicle(2, { positionUpdatedAt: new Date(45000).toISOString() }),  // expires at 135000
      ],
      count: 2,
      lastUpdated: new Date(0).toISOString(),
      source: 'klosok-gtfs-rt',
      stale: false,
    };

    // Initial: 2 Kłosok + 1 MPK = 3
    const r1 = await get('/locations?format=map');
    const etagA = etag(r1);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.count, 3);

    // At 90000: A expires, B fresh → 2 vehicles
    clock.setNow(90000);
    const r2 = await get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.count, 2, 'A evicted, B fresh');

    // At 135000: B expires → 1 vehicle
    clock.setNow(135000);
    const r3 = await get('/locations?format=map', { headers: { 'If-None-Match': etag(r2) } });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.count, 1, 'B evicted');
  });
});
