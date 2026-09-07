'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { planJourney, resetPlannerIndex } = require('../src/gtfs/planner');
const { buildFixtureZip } = require('./fixtures/gtfs');

// The fixture's geography, so a test can stand a rider on a stop without
// repeating coordinates. Line 4 runs Rynek → Świdnicka → Oporów in the
// morning and Oporów → Biskupin later; 240 is the night bus to Krzyki.
const AT = {
  rynek: { lat: 51.11, lon: 17.032 },
  swidnicka: { lat: 51.105, lon: 17.033 },
  oporow: { lat: 51.08, lon: 16.98 },
  biskupin: { lat: 51.1, lon: 17.1 },
  krzyki: { lat: 51.07, lon: 17.03 },
  // Far outside the feed's stops, so nothing is reachable on foot.
  nowhere: { lat: 51.5, lon: 18.5 },
};

describe('planJourney', () => {
  const store = new GtfsStore();

  before(async () => {
    resetPlannerIndex();
    await store.build(buildFixtureZip());
  });

  it('plans a direct ride and names the run it puts the rider on', () => {
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.oporow,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    const [plan] = result.plans;
    assert.ok(plan, 'a weekday morning has a plan');
    assert.equal(plan.transfers, 0);

    const rides = plan.legs.filter((leg) => leg.mode === 'ride');
    assert.equal(rides.length, 1);
    assert.equal(rides[0].line, '4');
    assert.equal(rides[0].type, 'tram');
    assert.equal(rides[0].from.name, 'Rynek');
    assert.equal(rides[0].to.name, 'Oporów');
    assert.equal(new Date(rides[0].departure).toISOString(), '2026-06-15T06:00:00.000Z');
    assert.equal(new Date(rides[0].arrival).toISOString(), '2026-06-15T06:15:00.000Z');
    assert.deepEqual(
      rides[0].stops.map((stop) => stop.name),
      ['Rynek', 'Świdnicka', 'Oporów'],
      'the ride carries the stops it actually passes',
    );
  });

  it('measures the journey from when the rider must leave, not from the query', () => {
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.oporow,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    const [plan] = result.plans;
    // Standing on the stop, the walk is nothing, so leaving *is* the 08:00
    // departure — ten minutes after the query. A plan that started at 07:50
    // would count waiting on the pavement as travel.
    assert.equal(new Date(plan.departure).toISOString(), '2026-06-15T06:00:00.000Z');
    assert.equal(plan.durationSeconds, 15 * 60);
    assert.equal(plan.startsInSeconds, 10 * 60);
  });

  it('changes vehicles when no single line covers the trip', () => {
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.biskupin,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    const [plan] = result.plans;
    assert.ok(plan, 'Rynek to Biskupin is only reachable by changing at Oporów');
    assert.equal(plan.transfers, 1);

    const rides = plan.legs.filter((leg) => leg.mode === 'ride');
    assert.deepEqual(
      rides.map((ride) => [ride.from.name, ride.to.name]),
      [
        ['Rynek', 'Oporów'],
        ['Oporów', 'Biskupin'],
      ],
    );
    assert.equal(new Date(rides[1].arrival).toISOString(), '2026-06-15T08:10:00.000Z');
  });

  it('honours the calendar rather than the clock', () => {
    // 01:00 on a Sunday. Line 4 only runs on weekdays, so no plan may use it;
    // the night bus left on *Saturday's* service day at 25:30 and is the only
    // thing moving.
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.krzyki,
      departAt: new Date('2026-06-14T01:00:00+02:00'),
    });

    const [plan] = result.plans;
    assert.ok(plan, 'the night bus is running');
    const rides = plan.legs.filter((leg) => leg.mode === 'ride');
    assert.deepEqual(rides.map((ride) => ride.line), ['240']);
    assert.equal(
      new Date(rides[0].departure).toISOString(),
      '2026-06-13T23:30:00.000Z',
      '25:30 on Saturday is 01:30 Sunday, and the plan says so in real time',
    );
  });

  it('walks the rider to the stop and off it at the far end', () => {
    // 300 m north of Rynek and 300 m short of Oporów, so both ends need feet.
    const result = planJourney(store, {
      from: { lat: 51.1127, lon: 17.032 },
      to: { lat: 51.0827, lon: 16.9805 },
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    const [plan] = result.plans;
    assert.ok(plan);
    assert.equal(plan.legs[0].mode, 'walk');
    assert.equal(plan.legs[0].to.name, 'Rynek');
    assert.equal(plan.legs[plan.legs.length - 1].mode, 'walk');
    assert.equal(plan.legs[plan.legs.length - 1].from.name, 'Oporów');
    assert.ok(plan.walkMeters > 0);
    // Leaving now means leaving early enough to make the 08:00.
    assert.ok(new Date(plan.departure) < new Date('2026-06-15T06:00:00.000Z'));
  });

  it('offers walking when the destination is around the corner', () => {
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.swidnicka,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    assert.ok(result.walkOnly, 'half a kilometre is a walk, and saying so is the honest answer');
    assert.equal(result.walkOnly.legs.length, 1);
    assert.equal(result.walkOnly.legs[0].mode, 'walk');
  });

  it('returns nothing rather than something wrong when nothing is reachable', () => {
    const result = planJourney(store, {
      from: AT.nowhere,
      to: AT.krzyki,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    assert.deepEqual(result.plans, []);
    assert.equal(result.walkOnly, null);
  });

  it('never returns a slower plan for the privilege of more changes', () => {
    const result = planJourney(store, {
      from: AT.rynek,
      to: AT.oporow,
      departAt: new Date('2026-06-15T07:50:00+02:00'),
    });

    // Every plan must beat the one before it on arrival, or it has no reason
    // to be offered: it costs a change and gets there no sooner.
    for (let i = 1; i < result.plans.length; i += 1) {
      assert.ok(
        new Date(result.plans[i].arrival) < new Date(result.plans[i - 1].arrival) ||
          result.plans[i].transfers < result.plans[i - 1].transfers,
      );
    }
  });
});
