'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { describeVehicle, summarise } = require('../src/progress');
const { buildFixtureZip } = require('./fixtures/gtfs');

/**
 * The fixture's tram 4 runs Rynek → Świdnicka → Oporów as s4a (08:00, 08:05,
 * 08:15) and Oporów → Biskupin as s4b. Both legs meet at Oporów, which is
 * where direction has to be decided by heading rather than by distance.
 */
describe('describeVehicle', () => {
  const gtfs = new GtfsStore();

  // 2026-06-15 is a Monday, so the fixture's WEEKDAY services run.
  const at = (time) => new Date(`2026-06-15T${time}+02:00`);

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
  });

  const onLine4 = (extra = {}) => ({ line: '4', lat: 51.1, lon: 17.0215, ...extra });

  it('says where the vehicle is headed', () => {
    const trip = describeVehicle(gtfs, onLine4(), { now: at('08:07:06') });
    assert.equal(trip.shapeId, 's4a');
    assert.equal(trip.towards, 'Oporów');
    assert.equal(trip.origin, 'Rynek');
    assert.equal(trip.headsign, 'OPORÓW');
    assert.equal(trip.direction, 'Rynek → Oporów');
    assert.equal(trip.onRoute, true);
  });

  it('reports the stop behind and the stops ahead', () => {
    const trip = describeVehicle(gtfs, onLine4(), { now: at('08:07:06') });
    assert.equal(trip.previousStop.name, 'Świdnicka');
    assert.equal(trip.previousStop.passed, true);
    assert.equal(trip.nextStop.name, 'Oporów');
    assert.equal(trip.stopsAhead, 1);
    assert.equal(
      trip.nextStops.every((stop) => stop.passed === false),
      true,
    );
  });

  it('estimates arrival from how far along the route the vehicle actually is', () => {
    // Halfway between Świdnicka (08:05) and Oporów (08:15) by distance, which
    // on this shape is about a fifth of the way by time.
    const trip = describeVehicle(gtfs, onLine4(), { now: at('08:07:06') });
    const minutes = trip.nextStop.etaSeconds / 60;
    assert.ok(minutes > 6 && minutes < 9, `expected ~8 min, got ${minutes.toFixed(1)}`);
    assert.equal(trip.nextStop.scheduled, '08:15:00');
  });

  it('identifies the run and how late it is', () => {
    const onTime = describeVehicle(gtfs, onLine4(), { now: at('08:07:06') });
    assert.equal(onTime.tripId, 't4a');
    assert.equal(onTime.serviceDay, 'today');
    assert.ok(Math.abs(onTime.delaySeconds) < 30, `expected on time, got ${onTime.delaySeconds}s`);

    // Same place five minutes later: the same run, five minutes late.
    const late = describeVehicle(gtfs, onLine4(), { now: at('08:12:06') });
    assert.equal(late.tripId, 't4a');
    assert.ok(
      late.delaySeconds > 270 && late.delaySeconds < 330,
      `expected ~300s late, got ${late.delaySeconds}s`,
    );

    // The delay moves the timetable, not the running time still to come.
    assert.equal(late.nextStop.scheduled, onTime.nextStop.scheduled);
    assert.equal(late.nextStop.etaSeconds, onTime.nextStop.etaSeconds);
  });

  it('refuses to guess a run that is nowhere near the timetable', () => {
    // Small hours, when nothing on this shape is scheduled: better no delay at
    // all than a confident number belonging to another departure.
    const trip = describeVehicle(gtfs, onLine4(), { now: at('03:30:00') });
    assert.equal(trip.tripId, null);
    assert.equal(trip.delaySeconds, null);
    assert.equal(trip.scheduleMatched, false);
    // The stop list still works — it needs the profile, not the departure.
    assert.equal(trip.nextStop.name, 'Oporów');
    assert.equal(trip.nextStop.scheduled, null, 'no run means no timetabled time');
    assert.ok(trip.nextStop.etaSeconds > 0);
  });

  it('uses the heading to tell the two directions apart', () => {
    // Just off Oporów, where the outbound leg ends and the return leg starts.
    // Distance alone cannot separate them — the heading is the whole answer,
    // and getting it wrong announces the opposite terminus to the rider.
    const arriving = describeVehicle(gtfs, { line: '4', lat: 51.081, lon: 16.983, heading: 231 }, {
      now: at('08:14:00'),
    });
    assert.equal(arriving.shapeId, 's4a');
    assert.equal(arriving.towards, 'Oporów');

    const leaving = describeVehicle(gtfs, { line: '4', lat: 51.081, lon: 16.983, heading: 78 }, {
      now: at('10:01:00'),
    });
    assert.equal(leaving.shapeId, 's4b');
    assert.equal(leaving.towards, 'Biskupin');
  });

  it('reports standing at a stop', () => {
    const trip = describeVehicle(gtfs, { line: '4', lat: 51.10501, lon: 17.03301 }, {
      now: at('08:05:00'),
    });
    assert.equal(trip.atStop.name, 'Świdnicka');
    assert.ok(trip.atStop.distanceMeters < 45);
  });

  it('keeps the direction but drops the stop list when the vehicle is off route', () => {
    const trip = describeVehicle(gtfs, { line: '4', lat: 51.2, lon: 17.3 }, { now: at('08:07:06') });
    assert.equal(trip.onRoute, false);
    assert.ok(trip.towards);
    assert.deepEqual(trip.nextStops, []);
    assert.equal(trip.nextStop, null);
    assert.equal(trip.delaySeconds, null);
  });

  it('returns null for a line the timetable does not have', () => {
    assert.equal(describeVehicle(gtfs, { line: '999', lat: 51.1, lon: 17.03 }), null);
    assert.equal(describeVehicle(new GtfsStore(), onLine4()), null, 'no timetable loaded yet');
    assert.equal(describeVehicle(gtfs, null), null);
  });

  it('limits how much history and how many stops ahead it returns', () => {
    const trip = describeVehicle(gtfs, onLine4(), { now: at('08:07:06'), limit: 0, history: 0 });
    assert.deepEqual(trip.nextStops, []);
    assert.deepEqual(trip.previousStops, []);
    assert.equal(trip.previousStop, null);
    assert.equal(trip.stopsAhead, 1, 'the count is of the route, not of the returned slice');
  });
});

describe('summarise', () => {
  const gtfs = new GtfsStore();

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
  });

  it('keeps /locations small: one stop, no geometry', () => {
    const trip = summarise(
      describeVehicle(
        gtfs,
        { line: '4', lat: 51.1, lon: 17.0215 },
        { now: new Date('2026-06-15T08:07:06+02:00'), limit: 1 },
      ),
    );

    assert.equal(trip.towards, 'Oporów');
    assert.equal(trip.nextStop.name, 'Oporów');
    assert.equal(trip.previousStop.name, 'Świdnicka');
    assert.equal(trip.nextStops, undefined);
    assert.equal(trip.previousStop.lat, undefined, 'the app already has the stop geometry');
  });

  it('passes null through', () => {
    assert.equal(summarise(null), null);
  });
});

/**
 * The fast path re-projects a vehicle only around where it was last seen. The
 * rule is that it must never be *more* wrong than the full matcher: whenever
 * it accepts, its answer has to be identical to the full match; whenever it
 * cannot be sure, it hands back and the full match runs.
 */
describe('describeVehicle fast path', () => {
  const gtfs = new GtfsStore();

  // 2026-06-15 is a Monday, so the fixture's WEEKDAY services run.
  const at = (time) => new Date(`2026-06-15T${time}+02:00`);

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';
  });

  const json = (described) => JSON.stringify(described);

  // Where the fixture's s4a runs Rynek → Świdnicka → Oporów: a point on the
  // long straight between Świdnicka and Oporów.
  const p1 = { line: '4', lat: 51.1, lon: 17.0215, heading: 250 };
  // ~200 m further along the same straight.
  const p2 = { line: '4', lat: 51.098, lon: 17.018, heading: 250 };

  it('matches the full matcher as a vehicle advances along its route', () => {
    const first = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    assert.equal(first.shapeId, 's4a');
    assert.ok(first.state, 'an on-route match seeds the fast path');

    const fast = describeVehicle(gtfs, p2, { now: at('08:07:06'), previousState: first.state });
    const full = describeVehicle(gtfs, p2, { now: at('08:07:06') });

    assert.equal(fast.shapeId, 's4a');
    assert.ok(fast.state);
    assert.equal(json(fast), json(full), 'the fast answer must be byte-identical to the full match');
  });

  it('absorbs a few metres of GPS jitter without changing the answer', () => {
    const first = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    const wobble = describeVehicle(
      gtfs,
      { ...p1, lat: p1.lat + 0.00002, lon: p1.lon + 0.00002 },
      { now: at('08:07:06') },
    );
    const fast = describeVehicle(
      gtfs,
      { ...p1, lat: p1.lat + 0.00002, lon: p1.lon + 0.00002 },
      { now: at('08:07:06'), previousState: first.state },
    );
    assert.ok(fast.state);
    assert.equal(json(fast), json(wobble));
  });

  it('falls back to the full matcher when the vehicle jumps past the window', () => {
    const first = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    // At Oporów, the far end of s4a — far beyond the fast path's forward window.
    const jumped = { line: '4', lat: 51.081, lon: 16.983, heading: 231 };
    const fast = describeVehicle(gtfs, jumped, { now: at('08:07:06'), previousState: first.state });
    const full = describeVehicle(gtfs, jumped, { now: at('08:07:06') });
    assert.equal(fast.shapeId, 's4a', 'still the same leg, just further on');
    assert.equal(json(fast), json(full), 'fell back, so it must equal the full match');
  });

  it('lets a terminus turnaround re-match instead of staying on the old leg', () => {
    // Arriving at Oporów on the outbound leg seeds the fast path on s4a.
    const arriving = { line: '4', lat: 51.081, lon: 16.983, heading: 231 };
    const first = describeVehicle(gtfs, arriving, { now: at('08:14:00') });
    assert.equal(first.shapeId, 's4a');

    // The same spot, now heading back the other way: the heading penalty must
    // reject the old leg and let the full matcher pick the return leg.
    const leaving = { line: '4', lat: 51.081, lon: 16.983, heading: 78 };
    const fast = describeVehicle(gtfs, leaving, { now: at('10:01:00'), previousState: first.state });
    const full = describeVehicle(gtfs, leaving, { now: at('10:01:00') });
    assert.equal(full.shapeId, 's4b');
    assert.equal(fast.shapeId, 's4b');
    assert.equal(json(fast), json(full));
  });

  it('does not carry a match across a line change', () => {
    const first = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    // The same corner, but this vehicle is now a 128 — a different shape that
    // happens to run nearby. The seeded shape must not win by inertia.
    const swapped = { line: '128', lat: 51.09, lon: 17.031, heading: 180 };
    const fast = describeVehicle(gtfs, swapped, { now: at('08:07:06'), previousState: first.state });
    const full = describeVehicle(gtfs, swapped, { now: at('08:07:06') });
    assert.equal(full.shapeId, 's128');
    assert.equal(fast.shapeId, 's128');
    assert.equal(json(fast), json(full));
  });

  it('gives up and full-matches when the vehicle is off route', () => {
    const first = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    const far = { line: '4', lat: 51.2, lon: 17.3 };
    const fast = describeVehicle(gtfs, far, { now: at('08:07:06'), previousState: first.state });
    const full = describeVehicle(gtfs, far, { now: at('08:07:06') });
    assert.equal(fast.onRoute, false);
    assert.equal(json(fast), json(full));
    assert.equal(fast.state, undefined, 'an off-route vehicle seeds nothing for the next poll');
  });

  it('stays anchored on its own direction where the two legs of a line meet', () => {
    // At Oporów both s4a and s4b pass; with a heading that says "arriving" the
    // full matcher picks s4a, and the fast path must keep it there rather than
    // flapping to s4b.
    const arriving = { line: '4', lat: 51.081, lon: 16.983, heading: 231 };
    const first = describeVehicle(gtfs, arriving, { now: at('08:14:00') });
    assert.equal(first.shapeId, 's4a');

    const again = describeVehicle(gtfs, arriving, { now: at('08:14:02'), previousState: first.state });
    const full = describeVehicle(gtfs, arriving, { now: at('08:14:02') });
    assert.equal(again.shapeId, 's4a');
    assert.equal(json(again), json(full));
  });

  it('keeps the projection state off the wire', () => {
    const described = describeVehicle(gtfs, p1, { now: at('08:07:06') });
    assert.ok(described.state);
    assert.equal(json(described).includes('"state"'), false, 'state must not serialize');
    assert.equal(Object.keys(described).includes('state'), false, 'state must not enumerate');
  });
});
