'use strict';

process.env.KLOSOK_MAX_AGE_MS = '120000';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const { GtfsStore } = require('../src/gtfs/store');
const { findTripUpdate, parseLabel, parseRealtime, pickActiveTrip, resolveEnrichment, tripDelay } = require('../src/klosok/realtime');
const { buildKlosokFixtureZip } = require('./fixtures/klosok-gtfs');

const now = () => Math.floor(Date.now() / 1000);

const encode = (message) => Buffer.from(rt.FeedMessage.encode(message).finish());

const vehicleEntity = (overrides = {}) =>
  rt.FeedEntity.create({
    id: 'e1',
    vehicle: rt.VehiclePosition.create({
      trip: rt.TripDescriptor.create({
        tripId: 't911a',
        routeId: '911',
        startDate: '20260807',
        ...(overrides.trip || {}),
      }),
      vehicle: rt.VehicleDescriptor.create({ id: '1201', label: '911/12' }),
      position: rt.Position.create({ latitude: 51.105123, longitude: 17.032987, bearing: 720, speed: 15 }),
      timestamp: overrides.timestamp ?? now(),
      currentStopSequence: overrides.currentStopSequence ?? 1,
      ...(overrides.vehicle || {}),
    }),
  });

const tripUpdateEntity = (overrides = {}) =>
  rt.FeedEntity.create({
    id: 'tu1',
    tripUpdate: rt.TripUpdate.create({
      trip: rt.TripDescriptor.create({ tripId: 't911a', routeId: '911', startDate: '20260807' }),
      delay: overrides.delay ?? 180,
      ...(overrides.tripUpdate || {}),
    }),
  });

const feed = (entities, headerTimestamp = now()) =>
  encode(
    rt.FeedMessage.create({
      header: rt.FeedHeader.create({ gtfsRealtimeVersion: '2.0', timestamp: headerTimestamp }),
      entity: entities,
    }),
  );

describe('Kłosok GTFS-RT parsing', () => {
  it('decodes a vehicle position into the expected shape', () => {
    const { vehicles, tripUpdates } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(vehicles.length, 1);
    const v = vehicles[0];
    assert.equal(v.id, 'klosok:1201');
    assert.equal(v.operator, null); // filled from GTFS agency by the service
    assert.equal(v.type, 'bus');
    assert.equal(v.line, null); // filled from GTFS routes by the service
    assert.equal(v.routeId, '911');
    assert.equal(v.tripId, 't911a');
    assert.equal(v.startDate, '20260807');
    assert.equal(v.vehicleId, '1201');
    assert.equal(v.vehicleLabel, '911/12');
    assert.equal(v.lat, 51.10512); // rounded to 1e-5
    assert.equal(v.lon, 17.03299);
    assert.equal(v.heading, 0); // 720 % 360
    assert.equal(v.destination, null); // filled from GTFS trips by the service
    assert.equal(v.source, 'klosok-gtfs-rt');
    assert.equal(v.currentStopSequence, 1);
    assert.equal(tripUpdates.size, 0);
  });

  it('joins a TripUpdate and derives delaySeconds', () => {
    const { vehicles, tripUpdates } = parseRealtime(feed([vehicleEntity(), tripUpdateEntity({ delay: 180 })]));
    assert.equal(vehicles[0].delaySeconds, 180);
    assert.equal(tripUpdates.size, 1);
    const update = findTripUpdate(tripUpdates, 't911a', '20260807');
    assert.equal(update.delay, 180);
  });

  it('keys trip updates by startDate|tripId', () => {
    const a = tripUpdateEntity({ delay: 60 });
    const b = rt.FeedEntity.create({
      id: 'tu-b',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't911a', startDate: '20260808' }),
        delay: 300,
      }),
    });
    const { tripUpdates } = parseRealtime(feed([a, b]));
    assert.equal(tripUpdates.get('20260807|t911a').delay, 60);
    assert.equal(tripUpdates.get('20260808|t911a').delay, 300);
  });

  it('falls back to a tripId-only lookup when startDate is missing', () => {
    const tu = rt.FeedEntity.create({
      id: 'tu',
      tripUpdate: rt.TripUpdate.create({ trip: rt.TripDescriptor.create({ tripId: 't911a' }), delay: 45 }),
    });
    const { tripUpdates } = parseRealtime(feed([tu]));
    assert.equal(findTripUpdate(tripUpdates, 't911a', null).delay, 45);
  });

  it('keeps a vehicle with no matching TripUpdate', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(vehicles[0].delaySeconds, null);
  });

  it('does not create a phantom vehicle from a TripUpdate alone', () => {
    const { vehicles } = parseRealtime(feed([tripUpdateEntity()]));
    assert.equal(vehicles.length, 0);
  });

  it('uses the TripUpdate delay over a stop-time delay', () => {
    const withStopDelay = rt.FeedEntity.create({
      id: 'tu2',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't911a', startDate: '20260807' }),
        delay: 180,
        stopTimeUpdate: [
          rt.TripUpdate.StopTimeUpdate.create({
            stopSequence: 2,
            stopId: '3',
            arrival: rt.TripUpdate.StopTimeEvent.create({ delay: 90 }),
            departure: rt.TripUpdate.StopTimeEvent.create({ delay: 120 }),
          }),
        ],
      }),
    });
    const { vehicles } = parseRealtime(feed([vehicleEntity(), withStopDelay]));
    assert.equal(vehicles[0].delaySeconds, 180);
  });

  it('falls back to the delay of the next stop-time update', () => {
    const withStopDelay = rt.FeedEntity.create({
      id: 'tu2',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't911a', startDate: '20260807' }),
        stopTimeUpdate: [
          rt.TripUpdate.StopTimeUpdate.create({
            stopSequence: 2,
            stopId: '3',
            arrival: rt.TripUpdate.StopTimeEvent.create({ delay: 90 }),
            departure: rt.TripUpdate.StopTimeEvent.create({ delay: 120 }),
          }),
        ],
      }),
    });
    const { vehicles } = parseRealtime(
      feed([vehicleEntity({ currentStopSequence: 1 }), withStopDelay]),
    );
    assert.equal(vehicles[0].delaySeconds, 120);
  });

  it('falls back to the last stop-time delay when none is ahead', () => {
    const withStopDelay = rt.FeedEntity.create({
      id: 'tu2',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't911a', startDate: '20260807' }),
        stopTimeUpdate: [
          rt.TripUpdate.StopTimeUpdate.create({
            stopSequence: 1,
            stopId: '1',
            departure: rt.TripUpdate.StopTimeEvent.create({ delay: 45 }),
          }),
        ],
      }),
    });
    const { vehicles } = parseRealtime(
      feed([vehicleEntity({ currentStopSequence: 3 }), withStopDelay]),
    );
    assert.equal(vehicles[0].delaySeconds, 45);
  });

  it('rejects a stale position', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity({ timestamp: now() - 300 })]), { now: new Date() });
    assert.equal(vehicles.length, 0);
  });

  it('rejects a future position', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity({ timestamp: now() + 60 })]), { now: new Date() });
    assert.equal(vehicles.length, 0);
  });

  it('rejects a missing position', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity({ vehicle: { position: undefined } })]) , { now: new Date() });
    assert.equal(vehicles.length, 0);
  });

  it('rejects 0,0 and absurd coordinates', () => {
    const zero = vehicleEntity({ vehicle: { position: rt.Position.create({ latitude: 0, longitude: 0 }) } });
    const absurd = vehicleEntity({ vehicle: { position: rt.Position.create({ latitude: 90, longitude: 180 }) } });
    const { vehicles } = parseRealtime(feed([zero, absurd]), { now: new Date() });
    assert.equal(vehicles.length, 0);
  });

  it('accepts a position outside the MPK box but inside the Kłosok network', () => {
    // Długołęka sits north-east of Wrocław; a Wrocław-only bounds check would
    // throw the whole fleet away.
    const entity = vehicleEntity({ vehicle: { position: rt.Position.create({ latitude: 51.2, longitude: 17.1 }) } });
    const { vehicles } = parseRealtime(feed([entity]), { now: new Date() });
    assert.equal(vehicles.length, 1);
  });

  it('derives a stable id from the entity id when the feed omits vehicle ids', () => {
    const entity = vehicleEntity({ vehicle: { vehicle: undefined } });
    const { vehicles } = parseRealtime(feed([entity]), { now: new Date() });
    assert.equal(vehicles[0].id, 'klosok:e1');
    assert.equal(vehicles[0].vehicleId, null);
  });

  it('never publishes speed — raw samples are nonsense', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity()]), { now: new Date() });
    assert.equal(vehicles[0].speed, undefined);
  });

  it('counts speeded vehicles for diagnostics only', () => {
    const { stats } = parseRealtime(feed([vehicleEntity()]), { now: new Date() });
    assert.equal(stats.vehiclesWithSpeed, 1);
  });

  it('marks the snapshot stale when the header timestamp is old', () => {
    const { stale } = parseRealtime(feed([vehicleEntity()], now() - 600), { now: new Date() });
    assert.equal(stale, true);
  });

  it('is not stale with a fresh header', () => {
    const { stale } = parseRealtime(feed([vehicleEntity()]), { now: new Date() });
    assert.equal(stale, false);
  });

  it('survives a buffer that is not a valid GTFS-RT message', () => {
    assert.throws(() => parseRealtime(Buffer.from('not a protobuf')));
  });

  it('counts trips with stop times in stats, including >24h night runs', () => {
    const { stats } = parseRealtime(feed([vehicleEntity()]), { now: new Date() });
    assert.equal(stats.entities, 1);
    assert.equal(stats.vehiclePositions, 1);
    assert.equal(stats.freshPositions, 1);
  });
});

describe('Kłosok label parsing', () => {
  let gtfs;

  before(async () => {
    gtfs = new GtfsStore();
    await gtfs.build(buildKlosokFixtureZip());
  });

  const parse = (label) =>
    parseLabel(label, {
      hasLine: (line) => gtfs.hasLine(line),
      hasBrigade: (brigade) => (gtfs.tripsByBrigade?.get(brigade)?.length ?? 0) > 0,
    });

  it('reads vehicle, line+brigade and destination from a Kłosok-style label', () => {
    assert.deepEqual(parse('9003/91112/KMINKOWA'), {
      vehicleNumber: '9003',
      line: '911',
      brigade: '12',
      destination: 'KMINKOWA',
    });
  });

  it('reads a plain brigade without a line prefix', () => {
    assert.deepEqual(parse('911/12'), { vehicleNumber: '911', line: null, brigade: '12', destination: null });
  });

  it('reads a vehicle between runs — no destination segment', () => {
    assert.deepEqual(parse('9047/91112'), { vehicleNumber: '9047', line: '911', brigade: '12', destination: null });
  });

  it('does not misread a segment whose line does not exist as a line', () => {
    assert.deepEqual(parse('9003/99912/X'), { vehicleNumber: '9003', line: null, brigade: null, destination: 'X' });
  });

  it('survives an empty label', () => {
    assert.deepEqual(parse(null), { vehicleNumber: null, line: null, brigade: null, destination: null });
  });
});

describe('Kłosok → Wrocław GTFS matching', () => {
  let gtfs;

  before(async () => {
    gtfs = new GtfsStore();
    await gtfs.build(buildKlosokFixtureZip());
    gtfs.status.state = 'ready';
  });

  const vehicle = (overrides = {}) => ({
    id: 'klosok:1201',
    operator: null,
    type: 'bus',
    line: null,
    routeId: 'routeId' in overrides ? overrides.routeId : '911',
    tripId: 'tripId' in overrides ? overrides.tripId : 't911a',
    startDate: 'startDate' in overrides ? overrides.startDate : '20260807',
    vehicleId: 'vehicleId' in overrides ? overrides.vehicleId : null,
    vehicleLabel: 'vehicleLabel' in overrides ? overrides.vehicleLabel : '911/12',
    lat: 51.105,
    lon: 17.033,
    heading: 90,
    destination: null,
    delaySeconds: null,
    currentStopSequence: 1,
    positionUpdatedAt: '2026-08-07T06:10:00.000Z',
    source: 'klosok-gtfs-rt',
  });

  it('matches by trip id first', () => {
    const match = resolveEnrichment(gtfs, vehicle(), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'tripId');
    assert.equal(match.line, '911');
    assert.equal(match.headsign, 'WIEPRZYCE');
    assert.equal(match.shapeId, 's911');
    assert.equal(match.brigade, '12');
    assert.equal(match.vehicleId, '1201');
    assert.equal(match.agencyName, 'PT KŁOSOK');
    assert.equal(match.trip.id, 't911a');
  });

  it('matches by route id when the trip id is unknown to the Wrocław feed', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: 'mystery', startDate: null, vehicleLabel: null }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'routeId');
    assert.equal(match.line, '911');
    assert.equal(match.agencyName, 'PT KŁOSOK');
    assert.equal(match.headsign, null);
    assert.equal(match.trip, null);
  });

  it('matches by vehicle id to the run currently in service', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: null, vehicleId: '1201' }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'vehicleId');
    assert.equal(match.line, '911');
    assert.equal(match.trip.id, 't911a');
  });

  it('matches by the brigade in the label when no vehicle id is published', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: null, vehicleId: null }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'brigadeId');
    assert.equal(match.line, '911');
    assert.equal(match.brigade, '12');
    assert.equal(match.trip.id, 't911a');
  });

  it('refuses to claim a trip when two runs of the same bus are in service at once', () => {
    // t911c and t911d overlap 09:10–09:20, so no single run can be named —
    // the bus is still served, but by its line alone, never a guessed run.
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: '911', vehicleId: '1202', vehicleLabel: null }), { now: new Date('2026-08-07T07:15:00Z') });
    assert.equal(match.how, 'routeId');
    assert.equal(match.trip, null);
    assert.equal(match.line, '911');
  });

  it('does not move a bus onto another line just because it shares a brigade number', () => {
    // vehicle 1201 runs line 911; the feed claiming route 921 must not be
    // joined to the 911 run.
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: '921' }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'routeId');
    assert.equal(match.line, '921');
    assert.equal(match.trip, null);
  });

  it('reads line+brigade out of a Kłosok-style label', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: null, vehicleId: null, vehicleLabel: '1201/91112/WIEPRZYCE' }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'brigadeId');
    assert.equal(match.line, '911');
    assert.equal(match.brigade, '12');
    assert.equal(match.trip.id, 't911a');
    assert.equal(match.headsign, 'WIEPRZYCE');
  });

  it('falls back to the label destination when only the line is known', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, vehicleId: null, vehicleLabel: '9999/91123/KMINKOWA' }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match.how, 'routeId');
    assert.equal(match.line, '911');
    assert.equal(match.destination, 'KMINKOWA');
    assert.equal(match.trip, null);
  });

  it('does not match an identifier no timetable entry carries', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: null, vehicleId: '9999', vehicleLabel: '911/99' }), { now: new Date('2026-08-07T06:10:00Z') });
    assert.equal(match, null);
  });

  it('matches a past-midnight night run on the previous service day', () => {
    const match = resolveEnrichment(gtfs, vehicle({ tripId: null, routeId: null, vehicleId: '2101' }), { now: new Date('2026-08-08T23:10:00Z') });
    assert.equal(match.how, 'vehicleId');
    assert.equal(match.trip.id, 't921n');
    assert.equal(match.headsign, 'NOCNY');
  });

  it('pickActiveTrip returns null when two trips run now', () => {
    const indices = gtfs.tripsByVehicleId.get('1202');
    assert.equal(pickActiveTrip(gtfs, indices, new Date('2026-08-07T07:15:00Z')), null);
  });

  it('pickActiveTrip returns the one trip running now', () => {
    const indices = gtfs.tripsByVehicleId.get('1201');
    const index = pickActiveTrip(gtfs, indices, new Date('2026-08-07T06:10:00Z'));
    assert.equal(gtfs.trips[index].id, 't911a');
  });

  it('tripDelay reads the TripUpdate delay directly', () => {
    const update = { delay: 42, stopTimeUpdates: [] };
    assert.equal(tripDelay({}, new Map([['20260807|t911a', update]]), 't911a', '20260807'), 42);
  });

  it('tripDelay returns null when nothing in the feed says how late a bus is', () => {
    assert.equal(tripDelay({}, new Map(), 't911a', '20260807'), null);
  });
});
