'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const config = require('../src/config');
const { GtfsStore } = require('../src/gtfs/store');
const { VehicleTracker, bearing, normalizeVehicle } = require('../src/vehicles');
const { buildFixtureZip } = require('./fixtures/gtfs');

describe('normalizeVehicle', () => {
  it('maps the MPK payload, where x is latitude', () => {
    const vehicle = normalizeVehicle({ x: 51.107, y: 17.038, name: '4', k: 8123, type: 'tram' });
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.id, '4-8123');
  });

  it('accepts alternative field names', () => {
    const vehicle = normalizeVehicle({ latitude: 51.1, longitude: 17.0, line: '128' });
    assert.equal(vehicle.line, '128');
    assert.equal(vehicle.type, 'bus');
  });

  it('uppercases letter lines so they match the timetable', () => {
    // MPK's feed reports express lines ("A", "K", "N") in lowercase, while the
    // GTFS route_short_name — and therefore /lines and the app's line picker —
    // carries them uppercase. The filter, the route matcher and the merge all
    // compare exact values, so the live name has to be normalised to match.
    const vehicle = normalizeVehicle({ x: 51.1, y: 17.0, name: 'a', k: 1 });
    assert.equal(vehicle.line, 'A');
    assert.equal(vehicle.type, 'busExpress');
    assert.equal(vehicle.id, 'A-1');
  });

  it('rejects positions outside Wrocław', () => {
    assert.equal(normalizeVehicle({ x: 0, y: 0, name: '4' }), null);
    assert.equal(normalizeVehicle({ x: 52.23, y: 21.0, name: '4' }), null, 'that is Warsaw');
    assert.equal(normalizeVehicle({ x: 'n/a', y: 'n/a', name: '4' }), null);
  });

  it('rejects records without a line', () => {
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0 }), null);
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0, name: '  ' }), null);
  });

  it('never throws on junk', () => {
    assert.equal(normalizeVehicle(null), null);
    assert.equal(normalizeVehicle('nope'), null);
    assert.equal(normalizeVehicle(undefined), null);
  });

  it('derives a stable id when the vehicle number is missing', () => {
    const a = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    const b = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    assert.equal(a.id, b.id);
  });
});

describe('bearing', () => {
  it('points north when moving north', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.2, 17.0)) < 1);
  });

  it('points east when moving east', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.1, 17.1) - 90) < 1);
  });
});

describe('VehicleTracker against a stand-in endpoint', () => {
  const lines = { allTrams: ['4'], allBuses: ['128'] };

  /**
   * Serves the endpoint the way MPK does: an unrecognised body encoding gets
   * an empty list rather than an error status.
   *
   * @param {(body: string) => object[] | null} handler
   */
  const startEndpoint = (handler) => {
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

  const originalSources = config.vehicles.sources;
  const servers = [];

  const trackerFor = async (handler) => {
    const server = await startEndpoint(handler);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];
    return new VehicleTracker(() => lines);
  };

  before(() => {
    // fetch() would otherwise be sent through any proxy configured in the env.
    process.env.NO_PROXY = '127.0.0.1,localhost';
  });

  after(() => {
    config.vehicles.sources = originalSources;
    servers.forEach((server) => server.close());
  });

  it('reads positions from the typed body encoding', async () => {
    const tracker = await trackerFor((body) =>
      body.includes('busList%5Bbus%5D%5B%5D')
        ? [{ name: '128', type: 'bus', x: 51.09, y: 17.03, k: 1 }]
        : [],
    );

    await tracker.poll();
    assert.equal(tracker.status.encoding, 'typed');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('falls back to the flat encoding when the typed one is rejected', async () => {
    // This is the failure the old client could not survive: the endpoint
    // answers 200 with an empty list instead of an error.
    const tracker = await trackerFor((body) =>
      body.includes('busList%5B%5D%5B%5D')
        ? [{ name: '4', type: 'tram', x: 51.11, y: 17.03, k: 2 }]
        : [],
    );

    await tracker.poll();
    assert.equal(tracker.status.encoding, 'flat');
    assert.equal(tracker.snapshot.locations[0].line, '4');
  });

  it('keeps the last snapshot and records the error when every encoding fails', async () => {
    const tracker = await trackerFor(() => []);

    await tracker.poll();
    assert.equal(tracker.status.consecutiveFailures, 1);
    assert.match(tracker.status.lastError, /typed:.*flat:/s);
    assert.deepEqual(tracker.snapshot.locations, []);
    assert.equal(tracker.snapshot.stale, true);
  });

  it('adds a heading once a vehicle has visibly moved', async () => {
    let step = 0;
    const tracker = await trackerFor(() => {
      step += 1;
      return [{ name: '4', type: 'tram', x: 51.11 + step * 0.002, y: 17.03, k: 7 }];
    });

    await tracker.poll();
    assert.equal(tracker.snapshot.locations[0].heading, null, 'no heading from one fix');

    await tracker.poll();
    assert.equal(tracker.snapshot.locations[0].heading, 0, 'moved north');
  });

  it('freezes lastUpdated while the fleet is unchanged and advances it when it moves', async () => {
    // /locations derives its ETag from the serialized body; lastUpdated is the
    // only field that changes every poll, so if it advanced with nothing moving
    // the app would re-download the whole fleet every ten seconds.
    let lat = 51.11;
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: lat, y: 17.03, k: 3 }]);

    await tracker.poll();
    const first = tracker.snapshot.lastUpdated;
    assert.ok(first, 'a successful poll stamps lastUpdated');

    await tracker.poll();
    assert.equal(tracker.snapshot.lastUpdated, first, 'an unchanged fleet keeps lastUpdated');

    lat += 0.01; // the tram moves
    await tracker.poll();
    assert.notEqual(tracker.snapshot.lastUpdated, first, 'a moved vehicle advances lastUpdated');
  });

  it('attaches the destination and next stop when a timetable is loaded', async () => {
    const gtfs = new GtfsStore();
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';

    // Between Świdnicka and Oporów on the outbound leg of tram 4.
    const server = await startEndpoint(() => [{ name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 }]);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    await tracker.poll();

    const [vehicle] = tracker.snapshot.locations;
    assert.equal(vehicle.trip.towards, 'Oporów');
    assert.equal(vehicle.trip.nextStop.name, 'Oporów');
    assert.equal(vehicle.trip.previousStop.name, 'Świdnicka');
    assert.equal(tracker.status.described, 1);
  });

  it('serves positions with no trip information when there is no timetable', async () => {
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 }]);
    await tracker.poll();

    assert.equal(tracker.snapshot.locations[0].trip, null);
    assert.equal(tracker.status.described, 0);
  });
});
