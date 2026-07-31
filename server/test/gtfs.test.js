'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore, assertComplete } = require('../src/gtfs/store');
const { simplify, distanceMeters } = require('../src/gtfs/geo');
const { secondsToTime, timeToSeconds } = require('../src/gtfs/parse');
const { buildFixtureZip } = require('./fixtures/gtfs');

describe('GtfsStore', () => {
  const store = new GtfsStore();

  before(async () => {
    await store.build(buildFixtureZip());
  });

  it('categorises every route in the feed', () => {
    assert.deepEqual(store.lines.tram, ['4']);
    assert.deepEqual(store.lines.bus, ['128']);
    assert.deepEqual(store.lines.busNight, ['240']);
  });

  it('builds one variant per shape, most used first', () => {
    const variants = store.getVariants('4');
    assert.equal(variants.length, 2);
    assert.equal(variants[0].shapeId, 's4a', 's4a has two trips so it ranks first');
    assert.equal(variants[0].tripCount, 2);
    assert.equal(variants[1].tripCount, 1);
  });

  it('names variants from their first and last stop', () => {
    const [first] = store.getVariants('4');
    assert.equal(first.direction, 'Rynek → Oporów');
    assert.equal(first.headsign, 'OPORÓW');
  });

  it('attaches ordered stops with times to each variant', () => {
    const [first] = store.getVariants('4');
    assert.deepEqual(
      first.stops.map((stop) => stop.name),
      ['Rynek', 'Świdnicka', 'Oporów'],
    );
    assert.equal(first.stops[0].departure, '08:00:00');
  });

  it('picks the variant closest to a reported vehicle position', () => {
    // Near Biskupin, which only the return leg (s4b) passes.
    const eastbound = store.getBestVariant('4', 51.1, 17.099);
    assert.equal(eastbound.shapeId, 's4b');

    // Near Oporów on the outbound leg.
    const westbound = store.getBestVariant('4', 51.0951, 17.0105);
    assert.equal(westbound.shapeId, 's4a');
  });

  it('falls back to the busiest variant without a position', () => {
    assert.equal(store.getBestVariant('4', null, null).shapeId, 's4a');
    assert.equal(store.getBestVariant('4', Number.NaN, Number.NaN).shapeId, 's4a');
  });

  it('returns null for unknown lines', () => {
    assert.equal(store.getBestVariant('999', 51.1, 17.03), null);
    assert.deepEqual(store.getVariants('999'), []);
  });

  it('indexes stops for lookup and search', () => {
    assert.equal(store.getStop('1').name, 'Rynek');
    assert.equal(store.getStop('nope'), null);
    assert.deepEqual(
      store.searchStops('swidnicka').map((stop) => stop.name),
      ['Świdnicka'],
      'search ignores Polish diacritics',
    );
  });

  it('finds nearby stops with real distances on both axes', () => {
    // Rynek is at 51.11 / 17.032. A degree of longitude is ~0.63 of a degree of
    // latitude here, so a grid built on 111 km/degree for both under-searches
    // east-west; these assertions pin the real geometry.
    const near = store.findStopsNear(51.11, 17.032, { radiusMeters: 800 });
    assert.deepEqual(near.map((stop) => stop.name), ['Rynek', 'Świdnicka']);
    assert.equal(near[0].distance, 0);
    assert.ok(near[1].distance > 500 && near[1].distance < 600, `got ${near[1].distance} m`);

    assert.deepEqual(store.findStopsNear(51.11, 17.032, { radiusMeters: 100 }).length, 1);
    assert.deepEqual(store.findStopsNear(Number.NaN, 17.032), []);
  });

  it('honours calendar days when listing departures', () => {
    // 2026-06-15 is a Monday, so WEEKDAY services run.
    const monday = new Date('2026-06-15T05:00:00Z');
    const departures = store.getDepartures('1', { now: monday, limit: 10 });
    assert.ok(departures.length > 0);
    assert.ok(departures.every((departure) => departure.serviceDay === 'today'));
    assert.ok(departures.every((departure) => departure.inSeconds >= 0));

    // Sunday morning: no WEEKDAY service runs, and the night bus is outside
    // the default two-hour horizon.
    const sunday = new Date('2026-06-14T05:00:00Z');
    assert.deepEqual(store.getDepartures('1', { now: sunday, limit: 10 }), []);
  });

  it('applies calendar_dates exceptions', () => {
    // Christmas Day 2026 is a Friday, but WEEKDAY is cancelled and WEEKEND added.
    const christmas = new Date('2026-12-25T06:00:00Z');
    assert.equal(store.isServiceActive('WEEKDAY', christmas), false);
    assert.equal(store.isServiceActive('WEEKEND', christmas), true);
  });

  it('surfaces after-midnight trips from the previous service day', () => {
    // Sunday 00:30 local: the Saturday 240 trip at 25:30 is still to come.
    const earlySunday = new Date('2026-06-14T00:30:00+02:00');
    const departures = store.getDepartures('1', { now: earlySunday, limit: 10 });
    assert.equal(departures.length, 1);
    assert.equal(departures[0].line, '240');
    assert.equal(departures[0].serviceDay, 'yesterday');
    assert.equal(departures[0].departure, '01:30:00');
  });

  it('reports counts after a build', () => {
    assert.equal(store.status.counts.routes, 3);
    assert.equal(store.status.counts.variants, 4);
    assert.equal(store.status.counts.stops, 5);
  });
});

describe('assertComplete', () => {
  it('accepts a full archive', () => {
    assert.doesNotThrow(() => assertComplete(buildFixtureZip()));
  });

  it('rejects a snapshot with no route geometry', () => {
    // The city's archive interleaves ~11 MB snapshots with ~6 MB ones; a short
    // one can be missing shapes.txt, which leaves the map with no routes.
    assert.throws(
      () => assertComplete(buildFixtureZip({ omit: ['shapes'] })),
      /missing shapes\.txt/,
    );
  });

  it('accepts an archive whose tables are nested in a directory', () => {
    // Some publishers ship GTFS/shapes.txt rather than shapes.txt; an
    // exact-path lookup reads that as a feed with no route geometry.
    assert.doesNotThrow(() => assertComplete(buildFixtureZip({ prefix: 'GTFS/' })));
  });

  it('names every missing table', () => {
    assert.throws(
      () => assertComplete(buildFixtureZip({ omit: ['shapes', 'stop_times'] })),
      /stop_times\.txt/,
    );
  });
});

describe('nested archives', () => {
  it('indexes a feed whose tables sit in a subdirectory', async () => {
    const nested = new GtfsStore();
    await nested.build(buildFixtureZip({ prefix: 'OtwartyWroclaw_GTFS/' }));

    assert.deepEqual(nested.lines.tram, ['4']);
    assert.equal(nested.status.counts.stops, 5);
    // The point of the fix: route geometry survives the nesting.
    assert.ok(nested.getVariants('4')[0].points.length > 0);
  });
});

describe('geometry helpers', () => {
  it('measures real-world distances', () => {
    // Rynek to Dworzec Główny is roughly 1.6 km.
    const meters = distanceMeters(51.11, 17.032, 51.0985, 17.0365);
    assert.ok(meters > 1200 && meters < 1600, `unexpected distance ${meters}`);
  });

  it('drops collinear points when simplifying', () => {
    const straight = new Float64Array([51.1, 17.0, 51.2, 17.0, 51.3, 17.0]);
    assert.equal(simplify(straight, 5).length, 4, 'middle point of a straight line is redundant');
  });

  it('keeps corners when simplifying', () => {
    const corner = new Float64Array([51.1, 17.0, 51.1, 17.1, 51.2, 17.1]);
    assert.equal(simplify(corner, 5).length, 6);
  });

  it('handles long shapes without overflowing the stack', () => {
    const points = new Float64Array(200_000);
    for (let i = 0; i < points.length / 2; i += 1) {
      points[i * 2] = 51.1 + Math.sin(i / 50) * 0.05;
      points[i * 2 + 1] = 17.0 + Math.cos(i / 50) * 0.05;
    }
    assert.ok(simplify(points, 5).length < points.length);
  });
});

describe('time helpers', () => {
  it('round-trips times', () => {
    assert.equal(timeToSeconds('08:05:30'), 29_130);
    assert.equal(secondsToTime(29_130), '08:05:30');
  });

  it('supports GTFS times past midnight', () => {
    assert.equal(timeToSeconds('25:30:00'), 91_800);
    assert.equal(secondsToTime(91_800), '01:30:00');
  });

  it('rejects unparseable values', () => {
    assert.equal(timeToSeconds(''), -1);
    assert.equal(timeToSeconds('nope'), -1);
    assert.equal(secondsToTime(-1), null);
  });
});
