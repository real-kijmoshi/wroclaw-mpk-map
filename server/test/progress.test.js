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
