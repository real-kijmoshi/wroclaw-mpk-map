'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const { buildKdFixtureZip } = require('./fixtures/kd-gtfs');

/**
 * KdService's public-realtime fallback (src/kd/publicRealtime.js), exercised
 * through the service so #resolvePublicTrip + #enrichVehicle are covered
 * together: a vehicle from the public source should end up looking exactly
 * like one from official GTFS-RT once it is joined back to the static feed.
 */
describe('KdService — public realtime fallback', () => {
  let server;
  let KdService;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/api/departures') {
        res.end(
          JSON.stringify({
            status: 'ok',
            departures: [
              {
                designator: 1,
                rows: [
                  {
                    is_estimated: true,
                    before_trip_start: false,
                    canceled: false,
                    line_name: 'D6',
                    // Matches the fixture's trip "t1" (server/test/fixtures/kd-gtfs.js),
                    // whose headsign is "Wrocław Główny" — the join under test.
                    trip_id: 't1',
                    trip_execution_id: 'exec:1:0',
                    train: { num: 't1' },
                  },
                ],
              },
            ],
          }),
        );
        return;
      }

      if (url.pathname.startsWith('/api/trip_execution/')) {
        res.end(
          JSON.stringify({
            trip: {
              times: [{ stop_name: 'A' }, { stop_name: 'B' }],
              line: { name: 'D6' },
              train: { num: 't1' },
            },
            vehicle: { lat: 51.09, lon: 17.03 },
            next_departure_index: 1,
            estimates: [{ time_diff: 0 }, { time_diff: 2 }],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    process.env.KD_GTFS_RT_URL = '';
    process.env.KD_PUBLIC_RT_ENABLED = 'true';
    process.env.KD_PUBLIC_RT_BASE_URL = `http://127.0.0.1:${server.address().port}`;

    // Fresh require so the env vars above are the ones config.js reads.
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/kd/service')];
    delete require.cache[require.resolve('../src/kd/publicRealtime')];
    ({ KdService } = require('../src/kd/service'));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('joins a public vehicle to the static trip and enriches line + headsign from it', async () => {
    const service = new KdService();
    await service.static.build(buildKdFixtureZip());
    service.static.status.state = 'ready';

    await service.pollRealtime();

    assert.equal(service.snapshot.count, 1);
    assert.equal(service.snapshot.source, 'kd-public-kiedyprzyjedzie');

    const vehicle = service.snapshot.locations[0];
    assert.equal(vehicle.id, 'kd:vehicle:public:exec:1:0');
    assert.equal(vehicle.line, 'D6');
    // "Wrocław Główny" is trip t1's static headsign — proof the vehicle got
    // joined to the GTFS trip rather than staying on the public API's own
    // "B" (its last stop_name), which #enrichVehicle only uses as a fallback.
    assert.equal(vehicle.destination, 'Wrocław Główny');
    assert.equal(vehicle.delaySeconds, 120);
    assert.equal(vehicle.operator, 'KD');
    assert.equal(vehicle.type, 'train');
  });

  it('reports the fallback in realtimeStatus', async () => {
    const service = new KdService();
    await service.static.build(buildKdFixtureZip());
    service.static.status.state = 'ready';

    await service.pollRealtime();

    assert.equal(service.realtimeStatus.mode, 'public-fallback');
    assert.equal(service.realtimeStatus.state, 'ready');
    assert.equal(service.realtimeStatus.vehiclePositions, 1);
  });

  it('getTrip() serves the joined trip for a public-fallback vehicle', async () => {
    const service = new KdService();
    await service.static.build(buildKdFixtureZip());
    service.static.status.state = 'ready';
    await service.pollRealtime();

    const detail = service.getTrip('kd:vehicle:public:exec:1:0');
    assert.ok(detail);
    assert.equal(detail.trip.headsign, 'Wrocław Główny');
    assert.ok(Array.isArray(detail.trip.stopsAhead));
  });
});
