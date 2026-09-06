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
  openDataStatus: {
    source: 'https://open-data.cui.wroclaw.pl/hdb/db/14?download=json',
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    count: 0,
  },
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
        trip: {
          headsign: 'Oporów',
          towards: 'Oporów',
          nextStop: { id: '2', name: 'Świdnicka' },
        },
        updatedAt: null,
      },
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
  performanceSnapshot: () => ({
    totalPollMs: { latest: 1.5, ewma: 1.5, max: 1.5, count: 1 },
    fetchMs: { latest: 1.0, ewma: 1.0, max: 1.0, count: 1 },
    acceptedVehicleCount: { latest: 2, ewma: 2, max: 2, count: 1 },
  }),
  openDataPerformanceSnapshot: () => ({
    totalPollMs: { latest: 2.0, ewma: 2.0, max: 2.0, count: 1 },
    fetchMs: { latest: 1.0, ewma: 1.0, max: 1.0, count: 1 },
    acceptedVehicleCount: { latest: 1, ewma: 1, max: 1, count: 1 },
  }),
};

const fakeIncidentStatus = {
  enabled: false,
  provider: 'off',
  model: null,
  lastSuccessAt: null,
  lastError: 'AI alerts are disabled',
  incidentCount: 1,
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 1, aiIncidents: fakeIncidentStatus },
  incidentStatus: fakeIncidentStatus,
  getAlerts: ({ since = 0, line = null } = {}) =>
    [{ id: 'a1', content: 'Linia 4 objazd', timestamp: 1_000, affected: ['4'], url: null, source: 'test' }].filter(
      (alert) => alert.timestamp >= since && (!line || alert.affected.includes(line)),
    ),
  getIncidents: ({ since = 0, line = null, status = null } = {}) =>
    [{
      id: 'incident-a1',
      status: 'active',
      affected: ['4'],
      lastUpdatedAt: 1_000,
      timeline: [],
    }].filter(
      (incident) =>
        incident.lastUpdatedAt >= since &&
        (!line || incident.affected.includes(line)) &&
        (!status || incident.status === status),
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

  it('serves a map-only vehicle payload without progress metadata', async () => {
    const { body } = await get('/locations?format=map&line=4');
    assert.equal(body.count, 1);
    assert.deepEqual(body.locations[0], {
      id: '4-1',
      line: '4',
      type: 'tram',
      lat: 51.11,
      lon: 17.032,
      heading: 90,
      trip: { headsign: 'Oporów', towards: 'Oporów' },
    });
    assert.equal('updatedAt' in body.locations[0], false);
    assert.equal('nextStop' in body.locations[0].trip, false);
  });

  it('never lets a client cache live positions', async () => {
    const { headers } = await get('/locations');
    assert.equal(headers.get('cache-control'), 'no-store');
  });

  it('answers 304 when the fleet has not changed', async () => {
    // The app sends the ETag it holds back on every poll, so an unchanged
    // fleet must answer 304 — otherwise the whole 10–25 KB body is re-sent
    // every ten seconds for nothing.
    const first = await get('/locations');
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag, '/locations carries an ETag');

    const second = await fetch(`${base}/locations`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
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

  it('picks the direction the vehicle is running when given a heading', async () => {
    // Both directions of line 4 meet at Oporów. The heading is what separates
    // them — and it has to be part of the cache key, or the second caller is
    // served the first one's direction.
    const arriving = await get('/shapes/4?lat=51.081&lon=16.983&heading=231&format=compact');
    assert.equal(arriving.body.shapeId, 's4a');

    const leaving = await get('/shapes/4?lat=51.081&lon=16.983&heading=78&format=compact');
    assert.equal(leaving.body.shapeId, 's4b');
  });

  it('describes a tracked vehicle, its destination and its remaining stops', async () => {
    const { status, body } = await get('/vehicle/4-1');
    assert.equal(status, 200);
    assert.equal(body.vehicle.line, '4');
    assert.equal(body.trip.towards, 'Oporów');
    assert.equal(body.trip.atStop.name, 'Rynek', 'it is sitting at the first stop');
    assert.deepEqual(
      body.trip.nextStops.map((stop) => stop.name),
      ['Świdnicka', 'Oporów'],
    );
    assert.ok(body.trip.nextStops.every((stop) => stop.etaSeconds >= 0));
  });

  it('404s for a vehicle that is not being tracked', async () => {
    assert.equal((await get('/vehicle/4-nope')).status, 404);
  });

  it('serves a repeated /vehicle/:id request from the detail cache', async () => {
    const first = await get('/vehicle/4-1');
    const second = await get('/vehicle/4-1');
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body, 'an unmoved vehicle answers identically');

    const health = await get('/health');
    assert.ok(
      health.body.vehicleDetailCacheEntries >= 1,
      'the detail cache records the response it served',
    );
  });

  it('recomputes the detail when the vehicle moves', async () => {
    const before = await get('/vehicle/4-1');
    assert.equal(before.body.trip.atStop.name, 'Rynek');
    const beforeStops = before.body.trip.nextStops.map((stop) => stop.name);

    fakeVehicles.snapshot.locations[0].lat = 51.1;
    fakeVehicles.snapshot.locations[0].lon = 17.0215;
    try {
      const after = await get('/vehicle/4-1');
      assert.equal(after.status, 200);
      const afterStops = after.body.trip.nextStops.map((stop) => stop.name);
      assert.notDeepEqual(
        afterStops,
        beforeStops,
        'a moved vehicle must not be served the old spot\u2019s trip',
      );
    } finally {
      fakeVehicles.snapshot.locations[0].lat = 51.11;
      fakeVehicles.snapshot.locations[0].lon = 17.032;
    }
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

  it('serves nearby stops', async () => {
    const { status, body } = await get('/stops/near?lat=51.11&lon=17.032&radius=800');
    assert.equal(status, 200);
    assert.equal(body.stops[0].name, 'Rynek');
    assert.equal(body.stops[0].distance, 0);
    // The app draws stop markers and the nearby list from this payload alone;
    // without the lines both are anonymous.
    assert.ok(Array.isArray(body.stops[0].lines), 'nearby stops carry their lines');

    assert.equal((await get('/stops/near')).status, 400, 'lat and lon are required');
  });

  it('serves stop details and departures', async () => {
    assert.equal((await get('/stop/1')).body.name, 'Rynek');
    assert.equal((await get('/stop/nope')).status, 404);

    const departures = await get('/stop/1/departures?limit=5');
    assert.equal(departures.status, 200);
    assert.ok(Array.isArray(departures.body.departures));
    assert.deepEqual(departures.body.stop.lines, ['4', '128', '240']);
  });

  it('serves alerts and supports filtering', async () => {
    const unfiltered = (await get('/alerts')).body;
    assert.deepEqual(Object.keys(unfiltered).sort(), ['alerts', 'lastRefreshAt']);
    assert.equal(unfiltered.alerts.length, 1);
    assert.equal((await get('/alerts?since=99999')).body.alerts.length, 0);
    assert.equal((await get('/alerts?from=99999')).body.alerts.length, 0, 'legacy ?from= still works');
    assert.equal((await get('/alerts?line=4')).body.alerts.length, 1);
    assert.equal((await get('/alerts?line=128')).body.alerts.length, 0);
  });

  it('serves grouped incidents and supports timeline filtering', async () => {
    const response = await get('/incidents?line=4&status=active');
    assert.equal(response.status, 200);
    assert.equal(response.body.incidents.length, 1);
    assert.deepEqual(response.body.ai, {
      enabled: false,
      provider: 'off',
      model: null,
      lastSuccessAt: null,
      lastError: 'AI alerts are disabled',
    });
    assert.equal((await get('/incidents?from=99999')).body.incidents.length, 0);
    assert.equal((await get('/incidents?status=resolved')).body.incidents.length, 0);
    assert.equal((await get('/incidents?status=nope')).status, 400);
  });

  it('reports health', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.lines.trams, 1);
    assert.equal(body.lines.buses, 2);
    assert.deepEqual(body.klosok, { enabled: false }, 'Kłosok is reported even when disabled');
    assert.deepEqual(body.alerts.aiIncidents, fakeAlerts.incidentStatus);
    assert.equal('aiAlerts' in body, false, 'AI status is nested in the alerts health block');
    // A roster that silently read nothing looks exactly like a fleet with no
    // attributes worth stating, so /health has to name the file and its count.
    assert.equal(body.fleet.enabled, true);
    assert.match(body.fleet.path, /fleet-roster\.json$/);
    assert.ok(body.fleet.entries > 0);
    assert.equal(body.fleet.ignoredEntries, 0);
    assert.equal(body.fleet.lastError, null);
    // Whether the snapshot ships a vehicle_types.txt decides where a vehicle's
    // model comes from, so the count is in the report rather than left to be
    // inferred from vehicles that came back without one.
    assert.equal(body.gtfs.counts.vehicleTypes, 3);
    // Both vehicle sources and the merge stats are part of the report.
    assert.equal(body.vehicles.openData.source, 'https://open-data.cui.wroclaw.pl/hdb/db/14?download=json');
    assert.equal(body.vehicles.stats.total, 2);
    assert.equal(body.vehicles.stats.merged, 1);
    // Rolling diagnostics are compact: no arrays, just latest/ewma/max/count.
    assert.deepEqual(body.performance.vehicles.totalPollMs, {
      latest: 1.5,
      ewma: 1.5,
      max: 1.5,
      count: 1,
    });
    // Open Data metrics appear alongside vehicles and GTFS, same shape.
    assert.deepEqual(body.performance.openData.totalPollMs, {
      latest: 2.0,
      ewma: 2.0,
      max: 2.0,
      count: 1,
    });
    assert.equal(body.performance.openData.fetchMs.count, 1);
    assert.equal(body.performance.openData.acceptedVehicleCount.latest, 1);
    // The three existing performance sections are all still present.
    assert.ok(body.performance.vehicles, 'vehicles metrics remain');
    assert.ok(body.performance.openData, 'openData metrics present');
    assert.ok(body.performance.gtfs, 'gtfs metrics remain');
    const gtfsPerf = body.performance.gtfs.lastBuild;
    assert.ok(Number.isFinite(gtfsPerf.totalMs));
    assert.ok(Number.isFinite(gtfsPerf.stages.variants));
    assert.ok(Number.isFinite(gtfsPerf.peakMemory.heapUsedMb));
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
