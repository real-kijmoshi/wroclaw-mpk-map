'use strict';

process.env.KD_GTFS_RT_MAX_AGE_MS = '120000';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const { findTripUpdate, parseRealtime } = require('../src/kd/realtime');

const O = rt.VehiclePosition.OccupancyStatus;

const now = () => Math.floor(Date.now() / 1000);

const encode = (message) => Buffer.from(rt.FeedMessage.encode(message).finish());

const vehicleEntity = (overrides = {}) =>
  rt.FeedEntity.create({
    id: 'v1',
    vehicle: rt.VehiclePosition.create({
      trip: rt.TripDescriptor.create({
        tripId: 't1',
        routeId: '356696',
        startDate: '20260807',
        ...(overrides.trip || {}),
      }),
      vehicle: rt.VehicleDescriptor.create({ id: '31WE-001', label: '31WE' }),
      position: rt.Position.create({ latitude: 51.1, longitude: 17.03, bearing: 90, speed: 20 }),
      timestamp: overrides.timestamp ?? now(),
      ...(overrides.vehicle || {}),
    }),
  });

const tripUpdateEntity = (overrides = {}) =>
  rt.FeedEntity.create({
    id: 'tu1',
    tripUpdate: rt.TripUpdate.create({
      trip: rt.TripDescriptor.create({ tripId: 't1', routeId: '356696', startDate: '20260807' }),
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

describe('KD GTFS-RT parsing', () => {
  it('decodes a vehicle position into the expected shape', () => {
    const { vehicles, tripUpdates } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(vehicles.length, 1);
    const v = vehicles[0];
    assert.equal(v.id, 'kd:vehicle:31WE-001');
    assert.equal(v.operator, 'KD');
    assert.equal(v.type, 'train');
    assert.equal(v.routeId, '356696');
    assert.equal(v.tripId, 't1');
    assert.equal(v.vehicleLabel, '31WE');
    assert.equal(v.lat, 51.1);
    assert.equal(v.lon, 17.03);
    assert.equal(v.heading, 90);
    assert.equal(v.speed, 72); // m/s -> km/h
    assert.equal(v.occupancyStatus, null);
    assert.equal(v.source, 'kd-gtfs-rt');
    assert.equal(tripUpdates.size, 0);
  });

  it('maps occupancy enum values to stable strings', () => {
    const entity = vehicleEntity({
      vehicle: { occupancyStatus: O.MANY_SEATS_AVAILABLE, occupancyPercentage: 40 },
    });
    const { vehicles } = parseRealtime(feed([entity]));
    assert.equal(vehicles[0].occupancyStatus, 'MANY_SEATS_AVAILABLE');
    assert.equal(vehicles[0].occupancyPercentage, 40);
  });

  it('leaves occupancyPercentage null when the feed does not provide it', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(vehicles[0].occupancyPercentage, null);
  });

  it('joins a TripUpdate to a vehicle and derives delaySeconds', () => {
    const { vehicles, tripUpdates } = parseRealtime(
      feed([vehicleEntity(), tripUpdateEntity({ delay: 180 })]),
    );
    assert.equal(vehicles[0].delaySeconds, 180);
    assert.equal(tripUpdates.size, 1);
    const update = findTripUpdate(tripUpdates, 't1', '20260807');
    assert.equal(update.delay, 180);
  });

  it('keeps a vehicle with no matching TripUpdate', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].delaySeconds, null);
  });

  it('does not create a phantom vehicle from a TripUpdate alone', () => {
    const { vehicles } = parseRealtime(feed([tripUpdateEntity()]));
    assert.equal(vehicles.length, 0);
  });

  it('uses TripUpdate delay and falls back to a stop-time delay', () => {
    const withStopDelay = rt.FeedEntity.create({
      id: 'tu2',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't1', startDate: '20260807' }),
        stopTimeUpdate: [
          rt.TripUpdate.StopTimeUpdate.create({
            stopSequence: 2,
            stopId: '21',
            arrival: rt.TripUpdate.StopTimeEvent.create({ delay: 90 }),
            departure: rt.TripUpdate.StopTimeEvent.create({ delay: 120 }),
          }),
        ],
      }),
    });
    const { vehicles } = parseRealtime(feed([vehicleEntity(), withStopDelay]));
    assert.equal(vehicles[0].delaySeconds, 120);
  });

  it('rejects a stale position', () => {
    const { vehicles } = parseRealtime(
      feed([vehicleEntity({ timestamp: now() - 300 })]),
      { now: new Date() },
    );
    assert.equal(vehicles.length, 0);
  });

  it('rejects a future position', () => {
    const { vehicles } = parseRealtime(feed([vehicleEntity({ timestamp: now() + 60 })]));
    assert.equal(vehicles.length, 0);
  });

  it('rejects a missing position', () => {
    const entity = vehicleEntity({ vehicle: { position: undefined } });
    const { vehicles } = parseRealtime(feed([entity]));
    assert.equal(vehicles.length, 0);
  });

  it('rejects 0,0 and absurd coordinates', () => {
    const zero = vehicleEntity({ vehicle: { position: rt.Position.create({ latitude: 0, longitude: 0 }) } });
    const absurd = vehicleEntity({ vehicle: { position: rt.Position.create({ latitude: 90, longitude: 180 }) } });
    const { vehicles } = parseRealtime(feed([zero, absurd]));
    assert.equal(vehicles.length, 0);
  });

  it('derives a vehicle id from the trip when no vehicle id is published', () => {
    const entity = vehicleEntity({ vehicle: { vehicle: undefined } });
    const { vehicles } = parseRealtime(feed([entity]));
    assert.equal(vehicles[0].id, 'kd:vehicle:trip:t1');
  });

  it('does not crash on an unknown trip id', () => {
    const entity = vehicleEntity({ trip: { tripId: 'unknown-trip' } });
    const { vehicles } = parseRealtime(feed([entity]));
    assert.equal(vehicles[0].rawTripId, 'unknown-trip');
  });

  it('distinguishes trips with the same id on different start dates', () => {
    const a = tripUpdateEntity({ tripUpdate: { delay: 60 } });
    const b = rt.FeedEntity.create({
      id: 'tu-b',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't1', startDate: '20260808' }),
        delay: 300,
      }),
    });
    const { tripUpdates } = parseRealtime(feed([a, b]));
    assert.equal(tripUpdates.get('20260807|t1').delay, 60);
    assert.equal(tripUpdates.get('20260808|t1').delay, 300);
  });

  it('falls back to a tripId-only lookup when startDate is missing', () => {
    const tu = rt.FeedEntity.create({
      id: 'tu',
      tripUpdate: rt.TripUpdate.create({
        trip: rt.TripDescriptor.create({ tripId: 't1' }),
        delay: 45,
      }),
    });
    const { tripUpdates } = parseRealtime(feed([tu]));
    const update = findTripUpdate(tripUpdates, 't1', null);
    assert.equal(update.delay, 45);
  });

  it('marks the snapshot stale when the header timestamp is old', () => {
    const { stale } = parseRealtime(
      feed([vehicleEntity()], now() - 600),
      { now: new Date() },
    );
    assert.equal(stale, true);
  });

  it('is not stale with a fresh header', () => {
    const { stale } = parseRealtime(feed([vehicleEntity()]));
    assert.equal(stale, false);
  });

  it('survives a buffer that is not a valid GTFS-RT message', () => {
    assert.throws(() => parseRealtime(Buffer.from('not a protobuf')));
  });
});
