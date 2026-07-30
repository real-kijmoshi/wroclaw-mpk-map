'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { bearing, normalizeVehicle } = require('../src/vehicles');

describe('normalizeVehicle', () => {
  it('maps the MPK payload, where x is latitude', () => {
    const vehicle = normalizeVehicle({ x: 51.107, y: 17.038, name: '4', k: 8123, type: 'tram' });
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.id, '4-8123');
  });

  it('accepts alternative field names', () => {
    const vehicle = normalizeVehicle({ latitude: 51.1, longitude: 17.0, line: '128' });
    assert.equal(vehicle.line, '128');
    assert.equal(vehicle.type, 'bus');
  });

  it('rejects positions outside Wrocław', () => {
    assert.equal(normalizeVehicle({ x: 0, y: 0, name: '4' }), null);
    assert.equal(normalizeVehicle({ x: 52.23, y: 21.0, name: '4' }), null, 'that is Warsaw');
    assert.equal(normalizeVehicle({ x: 'n/a', y: 'n/a', name: '4' }), null);
  });

  it('rejects records without a line', () => {
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0 }), null);
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0, name: '  ' }), null);
  });

  it('never throws on junk', () => {
    assert.equal(normalizeVehicle(null), null);
    assert.equal(normalizeVehicle('nope'), null);
    assert.equal(normalizeVehicle(undefined), null);
  });

  it('derives a stable id when the vehicle number is missing', () => {
    const a = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    const b = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    assert.equal(a.id, b.id);
  });
});

describe('bearing', () => {
  it('points north when moving north', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.2, 17.0)) < 1);
  });

  it('points east when moving east', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.1, 17.1) - 90) < 1);
  });
});
