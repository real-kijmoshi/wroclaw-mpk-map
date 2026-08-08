'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { VehicleDetailCache } = require('../src/vehicle-detail-cache');

// The cache is time-bounded; the TTL and `now` are injected so the validity
// window is exercised without sleeping on the real clock.
const TTL = 5000;

const vehicle = (over) => ({ lat: 1.0, lon: 2.0, heading: 90, ...over });

describe('VehicleDetailCache', () => {
  it('reuses a cached detail within the valid window for the same vehicle state', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const tripA = { run: 't4a', etaSeconds: 120 };
    cache.set(1, 1, '4-1', 40, 2, vehicle(), tripA, 0);

    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 0), tripA);
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 2000), tripA, 'within window');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 5000), tripA, 'last valid instant');
    assert.equal(cache.size, 1, 'no growth on a hit');
  });

  it('a new vehicle poll revision invalidates the old detail', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const tripA = { run: 't4a' };
    cache.set(1, 1, '4-1', 40, 2, vehicle(), tripA, 0);

    assert.equal(cache.get(1, 2, '4-1', 40, 2, vehicle(), 0), null, 'revision 2 misses');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 0), tripA);
  });

  it('a GTFS generation change invalidates the old detail', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const tripA = { run: 't4a' };
    cache.set(1, 1, '4-1', 40, 2, vehicle(), tripA, 0);

    assert.equal(cache.get(2, 1, '4-1', 40, 2, vehicle(), 0), null, 'new generation misses');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 0), tripA, 'old generation still served');
  });

  it('a stationary vehicle still expires by time instead of going stale forever', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const tripA = { run: 't4a', delaySeconds: 60 };
    cache.set(1, 1, '4-1', 40, 2, vehicle(), tripA, 0);

    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 0), tripA);
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 5000), tripA, 'last valid instant');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 5001), null, 'expired by the TTL');
  });

  it('different limit and history values do not collide', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const wide = { stopsAhead: 40 };
    const narrow = { stopsAhead: 10 };
    cache.set(1, 1, '4-1', 40, 2, vehicle(), wide, 0);
    cache.set(1, 1, '4-1', 10, 5, vehicle(), narrow, 0);

    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle(), 0), wide);
    assert.equal(cache.get(1, 1, '4-1', 10, 5, vehicle(), 0), narrow);
    assert.equal(cache.size, 2, 'two distinct slices, no collision');
  });

  it('recomputes when the vehicle has moved or turned', () => {
    const cache = new VehicleDetailCache({ maxEntries: 10, ttlMs: TTL });
    const tripA = { run: 't4a' };
    cache.set(1, 1, '4-1', 40, 2, vehicle({ heading: 90 }), tripA, 0);

    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle({ heading: 90 }), 0), tripA, 'unchanged heading');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle({ heading: 180 }), 0), null, 'turned -> recompute');
    assert.equal(cache.get(1, 1, '4-1', 40, 2, vehicle({ lat: 3.0 }), 0), null, 'moved -> recompute');
  });

  it('evicts the oldest entry and clears on demand', () => {
    const cache = new VehicleDetailCache({ maxEntries: 2, ttlMs: TTL });
    const a = { run: 'a' };
    const b = { run: 'b' };
    const c = { run: 'c' };
    cache.set(1, 1, 'a', 40, 2, vehicle(), a, 0);
    cache.set(1, 1, 'b', 40, 2, vehicle(), b, 0);
    assert.equal(cache.size, 2);

    cache.set(1, 1, 'c', 40, 2, vehicle(), c, 0);
    assert.equal(cache.get(1, 1, 'a', 40, 2, vehicle(), 0), null, 'evicted');
    assert.equal(cache.get(1, 1, 'b', 40, 2, vehicle(), 0), b);
    assert.equal(cache.get(1, 1, 'c', 40, 2, vehicle(), 0), c);

    cache.clear();
    assert.equal(cache.size, 0);
  });
});
