'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, beforeEach, describe, it } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { VehicleTracker } = require('../src/vehicles');
const { buildFixtureZip } = require('./fixtures/gtfs');
const { enrichDepartures, MAX_LIVE_AGE_MS } = require('../src/realtime-departures');

/* Override both Date.now and the Date constructor so that new Date() — used
 * by describeVehicle and getDepartures — picks up the fake time too. */
const useFakeTime = (iso) => {
  let fakeNow = new Date(iso).getTime();
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fakeNow);
      else super(...args);
    }
    static now() { return fakeNow; }
  }
  global.Date = FakeDate;
  return {
    now: fakeNow,
    set: (newNow) => { fakeNow = newNow; },
    uninstall: () => { global.Date = RealDate; },
  };
};

/* -------------------------------------------------------------------------- */
/*  Unit tests for enrichDepartures — no GTFS, no server                       */
/* -------------------------------------------------------------------------- */

describe('enrichDepartures', () => {
  // A fixed instant so "fresheness" checks are deterministic: 2026-06-15
  // 08:07 Warsaw (Monday, so the fixture's WEEKDAY service is active).
  const now = new Date('2026-06-15T06:07:00.000Z').getTime();

  const dep = (overrides = {}) => ({
    line: '4',
    type: 'tram',
    headsign: 'OPORÓW',
    departure: '08:15:00',
    inSeconds: 474,
    tripId: 't4a',
    serviceDay: 'today',
    ...overrides,
  });

  /** A vehicle entry as it sits in the nextStopIndex. */
  const veh = (overrides = {}) => ({
    vehicleId: '4-9',
    tripId: 't4a',
    etaSeconds: 280,
    line: '4',
    updatedAt: now,
    ...overrides,
  });

  /** Build a mock vehicles object from raw entries (each must carry `stopId`). */
  const mkVehicles = (entries, stale = false) => {
    const index = new Map();
    for (const entry of entries) {
      const { stopId, ...rest } = entry;
      const bucket = index.get(stopId) || [];
      bucket.push(rest);
      index.set(stopId, bucket);
    }
    return { snapshot: { stale }, nextStopIndex: index };
  };

  const assertScheduled = (d) => {
    assert.equal(d.realtime, false, 'realtime should be false');
    assert.equal(d.predictedInSeconds, null, 'predictedInSeconds should be null');
    assert.equal(d.vehicleId, null, 'vehicleId should be null');
  };

  const assertRealtime = (d, eta, vid = '4-9') => {
    assert.equal(d.realtime, true, 'realtime should be true');
    assert.equal(d.predictedInSeconds, eta, 'predictedInSeconds should match vehicle eta');
    assert.equal(d.vehicleId, vid, 'vehicleId should match');
  };

  it('matches a live vehicle on the same trip and next stop', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ tripId: 't4a', etaSeconds: 280 }) },
    ]);
    const departures = [
      dep({ tripId: 't4a', inSeconds: 474 }),
      dep({ tripId: 't4b', headsign: 'BISKUPIN', departure: '10:00:00', inSeconds: 6774 }),
    ];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertRealtime(result[0], 280);
    assertScheduled(result[1]);
    // Existing fields are untouched.
    assert.equal(result[0].inSeconds, 474, 'inSeconds preserved on live row');
    assert.equal(result[1].inSeconds, 6774, 'inSeconds preserved on scheduled row');
    assert.equal(result[0].tripId, 't4a', 'tripId preserved');
    assert.equal(result[0].line, '4', 'line preserved');
  });

  it('same line, wrong trip => scheduled', () => {
    const vehicles = mkVehicles([{ stopId: '1', ...veh({ tripId: 't4a' }) }]);
    const departures = [dep({ tripId: 't4a2', departure: '09:00:00', inSeconds: 1800 })];

    const result = enrichDepartures(departures, '1', vehicles, now);

    assertScheduled(result[0]);
  });

  it('exact trip but requested stop is later => scheduled', () => {
    // The vehicle's next stop is '3' (Oporów), so it lives in stop 3's bucket.
    // Querying stop '1' (Rynek) finds nothing for this trip.
    const vehicles = mkVehicles([{ stopId: '3', ...veh({ tripId: 't4a' }) }]);
    const departures = [dep({ tripId: 't4a', inSeconds: 300 })];

    const result = enrichDepartures(departures, '1', vehicles, now);

    assertScheduled(result[0]);
  });

  it('stale fleet => scheduled for every row', () => {
    const vehicles = mkVehicles([{ stopId: '3', ...veh({ tripId: 't4a' }) }], /* stale */ true);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertScheduled(result[0]);
  });

  it('old vehicle observation (>45s) => scheduled', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ updatedAt: now - MAX_LIVE_AGE_MS - 1 }) },
    ]);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertScheduled(result[0]);
  });

  it('vehicle observed exactly 45s ago is still live', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ updatedAt: now - MAX_LIVE_AGE_MS }) },
    ]);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertRealtime(result[0], 280);
  });

  it('negative or non-finite etaSeconds => scheduled', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ etaSeconds: -5 }) },
      { stopId: '3', ...veh({ vehicleId: '4-10', etaSeconds: NaN }) },
    ]);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertScheduled(result[0]);
  });

  it('two vehicles on the same trip — the freshest wins', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ vehicleId: '4-old', updatedAt: now - 10_000, etaSeconds: 280 }) },
      { stopId: '3', ...veh({ vehicleId: '4-fresh', updatedAt: now, etaSeconds: 120 }) },
    ]);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertRealtime(result[0], 120, '4-fresh');
  });

  it('two vehicles with identical updatedAt on same trip => scheduled (ambiguous)', () => {
    const vehicles = mkVehicles([
      { stopId: '3', ...veh({ vehicleId: '4-a', updatedAt: now, etaSeconds: 280 }) },
      { stopId: '3', ...veh({ vehicleId: '4-b', updatedAt: now, etaSeconds: 120 }) },
    ]);
    const departures = [dep({ tripId: 't4a' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertScheduled(result[0]);
  });

  it('no live vehicles for the stop => all departures scheduled only', () => {
    const vehicles = mkVehicles([]);
    const departures = [dep({ tripId: 't4a' }), dep({ tripId: 't4b' })];

    const result = enrichDepartures(departures, '3', vehicles, now);

    for (const d of result) {
      assertScheduled(d);
    }
    assert.equal(result[0].inSeconds, 474, 'inSeconds unchanged');
    assert.equal(result[0].tripId, 't4a', 'tripId unchanged');
    assert.equal(result[0].line, '4', 'line unchanged');
  });

  it('yesterday-scheduled departure still matches a live vehicle', () => {
    const vehicles = mkVehicles([{ stopId: '1', ...veh({ tripId: 'tn1' }) }]);
    const departures = [dep({ tripId: 'tn1', serviceDay: 'yesterday', line: '240', inSeconds: 5400 })];

    const result = enrichDepartures(departures, '1', vehicles, now);

    assertRealtime(result[0], 280);
  });

  it('null or missing vehicles => all departures scheduled', () => {
    const departures = [dep({ tripId: 't4a' })];

    assert.deepEqual(
      enrichDepartures(departures, '3', null, now)[0],
      { ...dep({ tripId: 't4a' }), realtime: false, predictedInSeconds: null, vehicleId: null },
    );
  });

  it('empty departures => empty result', () => {
    assert.deepEqual(enrichDepartures([], '3', mkVehicles([]), now), []);
  });

  it('departure without a tripId => scheduled', () => {
    const vehicles = mkVehicles([{ stopId: '3', ...veh({ tripId: 't4a' }) }]);
    const departures = [{ line: '4', type: 'tram', headsign: null, departure: '08:00:00', inSeconds: 300, tripId: '' }];

    const result = enrichDepartures(departures, '3', vehicles, now);

    assertScheduled(result[0]);
  });
});

/* -------------------------------------------------------------------------- */
/*  VehicleTracker integration — nextStopIndex is built during snapshot       */
/* -------------------------------------------------------------------------- */

describe('VehicleTracker nextStopIndex', () => {
  const originalSources = config.vehicles.sources;
  const originalOpenDataUrl = config.vehicles.openDataUrl;
  const gtfs = new GtfsStore();
  const lines = { allTrams: ['4'], allBuses: ['128'] };
  const servers = [];

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
  });

  after(() => {
    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    servers.forEach((server) => server.close());
  });

  beforeEach(() => {
    config.vehicles.openDataUrl = null;
  });

  const startEndpoint = (handler) =>
    new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handler(body) ?? []));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

  const withTime = async (iso, fn) => {
    const clock = useFakeTime(iso);
    try {
      await fn();
    } finally {
      clock.uninstall();
    }
  };

  it('indexes a described vehicle under its next stop', async () => {
    const server = await startEndpoint(() => [
      { name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 },
    ]);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    await withTime('2026-06-15T06:07:00Z', async () => {
      await tracker.poll();
    });

    // Between Świdnicka (stop 2) and Oporów (stop 3) on s4a at 08:07.
    const entries = tracker.nextStopIndex.get('3');
    assert.ok(entries, 'Oporów (stop 3) should be indexed');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tripId, 't4a');
    assert.equal(entries[0].vehicleId, '4-9');
    assert.ok(Number.isFinite(entries[0].etaSeconds) && entries[0].etaSeconds > 0);
    assert.equal(entries[0].line, '4');

    // Świdnicka should not be indexed — it was already passed.
    assert.equal(tracker.nextStopIndex.get('2'), undefined);
  });

  it('does not index a vehicle with no matched trip', async () => {
    // At 01:30 nothing is running, so describeVehicle finds no trip.
    const server = await startEndpoint(() => [
      { name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 },
    ]);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    await withTime('2026-06-15T01:30:00Z', async () => {
      await tracker.poll();
    });

    // No trip => no entries in the index at all.
    assert.equal(tracker.nextStopIndex.size, 0);
  });

  it('index is rebuilt (not accumulated) on each successful poll', async () => {
    const server = await startEndpoint(() => [
      { name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 },
    ]);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    await withTime('2026-06-15T06:07:00Z', async () => {
      await tracker.poll();
      assert.ok(tracker.nextStopIndex.size > 0, 'index populated after first poll');
      const sizeAfterFirst = tracker.nextStopIndex.size;

      // Second poll returns the same vehicle — index must be rebuilt, not
      // appended, so the entry count stays the same.
      await tracker.poll();
      assert.equal(tracker.nextStopIndex.size, sizeAfterFirst, 'index rebuilt, not accumulated');
    });
  });

  it('drops a stale vehicle from the index', async () => {
    let callCount = 0;
    const server = await startEndpoint(() => {
      callCount += 1;
      return callCount === 1
        // First poll: a tram on line 4 between Świdnicka and Oporów (stop 3).
        ? [{ name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 }]
        // Second poll: tram is gone, replaced by a bus far from any stop so
        // it keeps the poll alive but matches no trip. The stale tram must
        // vanish from the rebuilt index.
        : [{ name: '128', type: 'bus', x: 50.0, y: 16.0, k: 9 }];
    });
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    const clock = useFakeTime('2026-06-15T06:07:00Z');
    try {
      await tracker.poll();
      assert.ok(tracker.nextStopIndex.has('3'), 'vehicle indexed under next stop');

      // Advance 200 s past first observation — beyond staleAfterMs (120 s)
      // but short of staleAfterMs * 2 (240 s), so the tram lingers in the
      // MPK fleet yet must be dropped from the rebuilt snapshot index.
      clock.set(clock.now + 200_000);

      await tracker.poll();
      assert.equal(tracker.nextStopIndex.get('3'), undefined, 'stale vehicle dropped');
    } finally {
      clock.uninstall();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  HTTP integration — GET /stop/:id/departures                               */
/* -------------------------------------------------------------------------- */

describe('GET /stop/:id/departures (live enrich)', () => {
  let clock;
  let testNow;
  let gtfs;
  const servers = [];

  before(async () => {
    // 2026-06-15 07:55 Warsaw — t4a (08:00) and t4a2 (09:00) are upcoming at stop 1.
    clock = useFakeTime('2026-06-15T05:55:00.000Z');
    testNow = clock.now;
    gtfs = new GtfsStore();
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
  });

  after(async () => {
    clock.uninstall();
    await Promise.all(servers.map((srv) => srv.close()));
  });

  const makeApp = (vehicles) => {
    const app = createApp({
      startedAt: new Date(testNow),
      gtfs,
      vehicles,
      alerts: { status: { providers: [], lastRefreshAt: null, count: 0 }, getAlerts: () => [] },
    });
    const srv = app.listen(0, '127.0.0.1');
    servers.push(srv);
    return new Promise((resolve) => srv.once('listening', resolve));
  };

  const get = async (base, path) => {
    const response = await fetch(`${base}${path}`);
    const body = response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  it('enriches a matching departure with live data', async () => {
    const vehicles = {
      snapshot: { stale: false },
      nextStopIndex: new Map([
        ['1', [
          { vehicleId: '4-9', tripId: 't4a', etaSeconds: 280, line: '4', updatedAt: testNow },
        ]],
      ]),
    };
    await makeApp(vehicles);
    const addr = servers[servers.length - 1].address();
    const base = `http://127.0.0.1:${addr.port}`;

    const { body } = await get(base, '/stop/1/departures?limit=5');

    assert.equal(body.stop.name, 'Rynek');
    assert.ok(Array.isArray(body.departures));

    const t4a = body.departures.find((d) => d.tripId === 't4a');
    assert.ok(t4a, 't4a departure present');
    assert.equal(t4a.realtime, true, 't4a gets a live ETA');
    assert.equal(t4a.predictedInSeconds, 280);
    assert.equal(t4a.vehicleId, '4-9');
    // Schedule value is untouched.
    assert.equal(t4a.inSeconds, 300, 'scheduled inSeconds still present');

    const t4a2 = body.departures.find((d) => d.tripId === 't4a2');
    assert.ok(t4a2, 't4a2 departure present');
    assert.equal(t4a2.realtime, false, 'wrong trip stays scheduled');
    assert.equal(t4a2.predictedInSeconds, null);
    assert.equal(t4a2.vehicleId, null);
  });

  it('serves all-scheduled when the fleet is stale', async () => {
    const vehicles = {
      snapshot: { stale: true },
      nextStopIndex: new Map([
        ['1', [
          { vehicleId: '4-9', tripId: 't4a', etaSeconds: 280, line: '4', updatedAt: testNow },
        ]],
      ]),
    };
    await makeApp(vehicles);
    const addr = servers[servers.length - 1].address();
    const base = `http://127.0.0.1:${addr.port}`;

    const { body } = await get(base, '/stop/1/departures?limit=5');

    for (const d of body.departures) {
      assert.equal(d.realtime, false, 'stale fleet => all scheduled');
      assert.equal(d.predictedInSeconds, null);
      assert.equal(d.vehicleId, null);
    }
  });

  it('preserves existing fields when no live vehicle matches', async () => {
    const vehicles = {
      snapshot: { stale: false },
      nextStopIndex: new Map(),
    };
    await makeApp(vehicles);
    const addr = servers[servers.length - 1].address();
    const base = `http://127.0.0.1:${addr.port}`;

    const { body } = await get(base, '/stop/1/departures?limit=5');

    for (const d of body.departures) {
      assert.equal(d.realtime, false);
      assert.equal(d.predictedInSeconds, null);
      assert.equal(d.vehicleId, null);
      assert.ok(typeof d.line === 'string');
      assert.ok(typeof d.tripId === 'string');
      assert.equal(typeof d.inSeconds, 'number');
      assert.equal(typeof d.departure, 'string');
    }
  });
});
