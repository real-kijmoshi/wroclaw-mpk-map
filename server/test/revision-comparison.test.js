'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { mapVehicleEquals, fullVehicleEquals } = require('../src/klosok/service');

const baseKlosok = {
  id: 'klosok:abc',
  operator: 'PT KŁOSOK',
  type: 'bus',
  line: '150',
  routeId: 'route:kl1',
  tripId: 'trip:kl1',
  vehicleId: 'vid:1',
  vehicleLabel: null,
  lat: 51.12,
  lon: 17.04,
  heading: 180,
  destination: 'Dworzec Główny',
  delaySeconds: 0,
  currentStopSequence: 2,
  startDate: '2026-08-01',
  positionUpdatedAt: '2026-08-01T10:00:00Z',
  source: 'klosok-gtfs-rt',
  brigade: 'B1',
  updatedAt: '2026-08-01T10:00:05Z',
};

describe('mapVehicleEquals / fullVehicleEquals', () => {
  describe('map equality (fields visible in /locations?format=map)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(mapVehicleEquals({ ...baseKlosok }, { ...baseKlosok }));
    });

    it('destination is a map-visible field', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, destination: 'Inny Dworzec' };
      assert.ok(!mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('brigade is map-visible', () => {
      const a = { ...baseKlosok, brigade: 'B1' };
      const b = { ...baseKlosok, brigade: 'B2' };
      assert.ok(!mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('tripId is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, tripId: 'trip:kl2' };
      assert.ok(!mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('operator is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, operator: 'OTHER' };
      assert.ok(!mapVehicleEquals(a, b));
    });

    it('delaySeconds is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, delaySeconds: 60 };
      assert.ok(!mapVehicleEquals(a, b));
    });

    it('lat/lon change is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, lat: 51.13 };
      assert.ok(!mapVehicleEquals(a, b));
    });

    it('heading change is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, heading: 90 };
      assert.ok(!mapVehicleEquals(a, b));
    });
  });

  describe('full equality (fields visible in full /locations only)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(fullVehicleEquals({ ...baseKlosok }, { ...baseKlosok }));
    });

    it('updatedAt is full-only and changes on every poll', () => {
      const a = { ...baseKlosok, updatedAt: '2026-08-01T10:00:05Z' };
      const b = { ...baseKlosok, updatedAt: '2026-08-01T10:00:06Z' };
      assert.ok(mapVehicleEquals(a, b), 'updatedAt not in map format');
      assert.ok(!fullVehicleEquals(a, b), 'updatedAt in full format');
    });

    it('currentStopSequence is full-only', () => {
      const a = { ...baseKlosok, currentStopSequence: 2 };
      const b = { ...baseKlosok, currentStopSequence: 3 };
      assert.ok(mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('startDate is full-only', () => {
      const a = { ...baseKlosok, startDate: '2026-07-31' };
      const b = { ...baseKlosok, startDate: '2026-08-01' };
      assert.ok(mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('vehicleId is full-only', () => {
      const a = { ...baseKlosok, vehicleId: 'vid:1' };
      const b = { ...baseKlosok, vehicleId: 'vid:2' };
      assert.ok(mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });

    it('only full-only fields differ → map still equal', () => {
      const a = { ...baseKlosok, updatedAt: '2026-08-01T10:00:05Z', currentStopSequence: 2 };
      const b = { ...baseKlosok, updatedAt: '2026-08-01T10:00:08Z', currentStopSequence: 5 };
      assert.ok(mapVehicleEquals(a, b));
      assert.ok(!fullVehicleEquals(a, b));
    });
  });
});
