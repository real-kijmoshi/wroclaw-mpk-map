'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { KdStaticStore } = require('../src/kd/static');
const { buildKdFixtureZip } = require('./fixtures/kd-gtfs');

const build = async (options) => {
  const store = new KdStaticStore();
  await store.build(buildKdFixtureZip(options));
  return store;
};

describe('KD static GTFS store', () => {
  it('builds every index from the fixture archive', async () => {
    const store = await build();
    assert.equal(store.routesById.size, 3);
    assert.equal(store.tripsById.size, 4);
    assert.equal(store.stopsById.size, 6);
    assert.equal(store.status.counts.stopTimes, 10);
  });

  it('namespaces external ids with the kd: prefix', async () => {
    const store = await build();
    const stop = store.getStop('1');
    assert.equal(stop.id, 'kd:stop:1');
    assert.equal(stop.operator, 'KD');
    const trip = store.tripsById.get('t1');
    assert.equal(trip.id, 'kd:trip:t1');
    const route = store.routesById.get('356696');
    assert.equal(route.id, 'kd:route:356696');
  });

  it('keeps raw ids internally for lookups', async () => {
    const store = await build();
    assert.equal(store.stopsById.get('10').rawId, '10');
    assert.equal(store.tripsById.get('t1').rawId, 't1');
    assert.equal(store.routesById.get('356696').rawId, '356696');
  });

  it('derives the display line from route_short_name', async () => {
    const store = await build();
    assert.equal(store.routeName('356696'), 'D6');
    assert.equal(store.routeName('356671'), 'D1');
  });

  it('treats rail route_type 2 as train', async () => {
    const store = await build();
    assert.equal(store.routesById.get('356696').routeType, 2);
  });

  it('builds fine without trips.shape_id and without trip_short_name', async () => {
    const store = await build();
    assert.equal(store.shapesById.size, 0);
    for (const trip of store.tripsById.values()) {
      assert.equal(trip.shapeId, null);
      // block_id exists but must never be treated as a train number.
      assert.match(trip.blockId, /^\d+\/\d+$/);
    }
  });

  it('returns departures from a station across its platforms', async () => {
    const store = await build();
    const now = new Date('2026-08-07T07:50:00+02:00'); // Friday
    const departures = store.getDepartures('1', { now, horizonSeconds: 7200 });
    // Platform 10 (t1 @08:00) and platform 11 (t2 @09:00, t4 @12:00) — the
    // last is outside the 2h horizon.
    assert.deepEqual(
      departures.map((entry) => entry.tripId),
      ['kd:trip:t1', 'kd:trip:t2'],
    );
    assert.equal(departures[0].line, 'D6');
    assert.equal(departures[0].type, 'train');
    assert.equal(departures[0].operator, 'KD');
    assert.equal(departures[0].headsign, 'Wrocław Główny');
    assert.equal(departures[0].scheduledDeparture, '08:00:00');
  });

  it('skips trips not running on the service day', async () => {
    const store = await build();
    const now = new Date('2026-08-08T09:00:00+02:00'); // Saturday — t3 runs, t1/t2 do not
    const departures = store.getDepartures('1', { now, horizonSeconds: 7200 });
    assert.deepEqual(
      departures.map((entry) => entry.tripId),
      ['kd:trip:t3'],
    );
  });

  it('honours calendar_dates exceptions', async () => {
    const store = await build();
    const christmas = new Date('2026-12-25T07:50:00+02:00');
    const departures = store.getDepartures('1', { now: christmas, horizonSeconds: 24 * 3600 });
    // Christmas is a Friday: t1's weekday service is removed for the day,
    // t4's everyday service is added; t3 (weekend only) still does not run.
    assert.deepEqual(
      departures.map((entry) => entry.tripId),
      ['kd:trip:t2', 'kd:trip:t4'],
    );
  });

  it('carries trips that run past midnight', async () => {
    const store = await build();
    const now = new Date('2026-08-09T00:45:00+02:00'); // Sunday 00:45, t3 started Saturday 25:30
    const departures = store.getDepartures('2', { now, horizonSeconds: 7200 });
    assert.deepEqual(
      departures.map((entry) => entry.tripId),
      ['kd:trip:t3'],
    );
  });

  it('exposes platform_code and parent_station on platforms', async () => {
    const store = await build();
    const platform = store.getStop('10');
    assert.equal(platform.platformCode, 'VI');
    assert.equal(platform.parentStation, 'kd:stop:1');
    const station = store.getStop('1');
    assert.equal(station.locationType, 1);
    assert.equal(station.parentStation, null);
  });

  it('searches stops case- and diacritic-insensitively', async () => {
    const store = await build();
    // Matches MPK's searchStops semantics: accents with a canonical
    // decomposition (ó -> o) are folded, while characters like ł (which has
    // none) must be typed as-is.
    const results = store.searchStops('wrocław', 5);
    assert.ok(results.some((stop) => stop.name === 'Wrocław Główny'));
  });

  it('prefers stations, then rank, then deterministic tie-breaks', async () => {
    const store = await build();
    // ł has no canonical decomposition, so it must be typed as-is.
    const results = store.searchStops('wrocław', 10).map((stop) => stop.name);
    // The station (locationType 1) comes first, then the platforms with the
    // same name — and only three stops can ever match "wrocław".
    assert.equal(results[0], 'Wrocław Główny');
    assert.equal(results.length, 3);
  });

  it('orders trip stops by sequence with scheduled times', async () => {
    const store = await build();
    const trip = store.getTripStops('t1');
    assert.equal(trip.stops.length, 3);
    assert.deepEqual(
      trip.stops.map((stop) => stop.name),
      ['Wrocław Główny', 'Wałbrzych Główny', 'Wałbrzych Główny'],
    );
    assert.equal(trip.stops[0].scheduledDeparture, '08:00:00');
    assert.equal(trip.stops[0].platformCode, 'VI');
  });

  it('returns null shape when the feed has no geometry', async () => {
    const store = await build();
    assert.equal(store.getTripShape('t1'), null);
  });

  it('never invents geometry when shapes.txt exists but trips lack shape_id', async () => {
    // A future feed might ship shapes.txt without linking trips to it; the
    // store must not guess a link.
    const store = new KdStaticStore();
    const { buildKdFixtureZip } = require('./fixtures/kd-gtfs');
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buildKdFixtureZip());
    zip.addFile(
      'shapes.txt',
      Buffer.from(
        ['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', 's1,51.098,17.036,1', 's1,50.772,16.287,2'].join('\n'),
      ),
    );
    await store.build(zip.toBuffer());
    assert.equal(store.shapesById.size, 1);
    assert.equal(store.getTripShape('t1'), null); // no trip references s1
    assert.equal(store.getTripShape('s1'), null); // s1 is not a trip id
  });

  it('returns a shape only when a trip actually references it', async () => {
    const store = new KdStaticStore();
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buildKdFixtureZip());
    const trips = zip.getEntry('trips.txt').getData().toString('utf8');
    zip.updateFile(
      'trips.txt',
      Buffer.from(
        trips
          .replace(
            'route_id,service_id,trip_id,trip_headsign,direction_id,block_id',
            'route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id',
          )
          .replace('356696,1_445405,t1,Wrocław Główny,,25400/60461', '356696,1_445405,t1,Wrocław Główny,,25400/60461,s1'),
      ),
    );
    zip.addFile(
      'shapes.txt',
      Buffer.from(
        ['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', 's1,51.098,17.036,1', 's1,50.772,16.287,2'].join('\n'),
      ),
    );
    await store.build(zip.toBuffer());
    const shape = store.getTripShape('t1');
    assert.ok(shape);
    assert.equal(shape.shapeId, 's1');
    assert.equal(shape.points.length, 2);
  });
});
