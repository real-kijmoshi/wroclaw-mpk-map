'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { inWarsaw } = require('../src/gtfs/parse');
const {
  MAX_DELAY_SECONDS,
  describeVehicle,
  matchTrip,
  nextStopIndex,
  offsetAt,
  summarise,
} = require('../src/progress');
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

  it('counts a stop the vehicle sits on exactly as passed', () => {
    // Świdnicka is a shape vertex, so the projection lands on its exact metre.
    // The stop itself is behind the vehicle and Oporów is the one ahead — the
    // segment-derived nextStopIndex must agree with the old findIndex here.
    const trip = describeVehicle(gtfs, { line: '4', lat: 51.105, lon: 17.033 }, {
      now: at('08:05:00'),
    });
    assert.equal(trip.previousStop.name, 'Świdnicka');
    assert.equal(trip.nextStop.name, 'Oporów');
    assert.equal(trip.stopsAhead, 1);
    assert.equal(trip.atStop.name, 'Świdnicka');
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

const DAY_SECONDS = 86_400;
const secondsOfDay = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

// The pre-binary-search matchTrip, kept verbatim as the reference behaviour.
const matchTripLinear = (gtfs, variant, progressOffset, now) => {
  const local = inWarsaw(now);
  const yesterday = new Date(local);
  yesterday.setDate(yesterday.getDate() - 1);

  const frames = [
    { seconds: secondsOfDay(local), date: local, label: 'today' },
    { seconds: secondsOfDay(local) + DAY_SECONDS, date: yesterday, label: 'yesterday' },
  ];

  let best = null;
  for (const frame of frames) {
    for (const tripIndex of variant.trips) {
      const start = gtfs.tripStart[tripIndex];
      if (start < 0) continue;

      const delaySeconds = frame.seconds - (start + progressOffset);
      if (Math.abs(delaySeconds) > MAX_DELAY_SECONDS) continue;
      if (best && Math.abs(delaySeconds) >= Math.abs(best.delaySeconds)) continue;

      const trip = gtfs.trips[tripIndex];
      if (!gtfs.isServiceActive(trip.serviceId, frame.date)) continue;

      best = { trip, start, delaySeconds: Math.round(delaySeconds), serviceDay: frame.label };
    }
  }

  return best;
};

// The pre-binary-search offsetAt, kept verbatim as the reference behaviour.
const offsetAtLinear = (stops, alongMeters) => {
  const last = stops[stops.length - 1];
  if (alongMeters <= stops[0].alongMeters) return stops[0].arrivalOffset;
  if (alongMeters >= last.alongMeters) return last.arrivalOffset;

  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i];
    const to = stops[i + 1];
    if (alongMeters < from.alongMeters || alongMeters > to.alongMeters) continue;

    const span = to.alongMeters - from.alongMeters;
    const fraction = span > 0 ? (alongMeters - from.alongMeters) / span : 0;
    return from.departureOffset + fraction * (to.arrivalOffset - from.departureOffset);
  }

  return last.arrivalOffset;
};

// Builds the fake gtfs/variant pair the way store.js lays them out: trips are
// plain records addressed by index, tripStart is the parallel Int32Array, and
// variant.trips holds the indices sorted by tripStart. The sort is stable, so
// equal starts keep trip-index order — and that order is what decides which
// duplicate wins a tie, so it has to match store.js exactly.
const makeVariant = (starts, isActive = () => true) => {
  const trips = starts.map((_, index) => ({ id: `t${index}`, serviceId: `s${index}` }));
  const indices = starts
    .map((start, index) => ({ start, index }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map(({ index }) => index);

  return {
    gtfs: {
      tripStart: Int32Array.from(starts),
      trips,
      isServiceActive: isActive,
    },
    variant: { trips: Int32Array.from(indices) },
  };
};

const asResult = (best) =>
  best === null
    ? null
    : { tripId: best.trip.id, start: best.start, delaySeconds: best.delaySeconds, serviceDay: best.serviceDay };

// Runs both implementations and asserts they picked the same departure.
const assertSameTrip = (starts, options = {}) => {
  const {
    now = new Date('2026-06-15T08:00:00+02:00'),
    progressOffset = 0,
    isActive = () => true,
    label = '',
  } = options;
  const { gtfs, variant } = makeVariant(starts, isActive);
  assert.deepEqual(
    asResult(matchTrip(gtfs, variant, progressOffset, now)),
    asResult(matchTripLinear(gtfs, variant, progressOffset, now)),
    label,
  );
};

// A stop in the shape offsetAt works on. Arrival/departure differ by default
// so dwell time shows up in the interpolation.
const stop = (alongMeters, arrivalOffset, departureOffset = arrivalOffset) => ({
  id: `s${alongMeters}`,
  name: `s${alongMeters}`,
  lat: 0,
  lon: 0,
  sequence: 0,
  alongMeters,
  arrivalOffset,
  departureOffset,
});

// Asserts the new offsetAt and its segment-derived next stop agree with the
// linear walk and findIndex on the same stop list.
const compareOffset = (stops, alongMeters, label) => {
  const linearOffset = offsetAtLinear(stops, alongMeters);
  const fresh = offsetAt(stops, alongMeters);
  assert.equal(fresh.offset, linearOffset, `${label}: offset`);
  const oldNext = stops.findIndex((s) => s.alongMeters > alongMeters);
  const newNext = fresh.sorted ? nextStopIndex(stops, fresh.segmentIndex, alongMeters) : oldNext;
  assert.equal(newNext, oldNext, `${label}: nextIndex`);
};

// Deterministic PRNG so a regression is reproducible rather than a flake.
let randomState = 0x2f6e2b1;
const random = () => {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 0x100000000;
};
const randInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const randomStarts = (count, min, max) => Array.from({ length: count }, () => randInt(min, max));
const randomTimeOfDay = () => {
  const h = randInt(0, 23);
  const m = randInt(0, 59);
  const s = randInt(0, 59);
  return new Date(
    `2026-06-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+02:00`,
  );
};

describe('matchTrip binary search vs linear scan (differential)', () => {
  it('agrees on empty and single-trip variants', () => {
    assertSameTrip([], { label: 'empty' });
    assertSameTrip([28_800], { label: 'single trip, exact now' });
    assertSameTrip([28_800], { now: new Date('2026-06-15T08:05:00+02:00'), label: 'single trip, five minutes on' });
    assertSameTrip([28_800], { now: new Date('2026-06-15T20:00:00+02:00'), label: 'single trip, hours away' });
    assertSameTrip([-1], { label: 'a trip with no start time' });
  });

  it('agrees on hand-built schedules', () => {
    const morning = new Date('2026-06-15T08:00:00+02:00');
    // Dense every-90s service.
    assertSameTrip(
      Array.from({ length: 80 }, (_, i) => 21_600 + i * 90),
      { now: morning, progressOffset: 450, label: 'dense service' },
    );
    // Sparse: a departure every 40 minutes.
    assertSameTrip([0, 2400, 7200, 10_800, 14_400, 19_800, 25_200, 32_400, 38_400], {
      now: morning,
      label: 'sparse service',
    });
    // Duplicate starts: the tie must go to the trip store.js sorts first.
    assertSameTrip([28_800, 28_800, 28_800, 30_000, 30_000], {
      now: morning,
      label: 'duplicate start times',
    });
    // One cancelled trip (no start time) mixed in.
    assertSameTrip([-1, 28_800, -1, 30_600], { now: morning, label: 'mix of -1 and real starts' });
  });

  it('agrees on a 50,000-trip schedule with duplicate starts', () => {
    const starts = Array.from({ length: 50_000 }, (_, i) => (i * 7) % 90_000);
    for (let round = 0; round < 25; round += 1) {
      assertSameTrip(starts, {
        now: randomTimeOfDay(),
        progressOffset: random() * 100_000,
        label: `huge round ${round}`,
      });
    }
  });

  it('agrees on hundreds of random schedules, some services cancelled', () => {
    for (let round = 0; round < 400; round += 1) {
      const count = randInt(0, 120);
      const min = randInt(0, 30_000);
      const max = randInt(min, 120_000);
      const starts = randomStarts(count, min, max);
      // Cancel a chunk of the service: exactly the case where a near but
      // inactive departure used to hide a farther active one.
      const cancelled = new Set(Array.from({ length: Math.floor(count / 3) }, (_, i) => `s${i}`));
      assertSameTrip(starts, {
        now: randomTimeOfDay(),
        progressOffset: random() * 100_000,
        isActive: (serviceId) => !cancelled.has(serviceId),
        label: `random round ${round}`,
      });
    }
  });

  it('treats the ±45-minute window edges as inclusive, exactly as before', () => {
    const morning = new Date('2026-06-15T08:00:00+02:00'); // 08:00 → 28_800
    // +45:00 exactly is in the window; +45:01 is not.
    const lateExact = makeVariant([28_800 - MAX_DELAY_SECONDS]);
    assert.deepEqual(asResult(matchTrip(lateExact.gtfs, lateExact.variant, 0, morning)), {
      tripId: 't0',
      start: 28_800 - MAX_DELAY_SECONDS,
      delaySeconds: MAX_DELAY_SECONDS,
      serviceDay: 'today',
    });
    assertSameTrip([28_800 - MAX_DELAY_SECONDS], { now: morning, label: 'late exactly 45 min' });
    assertSameTrip([28_800 - MAX_DELAY_SECONDS - 1], { now: morning, label: 'late just past 45 min' });

    // -45:00 exactly; -45:01 just past.
    const earlyExact = makeVariant([28_800 + MAX_DELAY_SECONDS]);
    assert.deepEqual(asResult(matchTrip(earlyExact.gtfs, earlyExact.variant, 0, morning)), {
      tripId: 't0',
      start: 28_800 + MAX_DELAY_SECONDS,
      delaySeconds: -MAX_DELAY_SECONDS,
      serviceDay: 'today',
    });
    assertSameTrip([28_800 + MAX_DELAY_SECONDS], { now: morning, label: 'early exactly 45 min' });
    assertSameTrip([28_800 + MAX_DELAY_SECONDS + 1], { now: morning, label: 'early just past 45 min' });
  });

  it('handles the midnight boundary and 24:xx departures', () => {
    const midnight = new Date('2026-06-15T00:00:00+02:00');
    // 00:00 today is matched by the today frame; a 25:00 departure (yesterday
    // 01:00) is matched by the yesterday frame.
    assertSameTrip([0], { now: midnight, label: '00:00 today' });
    assertSameTrip([DAY_SECONDS], { now: midnight, label: '25:00 via the yesterday frame' });
    assertSameTrip([0, DAY_SECONDS + 1200], { now: midnight, label: '00:00 plus a 24:20 run' });

    // 23:59: the 25:00 run is a minute early on the today frame.
    const lateNight = new Date('2026-06-15T23:59:00+02:00');
    assertSameTrip([DAY_SECONDS], { now: lateNight, label: 'overnight overlap' });

    // 00:50, 15 minutes into the 24:20 run: 15 minutes late, yesterday.
    const early = new Date('2026-06-15T00:50:00+02:00');
    assertSameTrip([DAY_SECONDS + 1200], { now: early, progressOffset: 900, label: 'night run halfway' });
  });

  it('matches a run against the service day it actually runs on', () => {
    const now = new Date('2026-06-15T00:50:00+02:00');
    const yesterday = new Date(inWarsaw(now));
    yesterday.setDate(yesterday.getDate() - 1);

    const { gtfs, variant } = makeVariant(
      [DAY_SECONDS + 1200],
      (serviceId, date) => date.getDate() === yesterday.getDate(),
    );
    const expected = {
      tripId: 't0',
      start: DAY_SECONDS + 1200,
      delaySeconds: 900,
      serviceDay: 'yesterday',
    };
    assert.deepEqual(asResult(matchTrip(gtfs, variant, 900, now)), expected);
    assert.deepEqual(asResult(matchTripLinear(gtfs, variant, 900, now)), expected);

    // The same trip, active only yesterday, is not a 00:00 departure today.
    const { gtfs: todayOnly, variant: todayVariant } = makeVariant(
      [0],
      (serviceId, date) => date.getDate() === yesterday.getDate(),
    );
    const midnight = new Date('2026-06-15T00:00:00+02:00');
    assert.equal(asResult(matchTrip(todayOnly, todayVariant, 0, midnight)), null);
    assert.equal(asResult(matchTripLinear(todayOnly, todayVariant, 0, midnight)), null);
  });

  it('lets an inactive trip hide nothing: the walk continues across the window', () => {
    const morning = new Date('2026-06-15T08:00:00+02:00'); // target 28_800

    // The departure nearest the target (s1 at 28_700) is cancelled; the answer
    // must be the active one on the other side of it, not null and not the
    // next trip on the same side.
    const { gtfs, variant } = makeVariant(
      [28_500, 28_700, 28_900],
      (serviceId) => serviceId !== 's1',
    );
    const best = matchTrip(gtfs, variant, 0, morning);
    assert.deepEqual(asResult(best), { tripId: 't2', start: 28_900, delaySeconds: -100, serviceDay: 'today' });
    assert.deepEqual(asResult(matchTripLinear(gtfs, variant, 0, morning)), asResult(best));

    // A nearer active trip beats a farther one, inactive or not.
    const { gtfs: g2, variant: v2 } = makeVariant(
      [28_800 - 300, 28_800 + 300, 28_800 + 600],
      (serviceId) => serviceId !== 's1',
    );
    assert.deepEqual(asResult(matchTrip(g2, v2, 0, morning)), {
      tripId: 't0',
      start: 28_500,
      delaySeconds: 300,
      serviceDay: 'today',
    });

    // Everything in the window cancelled: no run at all.
    const { gtfs: g3, variant: v3 } = makeVariant([28_800 - 300, 28_800 + 300], () => false);
    assert.equal(asResult(matchTrip(g3, v3, 0, morning)), null);
  });

  it('returns null when nothing is within the window', () => {
    const morning = new Date('2026-06-15T08:00:00+02:00');
    assertSameTrip([28_800 + MAX_DELAY_SECONDS + 100], { now: morning, label: 'way early' });
    assertSameTrip([28_800 - MAX_DELAY_SECONDS - 100], { now: morning, label: 'way late' });
    assertSameTrip([0, 86_400], { now: morning, label: 'dead timetable' });
    assertSameTrip([], { now: morning, label: 'no trips at all' });
  });
});

describe('offsetAt binary search vs linear walk (differential)', () => {
  it('interpolates the same offset and next stop for sorted stops', () => {
    const stops = [stop(0, 0, 0), stop(500, 300, 330), stop(1000, 700, 730), stop(1600, 1200, 1230), stop(2400, 1800)];
    for (const along of [-100, 0, 1, 249, 250, 499, 500, 501, 750, 999, 1000, 1001, 1600, 2000, 2399, 2400, 2500]) {
      compareOffset(stops, along, `along=${along}`);
    }
    // Sweep every whole metre of the route.
    for (let along = 0; along <= 2400; along += 1) compareOffset(stops, along, `sweep ${along}`);
  });

  it('sits on a stop exactly the way the linear code did', () => {
    // At an interior stop the offset is that stop's arrival time via the
    // segment that ends there, and the stop itself counts as passed.
    const stops = [stop(0, 0, 0), stop(500, 300, 330), stop(1000, 700, 700)];
    const fresh = offsetAt(stops, 500);
    assert.equal(fresh.offset, 300);
    assert.equal(fresh.segmentIndex, 0);
    assert.equal(nextStopIndex(stops, fresh.segmentIndex, 500), 2);
    assert.equal(stops.findIndex((s) => s.alongMeters > 500), 2);
    compareOffset(stops, 500, 'exactly on stop');
  });

  it('handles duplicate alongMeters and zero-length segments', () => {
    // Two stops at the same distance: the vehicle is at both, so the first
    // pair that reaches that distance wins, exactly as in the linear walk.
    const stops = [stop(0, 0, 0), stop(500, 300, 330), stop(500, 320, 350), stop(1000, 700, 700)];
    for (const along of [499, 500, 501, 502]) compareOffset(stops, along, `duplicate along=${along}`);
    const fresh = offsetAt(stops, 500);
    assert.equal(fresh.offset, 300);
    assert.equal(nextStopIndex(stops, fresh.segmentIndex, 500), 3, 'both duplicate stops are passed');
    assert.equal(stops.findIndex((s) => s.alongMeters > 500), 3);
  });

  it('clamps to the first and last stop exactly as before', () => {
    const stops = [stop(500, 300, 330), stop(1000, 700, 700), stop(1600, 1200, 1230)];
    for (const along of [-100, 500]) {
      const fresh = offsetAt(stops, along);
      assert.equal(fresh.offset, 300, `along=${along}`);
      assert.equal(fresh.segmentIndex, 0, `along=${along}`);
      compareOffset(stops, along, `clamp ${along}`);
    }
    for (const along of [1600, 5000]) {
      const fresh = offsetAt(stops, along);
      assert.equal(fresh.offset, 1200, `along=${along}`);
      assert.equal(fresh.segmentIndex, -1, `along=${along}`);
      compareOffset(stops, along, `clamp ${along}`);
    }
  });

  it('matches the linear interpolation across random sorted stops', () => {
    for (let round = 0; round < 200; round += 1) {
      const count = randInt(2, 30);
      const step = randInt(10, 500);
      // Strictly increasing, sometimes with a gap of zero at the start.
      const alongs = Array.from({ length: count }, (_, i) => i * step + randInt(0, Math.max(0, step - 1)));
      const stops = alongs.map((a, i) => stop(a, i * 60 + i, i * 60 + i + 5));
      const probes = [...alongs, ...Array.from({ length: 8 }, () => randInt(-100, alongs[alongs.length - 1] + 100))];
      for (const along of probes) compareOffset(stops, along, `sorted round ${round} along=${along}`);
    }
  });

  it('falls back to the linear walk when the stop list is not sorted', () => {
    // A loop or a misbuilt variant could leave alongMeters out of order; the
    // binary search must not be trusted then, and the offset must still match
    // the old scan, which never assumed order.
    const stops = [stop(100, 100), stop(0, 0), stop(500, 300, 330), stop(400, 250, 260), stop(1200, 700)];
    for (const along of [-50, 0, 50, 100, 150, 250, 400, 499, 500, 700, 1199, 1200, 1300]) {
      compareOffset(stops, along, `unsorted along=${along}`);
    }
  });

  it('matches the linear walk on random unsorted stop lists too', () => {
    for (let round = 0; round < 100; round += 1) {
      const stops = Array.from({ length: randInt(2, 15) }, (_, i) => stop(randInt(0, 3000), i * 60, i * 60 + 10));
      for (const along of Array.from({ length: 10 }, () => randInt(-200, 3200))) {
        compareOffset(stops, along, `unsorted round ${round} along=${along}`);
      }
    }
  });

  it('still derives nextStopIndex exactly when the fixture lands on a stop', () => {
    const stops = [stop(0, 0, 0), stop(550, 300, 330), stop(1150, 700, 700)];
    for (const along of [0, 549, 550, 551, 1149, 1150]) {
      const fresh = offsetAt(stops, along);
      const newNext = fresh.sorted ? nextStopIndex(stops, fresh.segmentIndex, along) : undefined;
      assert.equal(newNext, stops.findIndex((s) => s.alongMeters > along), `along=${along}`);
    }
  });
});
