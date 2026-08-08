'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { pointAt, advance } = require('../scripts/benchmark-describe');

// A 2000 m variant: (0,0) → (0,1) → (0,2), each segment 1000 m.
const D = 1000;
const variant = {
  points: new Float64Array([0, 0, 0, 1, 0, 2]),
  cumulative: new Float64Array([0, D, 2 * D]),
  lengthMeters: 2 * D,
  line: '1',
  shapeId: 's1',
};

describe('pointAt', () => {
  it('returns the start vertex at 0 metres', () => {
    const p = pointAt(variant, 0);
    assert.equal(p.lat, 0);
    assert.equal(p.lon, 0);
  });

  it('returns the end vertex at full length', () => {
    const p = pointAt(variant, 2 * D);
    assert.equal(p.lat, 0);
    assert.equal(p.lon, 2);
  });

  it('returns the midpoint vertex at half the length', () => {
    const p = pointAt(variant, D);
    assert.equal(p.lat, 0);
    assert.equal(p.lon, 1);
  });

  it('interpolates along the first segment', () => {
    const p = pointAt(variant, D / 2);
    assert.equal(p.lat, 0);
    assert.equal(p.lon, 0.5);
  });
});

describe('advance', () => {
  it('advances a vehicle by STEP_METERS along its route', () => {
    const vehicle = {
      id: '1-0',
      line: '1',
      lat: 0,
      lon: 0.5,
      heading: 90,
      variant,
      along: D / 2,
      lengthMeters: variant.lengthMeters,
    };

    const states = new Map();
    states.set(vehicle.id, { shapeId: 's1', alongMeters: 500, polylineIndex: 0 });
    const turned = advance(vehicle, states);

    assert.equal(turned, false, 'did not reach the terminus');
    assert.equal(vehicle.along, D / 2 + 120, 'advanced by STEP_METERS');
    assert.ok(states.has(vehicle.id), 'state was not dropped');
  });

  it('re-seeds at the midpoint when reaching the terminus, not 0.5 metres', () => {
    const vehicle = {
      id: '1-0',
      line: '1',
      lat: 0,
      lon: 2,
      heading: 90,
      variant,
      along: variant.lengthMeters - 60, // +120 (STEP_METERS) exceeds lengthMeters - 1
      lengthMeters: variant.lengthMeters,
    };

    const states = new Map();
    states.set(vehicle.id, { shapeId: 's1', alongMeters: 1950, polylineIndex: 1 });
    const turned = advance(vehicle, states);

    assert.equal(turned, true, 'vehicle reached the terminus');
    assert.notEqual(vehicle.along, 0.5, 'must not re-seed at 0.5 metres');
    assert.equal(vehicle.along, variant.lengthMeters * 0.5, 're-seeded at the midpoint');
    const expected = pointAt(variant, variant.lengthMeters * 0.5);
    assert.equal(vehicle.lat, expected.lat);
    assert.equal(vehicle.lon, expected.lon);
    assert.equal(states.has(vehicle.id), false, 'previous state was dropped');
  });
});
