'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { GrowableFloat64Array, GrowableInt32Array } = require('../src/gtfs/typed-arrays');

describe('GrowableInt32Array', () => {
  it('grows past its initial capacity and returns an exact-size copy', () => {
    const builder = new GrowableInt32Array(4);
    for (let i = 0; i < 1000; i += 1) builder.push(i);

    const out = builder.toArray();
    assert.ok(out instanceof Int32Array);
    assert.equal(out.length, 1000);
    assert.equal(out[0], 0);
    assert.equal(out[999], 999);
  });

  it('sorts the used prefix and returns it exactly sized', () => {
    const builder = new GrowableInt32Array(2);
    for (const value of [9, 1, 7, 3]) builder.push(value);

    const sorted = builder.takeSorted((a, b) => a - b);
    assert.deepEqual([...sorted], [1, 3, 7, 9]);
    assert.equal(sorted.length, 4);
  });

  it('keeps doubles in a Float64Array', () => {
    const builder = new GrowableFloat64Array(2);
    builder.push(1.5);
    builder.push(-2.25);
    const out = builder.toArray();
    assert.deepEqual([...out], [1.5, -2.25]);
  });
});
