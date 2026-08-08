'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { KlosokService } = require('../src/klosok/service');
const { shapeCache } = require('../src/routes');

let fakeNow = 0;
const realDateNow = Date.now;

const installFakeDate = () => {
  Date.now = () => fakeNow;
};
const restoreDate = () => { Date.now = realDateNow; };

const mkVehicle = (id, positionUpdatedAt, overrides = {}) => ({
  id: `klosok:${id}`,
  operator: 'Kłosówka',
  type: 'bus',
  line: '150',
  routeId: 'route:1',
  tripId: 'trip:1',
  tripHeadsign: 'Dworzec',
  vehicleId: `vid:${id}`,
  vehicleLabel: null,
  lat: 51.12,
  lon: 17.04,
  heading: 180,
  destination: 'Dworzec',
  delaySeconds: 0,
  currentStopSequence: 2,
  positionUpdatedAt,
  source: 'klosok-gtfs-rt',
  brigade: 'B1',
  updatedAt: positionUpdatedAt,
  ...overrides,
});

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

describe('Kłosok age-based expiry (fake clock)', () => {
  let originalConfig;

  beforeEach(() => {
    originalConfig = {
      enabled: config.klosok.enabled,
      gtfsRtUrl: config.klosok.gtfsRtUrl,
      maxAgeMs: config.klosok.maxAgeMs,
    };
    config.klosok.enabled = true;
    config.klosok.gtfsRtUrl = 'https://mapadlugoleka.klosok.eu/vehicle_positions.pb';
    config.klosok.maxAgeMs = 90000; // 90 s
    fakeNow = 0;
    installFakeDate();
  });

  afterEach(() => {
    restoreDate();
    config.klosok.enabled = originalConfig.enabled;
    config.klosok.gtfsRtUrl = originalConfig.gtfsRtUrl;
    config.klosok.maxAgeMs = originalConfig.maxAgeMs;
  });

  it('fresh vehicle served from cache until maxAgeMs, then evicted', async () => {
    const klosok = new KlosokService();
    klosok.snapshot = {
      locations: [mkVehicle('v1', new Date(0).toISOString())],
      count: 1,
      lastUpdated: new Date(0).toISOString(),
      stale: false,
      source: 'klosok-gtfs-rt',
    };

    const vehicles = {
      snapshot: { locations: [], count: 0, lastUpdated: new Date(0).toISOString(), source: 'mpk', stale: false },
      mapRevision: 0,
      fullRevision: 0,
      pollRevision: 0,
      getVehicle: () => null,
    };

    const app = await startApp({ gtfs: null, vehicles, kd: null, klosok, alerts: { status: {}, getAlerts: () => [] } });
    try {
      // t = 0: fresh vehicle, first response
      const r1 = await app.get('/locations?format=map');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.locations.length, 1, 'one Kłosok vehicle present');
      const etagA = r1.headers.get('etag');
      assert.ok(etagA);

      // t = 89999: still fresh, should 304
      fakeNow = 89999;
      const r2 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
      assert.equal(r2.status, 304, 'still fresh → 304');

      // t = 90000: vehicle expired, cache invalidated
      fakeNow = 90000;
      const r3 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
      assert.equal(r3.status, 200, 'expired vehicle triggers new response');
      assert.notEqual(r3.headers.get('etag'), etagA, 'new ETag after expiry');
      assert.equal(r3.body.locations.length, 0, 'expired vehicle is absent');
      const etagB = r3.headers.get('etag');

      // t = 90000: unchanged, should 304 again
      const r4 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagB } });
      assert.equal(r4.status, 304, 'after eviction, unchanged still 304');
    } finally {
      await app.stop();
    }
  });

  it('two vehicles with different expiry times expire independently', async () => {
    const oldTs = new Date(0).toISOString();        // expires at 0 + 90000 = 90000
    const newTs = new Date(45000).toISOString();    // expires at 45000 + 90000 = 135000

    const klosok = new KlosokService();
    klosok.snapshot = {
      locations: [mkVehicle('a', oldTs), mkVehicle('b', newTs)],
      count: 2,
      lastUpdated: oldTs,
      stale: false,
      source: 'klosok-gtfs-rt',
    };

    const vehicles = {
      snapshot: { locations: [], count: 0, lastUpdated: new Date(0).toISOString(), source: 'mpk', stale: false },
      mapRevision: 0,
      fullRevision: 0,
      pollRevision: 0,
      getVehicle: () => null,
    };

    const app = await startApp({ gtfs: null, vehicles, kd: null, klosok, alerts: { status: {}, getAlerts: () => [] } });
    try {
      // t = 0: both fresh
      const r1 = await app.get('/locations?format=map');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.locations.length, 2, 'two Kłosok vehicles present');
      const etagA = r1.headers.get('etag');

      // t = 89999: both still fresh → 304
      fakeNow = 89999;
      const r2 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagA } });
      assert.equal(r2.status, 304);

      // t = 90000: first vehicle expired, second still fresh
      fakeNow = 90000;
      const r3 = await app.get('/locations?format=map');
      assert.equal(r3.status, 200);
      assert.notEqual(r3.headers.get('etag'), etagA, 'ETag changed after first expiry');
      assert.equal(r3.body.locations.length, 1, 'only the fresh vehicle remains');
      const etagB = r3.headers.get('etag');

      // t = 90000: unchanged → 304
      const r4 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagB } });
      assert.equal(r4.status, 304, 'unchanged after first expiry → 304');

      // t = 135000: second vehicle also expired
      fakeNow = 135000;
      const r5 = await app.get('/locations?format=map');
      assert.equal(r5.status, 200);
      assert.equal(r5.body.locations.length, 0, 'both vehicles expired');
      assert.notEqual(r5.headers.get('etag'), etagB, 'ETag changed again');

      // t = 135000: unchanged → 304
      const etagC = r5.headers.get('etag');
      const r6 = await app.get('/locations?format=map', { headers: { 'If-None-Match': etagC } });
      assert.equal(r6.status, 304, 'unchanged after both expired → 304');
    } finally {
      await app.stop();
    }
  });
});
