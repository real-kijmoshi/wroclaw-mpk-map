'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { mapVehicleEquals: kdMapVehicleEquals, fullVehicleEquals: kdFullVehicleEquals } = require('../src/kd/service');
const { mapVehicleEquals: klosokMapVehicleEquals, fullVehicleEquals: klosokFullVehicleEquals } = require('../src/klosok/service');

const baseKd = {
  id: 'kd:1',
  operator: 'KD',
  type: 'train',
  line: 'IC233',
  routeId: 'route:1',
  tripId: 'trip:1',
  startDate: '2026-07-31',
  vehicleLabel: 'V123',
  lat: 51.1,
  lon: 17.03,
  heading: 42,
  speed: 55,
  destination: 'Wrocław Główny',
  delaySeconds: 0,
  occupancyStatus: 'fewSeatsAvailable',
  occupancyPercentage: 30,
  positionUpdatedAt: '2026-08-01T10:00:00Z',
  source: 'kd-gtfs-rt',
  rawTripId: 'raw:1',
  currentStopSequence: 3,
};

const baseKlosok = {
  id: 'klosok:abc',
  operator: 'Kłosówka',
  type: 'bus',
  line: '150',
  routeId: 'route:kl1',
  tripId: 'trip:kl1',
  tripHeadsign: 'Dworzec Główny',
  vehicleId: 'vid:1',
  vehicleLabel: null,
  lat: 51.12,
  lon: 17.04,
  heading: 180,
  destination: 'Dworzec Główny',
  delaySeconds: 0,
  currentStopSequence: 2,
  positionUpdatedAt: '2026-08-01T10:00:00Z',
  source: 'klosok-gtfs-rt',
  brigade: 'B1',
  updatedAt: '2026-08-01T10:00:05Z',
};

describe('kdMapVehicleEquals / kdFullVehicleEquals', () => {
  describe('map equality (fields visible in /locations?format=map)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(kdMapVehicleEquals({ ...baseKd }, { ...baseKd }));
    });

    it('destination is a map-visible field', () => {
      const b = { ...baseKd };
      const c = { ...baseKd, destination: 'Wrocław Psie Pole' };
      assert.ok(!kdMapVehicleEquals(b, c), 'destination change affects map format');
      assert.ok(!kdFullVehicleEquals(b, c), 'destination change affects full format');
    });

    it('brigade is map-visible (when present)', () => {
      const a = { ...baseKd, brigade: 'X1' };
      const b = { ...baseKd, brigade: 'X2' };
      assert.ok(!kdMapVehicleEquals(a, b));
    });

    it('tripId is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, tripId: 'trip:2' };
      assert.ok(!kdMapVehicleEquals(a, b));
      assert.ok(!kdFullVehicleEquals(a, b));
    });

    it('operator is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, operator: 'OTHER' };
      assert.ok(!kdMapVehicleEquals(a, b));
    });

    it('delaySeconds is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, delaySeconds: 120 };
      assert.ok(!kdMapVehicleEquals(a, b));
    });

    it('occupancyStatus is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, occupancyStatus: 'standingRoomOnly' };
      assert.ok(!kdMapVehicleEquals(a, b));
    });

    it('lat/lon change is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, lat: 51.2 };
      assert.ok(!kdMapVehicleEquals(a, b));
    });

    it('heading change is map-visible', () => {
      const a = { ...baseKd };
      const b = { ...baseKd, heading: 99 };
      assert.ok(!kdMapVehicleEquals(a, b));
    });
  });

  describe('full equality (fields visible in full /locations only)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(kdFullVehicleEquals({ ...baseKd }, { ...baseKd }));
    });

    it('speed is full-only', () => {
      const a = { ...baseKd, speed: 55 };
      const b = { ...baseKd, speed: 60 };
      assert.ok(kdMapVehicleEquals(a, b), 'speed not in map format');
      assert.ok(!kdFullVehicleEquals(a, b), 'speed in full format');
    });

    it('currentStopSequence is full-only', () => {
      const a = { ...baseKd, currentStopSequence: 3 };
      const b = { ...baseKd, currentStopSequence: 4 };
      assert.ok(kdMapVehicleEquals(a, b), 'currentStopSequence not in map format');
      assert.ok(!kdFullVehicleEquals(a, b), 'currentStopSequence in full format');
    });

    it('startDate is full-only', () => {
      const a = { ...baseKd, startDate: '2026-07-31' };
      const b = { ...baseKd, startDate: '2026-08-01' };
      assert.ok(kdMapVehicleEquals(a, b));
      assert.ok(!kdFullVehicleEquals(a, b));
    });

    it('rawTripId is full-only', () => {
      const a = { ...baseKd, rawTripId: 'raw:1' };
      const b = { ...baseKd, rawTripId: 'raw:2' };
      assert.ok(kdMapVehicleEquals(a, b));
      assert.ok(!kdFullVehicleEquals(a, b));
    });

    it('map-invisible change does not affect map equality', () => {
      const a = { ...baseKd, speed: 10, currentStopSequence: 1 };
      const b = { ...baseKd, speed: 999, currentStopSequence: 99 };
      assert.ok(kdMapVehicleEquals(a, b), 'only full-only fields differ');
    });
  });
});

describe('klosokMapVehicleEquals / klosokFullVehicleEquals', () => {
  describe('map equality (fields visible in /locations?format=map)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(klosokMapVehicleEquals({ ...baseKlosok }, { ...baseKlosok }));
    });

    it('destination is a map-visible field', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, destination: 'Inny Dworzec' };
      assert.ok(!klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('brigade is map-visible', () => {
      const a = { ...baseKlosok, brigade: 'B1' };
      const b = { ...baseKlosok, brigade: 'B2' };
      assert.ok(!klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('tripId is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, tripId: 'trip:kl2' };
      assert.ok(!klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('operator is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, operator: 'OTHER' };
      assert.ok(!klosokMapVehicleEquals(a, b));
    });

    it('delaySeconds is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, delaySeconds: 60 };
      assert.ok(!klosokMapVehicleEquals(a, b));
    });

    it('lat/lon change is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, lat: 51.13 };
      assert.ok(!klosokMapVehicleEquals(a, b));
    });

    it('heading change is map-visible', () => {
      const a = { ...baseKlosok };
      const b = { ...baseKlosok, heading: 90 };
      assert.ok(!klosokMapVehicleEquals(a, b));
    });
  });

  describe('full equality (fields visible in full /locations only)', () => {
    it('returns true for identical vehicles', () => {
      assert.ok(klosokFullVehicleEquals({ ...baseKlosok }, { ...baseKlosok }));
    });

    it('updatedAt is full-only and changes on every poll', () => {
      const a = { ...baseKlosok, updatedAt: '2026-08-01T10:00:05Z' };
      const b = { ...baseKlosok, updatedAt: '2026-08-01T10:00:06Z' };
      assert.ok(klosokMapVehicleEquals(a, b), 'updatedAt not in map format');
      assert.ok(!klosokFullVehicleEquals(a, b), 'updatedAt in full format');
    });

    it('currentStopSequence is full-only', () => {
      const a = { ...baseKlosok, currentStopSequence: 2 };
      const b = { ...baseKlosok, currentStopSequence: 3 };
      assert.ok(klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('tripHeadsign is full-only', () => {
      const a = { ...baseKlosok, tripHeadsign: 'Dworzec Główny' };
      const b = { ...baseKlosok, tripHeadsign: 'Lotnisko' };
      assert.ok(klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('vehicleId is full-only', () => {
      const a = { ...baseKlosok, vehicleId: 'vid:1' };
      const b = { ...baseKlosok, vehicleId: 'vid:2' };
      assert.ok(klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });

    it('only full-only fields differ → map still equal', () => {
      const a = { ...baseKlosok, updatedAt: '2026-08-01T10:00:05Z', currentStopSequence: 2 };
      const b = { ...baseKlosok, updatedAt: '2026-08-01T10:00:08Z', currentStopSequence: 5 };
      assert.ok(klosokMapVehicleEquals(a, b));
      assert.ok(!klosokFullVehicleEquals(a, b));
    });
  });
});
