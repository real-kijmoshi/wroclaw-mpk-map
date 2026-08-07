'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const {
  discoverLiveTrips,
  encodeTripExecutionId,
  fetchLiveVehicles,
} = require('../src/kd/publicRealtime');

describe('KD public realtime — encodeTripExecutionId', () => {
  it('base64-encodes the trip_execution_id, matching the site\'s own JS', () => {
    // Verified against kiedyprzyjedzie.pl's departures.<hash>.js: btoa(String.fromCharCode(...new TextEncoder().encode(id))).
    assert.equal(encodeTripExecutionId('69244:739835:0'), 'NjkyNDQ6NzM5ODM1OjA=');
  });

  it('round-trips through Buffer', () => {
    const encoded = encodeTripExecutionId('60373/2:1:0');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '60373/2:1:0');
  });
});

describe('KD public realtime — fetchLiveVehicles against a stand-in server', () => {
  let server;
  let baseUrl;
  let requestsLog;

  const departuresRow = (overrides = {}) => ({
    time: '19:35',
    static_time: '19:35',
    time_diff: 0,
    at_stop: false,
    canceled: false,
    is_estimated: false,
    before_trip_start: true,
    platform: 'I',
    line_name: 'D6',
    trip_id: 100001,
    trip_execution_id: '100001:1:0',
    trip_index: 0,
    train: { num: '100001' },
    ...overrides,
  });

  const tripExecutionFixture = (overrides = {}) => ({
    trip: {
      times: [
        { stop_name: 'Wrocław Główny', index: 0 },
        { stop_name: 'Oleśnica', index: 1 },
        { stop_name: 'Kępno', index: 2 },
      ],
      line: { name: 'D6', type: 'train', show_name: true },
      train: { num: '100001' },
    },
    vehicle: { lat: 51.2, lon: 17.4 },
    before_trip_start: false,
    at_stop: false,
    estimated: true,
    vehicle_trip_index: 1,
    next_departure_index: 2,
    estimates: [{ time_diff: 0 }, { time_diff: 0 }, { time_diff: 3 }],
    ...overrides,
  });

  before(async () => {
    requestsLog = [];
    server = http.createServer((req, res) => {
      requestsLog.push(req.url);
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/api/departures') {
        const places = (url.searchParams.get('places') || '').split(',').filter(Boolean);

        if (places.includes('bad-batch')) {
          res.writeHead(502);
          res.end('<html>bad gateway</html>');
          return;
        }

        if (places.includes('1')) {
          res.end(
            JSON.stringify({
              status: 'ok',
              departures: [
                {
                  designator: 1,
                  rows: [
                    departuresRow({ trip_execution_id: 'live-trip:1:0', trip_id: 200002, is_estimated: true, before_trip_start: false }),
                    departuresRow({ trip_execution_id: 'not-started:1:0', trip_id: 200003 }),
                    departuresRow({ trip_execution_id: 'cancelled:1:0', trip_id: 200004, is_estimated: true, before_trip_start: false, canceled: true }),
                  ],
                },
              ],
            }),
          );
          return;
        }

        if (places.includes('2')) {
          res.end(
            JSON.stringify({
              status: 'ok',
              departures: [
                {
                  designator: 2,
                  // Same live trip seen again further down its route — must dedupe.
                  rows: [
                    departuresRow({ trip_execution_id: 'live-trip:1:0', trip_id: 200002, is_estimated: true, before_trip_start: false }),
                  ],
                },
              ],
            }),
          );
          return;
        }

        res.end(JSON.stringify({ status: 'ok', departures: [] }));
        return;
      }

      if (url.pathname.startsWith('/api/trip_execution/')) {
        const [, , , encoded] = url.pathname.split('/');
        const tripExecutionId = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8');

        if (tripExecutionId === 'live-trip:1:0') {
          res.end(JSON.stringify(tripExecutionFixture()));
          return;
        }
        if (tripExecutionId === 'no-vehicle:1:0') {
          res.end(JSON.stringify(tripExecutionFixture({ vehicle: null })));
          return;
        }

        res.writeHead(400);
        res.end('<html>400 Bad Request</html>');
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('finds only rows that are actually live: is_estimated, not before_trip_start, not canceled', async () => {
    const live = await discoverLiveTrips(baseUrl, ['1'], { chunkSize: 150, timeoutMs: 5000 });
    assert.deepEqual([...live.keys()], ['live-trip:1:0']);
  });

  it('dedupes the same trip seen at multiple stations across chunks', async () => {
    const live = await discoverLiveTrips(baseUrl, ['1', '2'], { chunkSize: 1, timeoutMs: 5000 });
    assert.equal(live.size, 1);
    assert.ok(live.has('live-trip:1:0'));
  });

  it('returns a normalised vehicle with the base64-encoded trip fetched correctly', async () => {
    const vehicles = await fetchLiveVehicles({ baseUrl, stationIds: ['1'], chunkSize: 150, timeoutMs: 5000 });
    assert.equal(vehicles.length, 1);
    const vehicle = vehicles[0];
    assert.equal(vehicle.id, 'kd:vehicle:public:live-trip:1:0');
    assert.equal(vehicle.operator, 'KD');
    assert.equal(vehicle.type, 'train');
    assert.equal(vehicle.line, 'D6');
    assert.equal(vehicle.tripId, '200002');
    assert.equal(vehicle.lat, 51.2);
    assert.equal(vehicle.lon, 17.4);
    assert.equal(vehicle.destination, 'Kępno');
    assert.equal(vehicle.delaySeconds, 180, 'estimates[next_departure_index].time_diff (minutes) * 60');
    assert.equal(vehicle.source, 'kd-public-kiedyprzyjedzie');
  });

  it('skips a batch that fails without losing the others', async () => {
    const vehicles = await fetchLiveVehicles({
      baseUrl,
      stationIds: ['bad-batch', '1'],
      chunkSize: 1,
      timeoutMs: 5000,
    });
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].tripId, '200002');
  });

  it('drops a trip whose position comes back non-finite', async () => {
    const server2 = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/departures') {
        res.end(
          JSON.stringify({
            status: 'ok',
            departures: [
              {
                designator: 9,
                rows: [
                  departuresRow({ trip_execution_id: 'no-vehicle:1:0', trip_id: 300001, is_estimated: true, before_trip_start: false }),
                ],
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify(tripExecutionFixture({ vehicle: null })));
    });
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    try {
      const url2 = `http://127.0.0.1:${server2.address().port}`;
      const vehicles = await fetchLiveVehicles({ baseUrl: url2, stationIds: ['1'], chunkSize: 150, timeoutMs: 5000 });
      assert.equal(vehicles.length, 0);
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });
});
