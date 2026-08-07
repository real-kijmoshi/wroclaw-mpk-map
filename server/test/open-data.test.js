'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { distanceMeters } = require('../src/gtfs/geo');
const {
  MAX_FUTURE_SKEW_MS,
  mergeFleet,
  normalizeOpenDataRecord,
  parseWarsawDate,
} = require('../src/open-data');
const { VehicleTracker } = require('../src/vehicles');

/** The wall clock in Wrocław as a naive "YYYY-MM-DD HH:mm:ss" string. */
const warsawWallClock = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

/** A fixed "now" so the freshness window does not drift while the test runs. */
const NOW = 1_752_900_000_000;

const freshAt = (secondsAgo) => warsawWallClock(new Date(NOW - secondsAgo * 1000));

const baseRow = (overrides = {}) => ({
  Nazwa_Linii: '4',
  Nr_Boczny: 8123,
  Brygada: '1',
  Data_Aktualizacji: freshAt(30),
  Ostatnia_Pozycja_Szerokosc: 51.107,
  Ostatnia_Pozycja_Dlugosc: 17.038,
  ...overrides,
});

const mpkVehicle = (id, lat, lon) => ({
  id,
  line: '4',
  type: 'tram',
  lat,
  lon,
  heading: null,
  updatedAt: NOW,
});

const odVehicle = (id, lat, lon) => ({
  id,
  line: '4',
  type: 'tram',
  lat,
  lon,
  vehicleNumber: 8123,
  brigade: '1',
  positionUpdatedAt: new Date(NOW - 30_000).toISOString(),
  updatedAt: NOW,
});

const MERGE_OPTIONS = { matchMaxMeters: 250, dedupeMeters: 350, ambiguityMeters: 75 };

describe('parseWarsawDate', () => {
  it('reads a bare wall clock as Europe/Warsaw summer time (UTC+2)', () => {
    const parsed = parseWarsawDate('2026-08-06 12:34:56');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('reads a bare wall clock as Europe/Warsaw winter time (UTC+1)', () => {
    const parsed = parseWarsawDate('2026-01-15 12:00:00');
    assert.equal(parsed.toISOString(), '2026-01-15T11:00:00.000Z');
  });

  it('honours an explicit timezone offset', () => {
    const parsed = parseWarsawDate('2026-08-06 12:34:56+02:00');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('treats a trailing Z as an absolute instant', () => {
    const parsed = parseWarsawDate('2026-08-06T10:34:56Z');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('accepts a numeric epoch', () => {
    const parsed = parseWarsawDate(NOW);
    assert.equal(parsed.getTime(), NOW);
  });

  it('rejects junk', () => {
    assert.equal(parseWarsawDate(''), null);
    assert.equal(parseWarsawDate('not a date'), null);
    assert.equal(parseWarsawDate(null), null);
    assert.equal(parseWarsawDate(undefined), null);
  });
});

describe('normalizeOpenDataRecord', () => {
  it('normalises a valid record', () => {
    const vehicle = normalizeOpenDataRecord(baseRow(), { now: NOW });
    assert.equal(vehicle.id, 'open-data:8123');
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.equal(vehicle.positionUpdatedAt, new Date(NOW - 30_000).toISOString());
  });

  it('rejects records with an empty line', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Nazwa_Linii: '' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nazwa_Linii: '  ' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord({}, { now: NOW }), null);
  });

  it('uppercases letter lines so they match the timetable', () => {
    // Mirrors normalizeVehicle: the line must equal the GTFS route_short_name
    // exactly, or the filter, the route matcher and the merge all miss it.
    const vehicle = normalizeOpenDataRecord(
      baseRow({ Nazwa_Linii: 'n' }),
      { now: NOW },
    );
    assert.equal(vehicle.line, 'N');
    assert.equal(vehicle.type, 'busExpress');
  });

  it('rejects records without a positive vehicle number', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: 0 }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: -3 }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: 'n/a' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: null }), { now: NOW }), null);
  });

  it('rejects missing or invalid coordinates', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Szerokosc: undefined }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Dlugosc: 'x' }), { now: NOW }), null);
    // 0,0 is the portal's "no fix" sentinel.
    assert.equal(
      normalizeOpenDataRecord(
        baseRow({ Ostatnia_Pozycja_Szerokosc: 0, Ostatnia_Pozycja_Dlugosc: 0 }),
        { now: NOW },
      ),
      null,
    );
    // Warsaw, not Wrocław.
    assert.equal(
      normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Szerokosc: 52.23, Ostatnia_Pozycja_Dlugosc: 21.0 }), { now: NOW }),
      null,
    );
  });

  it('drops positions older than 90 seconds', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: freshAt(91) }), { now: NOW }), null);
    assert.ok(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: freshAt(89) }), { now: NOW }));
  });

  it('drops timestamps from the distant future', () => {
    const tooFar = new Date(NOW + MAX_FUTURE_SKEW_MS + 1_000);
    assert.equal(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: warsawWallClock(tooFar) }), { now: NOW }), null);
    assert.ok(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: warsawWallClock(new Date(NOW + 5_000)) }), { now: NOW }));
  });

  it('never throws on junk', () => {
    assert.equal(normalizeOpenDataRecord(null, { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord('nope', { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(undefined, { now: NOW }), null);
  });
});

describe('mergeFleet', () => {
  it('merges an Open Data record onto the nearest same-line, same-type MPK vehicle', () => {
    // ~20 m apart.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', 51.10718, 17.03818)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    assert.equal(fleet.size, 1, 'one vehicle, not a duplicate');
    const merged = fleet.get('4-100');
    assert.equal(merged.id, '4-100', 'keeps the MPK id');
    assert.equal(merged.lat, 51.107, 'keeps the MPK position');
    assert.equal(merged.source, 'merged');
    assert.equal(merged.vehicleNumber, 8123);
    assert.equal(merged.brigade, '1');
    assert.ok(merged.positionUpdatedAt);
    assert.equal(fleet.has('open-data:8123'), false, 'no separate open-data entry');
    assert.deepEqual(stats, { mpk: 0, merged: 1, openData: 0, total: 1, activeLines: 1 });
  });

  it('leaves MPK vehicles with no matching record as source "mpk"', () => {
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const { fleet, stats } = mergeFleet(mpk, new Map(), MERGE_OPTIONS);

    assert.equal(fleet.get('4-100').source, 'mpk');
    assert.equal(fleet.get('4-100').vehicleNumber, undefined);
    assert.equal(stats.mpk, 1);
  });

  it('does not merge an Open Data record farther than 250 metres away', () => {
    // ~260 m apart — the same line, but not the same vehicle.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 260 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);
    assert.ok(distanceMeters(51.107, 17.038, odLat, 17.038) > 250);

    const mpkEntry = fleet.get('4-100');
    assert.equal(mpkEntry.source, 'mpk');
    assert.equal(mpkEntry.vehicleNumber, undefined);
    assert.equal(stats.merged, 0);
  });

  it('suppresses an unmatched record near any same-line MPK vehicle (no duplicate)', () => {
    // ~300 m away: too far to merge, near enough to be the same vehicle.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 300 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    assert.equal(fleet.size, 1, 'the record is dropped, not duplicated');
    assert.equal(fleet.has('open-data:8123'), false);
    assert.equal(stats.openData, 0);
  });

  it('adds a fresh unmatched record beyond 350 metres as an open-data vehicle', () => {
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 400 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    const vehicle = fleet.get('open-data:8123');
    assert.equal(vehicle.source, 'open-data');
    assert.equal(vehicle.id, 'open-data:8123');
    assert.equal(vehicle.lat, odLat);
    assert.equal(stats.openData, 1);
    assert.equal(stats.total, 2);
  });

  it('does not guess when two same-line vehicles are both plausible matches', () => {
    // Two trams of line 4 ~30 m apart; the record sits between them.
    const mpk = new Map([
      ['4-100', mpkVehicle('4-100', 51.107, 17.038)],
      ['4-101', mpkVehicle('4-101', 51.1071, 17.0381)],
    ]);
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', 51.10705, 17.03805)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    for (const id of ['4-100', '4-101']) {
      assert.equal(fleet.get(id).source, 'mpk', 'no guess, so no merge');
      assert.equal(fleet.get(id).vehicleNumber, undefined);
    }
    assert.equal(fleet.has('open-data:8123'), false, 'and it is not surfaced as a duplicate either');
    assert.equal(stats.merged, 0);
  });

  it('requires the same type before merging', () => {
    const mpk = new Map([['x-1', { ...mpkVehicle('x-1', 51.107, 17.038), line: 'X', type: 'tram' }]]);
    const od = new Map([
      [
        'open-data:8123',
        { ...odVehicle('open-data:8123', 51.1071, 17.0381), line: 'X', type: 'unknown' },
      ],
    ]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);
    assert.equal(fleet.get('x-1').source, 'mpk');
    assert.equal(stats.merged, 0);
  });
});

describe('VehicleTracker with two sources', () => {
  const lines = { allTrams: ['4'], allBuses: ['128'] };

  /** Serves MPK-style POST /bus_position. */
  const startMpkEndpoint = (handler) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handler(body) ?? []));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  };

  /** Serves the city-style GET endpoint with a `dane` list. */
  const startOpenDataEndpoint = (handler) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dane: handler() }));
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  };

  const originalSources = config.vehicles.sources;
  const originalOpenDataUrl = config.vehicles.openDataUrl;
  const servers = [];
  let mpkUrl;
  let openDataUrl;

  const freshRow = (overrides = {}) => ({
    Nazwa_Linii: '4',
    Nr_Boczny: 8123,
    Brygada: '1',
    Data_Aktualizacji: warsawWallClock(new Date(Date.now() - 30_000)),
    Ostatnia_Pozycja_Szerokosc: 51.107,
    Ostatnia_Pozycja_Dlugosc: 17.038,
    ...overrides,
  });

  before(async () => {
    const mpkServer = await startMpkEndpoint(() => [
      { name: '4', type: 'tram', x: 51.107, y: 17.038, k: 100 },
    ]);
    const odServer = await startOpenDataEndpoint(() => [freshRow()]);
    servers.push(mpkServer, odServer);
    mpkUrl = `http://127.0.0.1:${mpkServer.address().port}/bus_position`;
    openDataUrl = `http://127.0.0.1:${odServer.address().port}/hdb/db/14`;
    process.env.NO_PROXY = '127.0.0.1,localhost';
  });

  after(() => {
    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    servers.forEach((server) => server.close());
  });

  it('merges both sources and reports the stats', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.snapshot.count, 1, 'the two positions belong to the same vehicle');
    const vehicle = tracker.snapshot.locations[0];
    assert.equal(vehicle.id, '4-100');
    assert.equal(vehicle.source, 'merged');
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.ok(vehicle.positionUpdatedAt);
    assert.deepEqual(tracker.stats, { mpk: 0, merged: 1, openData: 0, total: 1, activeLines: 1 });
  });

  it('keeps serving MPK vehicles when the Open Data source fails', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = 'http://127.0.0.1:1/dead-od';

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.openDataStatus.consecutiveFailures, 1);
    assert.equal(tracker.snapshot.locations[0].source, 'mpk');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('keeps serving Open Data vehicles when the MPK source fails', async () => {
    config.vehicles.sources = ['http://127.0.0.1:1/dead-mpk'];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.status.consecutiveFailures, 1);
    assert.equal(tracker.snapshot.locations[0].id, 'open-data:8123');
    assert.equal(tracker.snapshot.locations[0].source, 'open-data');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('serves a merged fleet over /locations with the payload intact', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    const app = createApp({
      gtfs: { isReady: false, status: { state: 'loading' }, lines: {} },
      vehicles: tracker,
      alerts: { status: { providers: [] }, getAlerts: () => [] },
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const response = await fetch(`${base}/locations`);
    const body = await response.json();

    assert.equal(body.count, 1);
    const vehicle = body.locations[0];
    // The original fields are all still there…
    assert.equal(vehicle.id, '4-100');
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.ok('heading' in vehicle);
    assert.ok('trip' in vehicle);
    assert.ok('updatedAt' in vehicle);
    // …and the new ones ride along.
    assert.equal(vehicle.source, 'merged');
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.ok(vehicle.positionUpdatedAt);
  });

  it('stops both poll timers', async () => {
    let mpkPolls = 0;
    let odPolls = 0;
    const tracker = new VehicleTracker(() => lines);
    tracker.poll = async () => {
      mpkPolls += 1;
      return tracker.status;
    };
    tracker.pollOpenData = async () => {
      odPolls += 1;
      return tracker.openDataStatus;
    };

    tracker.start();
    assert.ok(tracker.timer, 'MPK timer is running');
    assert.ok(tracker.openDataTimer, 'Open Data timer is running');

    tracker.stop();
    assert.equal(tracker.timer, null);
    assert.equal(tracker.openDataTimer, null);

    const pollsAtStop = mpkPolls + odPolls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(mpkPolls + odPolls, pollsAtStop, 'no poll runs after stop()');
  });
});
