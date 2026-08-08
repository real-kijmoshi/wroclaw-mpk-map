'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { Metric, timeAsync, timeSync } = require('../src/metrics');

describe('Metric', () => {
  it('records latest, EWMA, max and count with bounded state', () => {
    const metric = new Metric({ alpha: 0.5 });
    metric.record(10);
    metric.record(30);

    assert.equal(metric.snapshot().latest, 30);
    assert.equal(metric.snapshot().max, 30);
    assert.equal(metric.snapshot().count, 2);
    // 10 then 30 with alpha 0.5: ewma = 0.5*30 + 0.5*10 = 20.
    assert.equal(metric.snapshot().ewma, 20);
  });

  it('starts empty and stays empty before any record', () => {
    const metric = new Metric();
    assert.deepEqual(metric.snapshot(), { latest: null, ewma: null, max: null, count: 0 });
  });

  it('ignores non-finite values', () => {
    const metric = new Metric();
    metric.record(Number.NaN);
    metric.record(Infinity);
    metric.record(-Infinity);
    metric.record(5);
    assert.equal(metric.snapshot().count, 1);
    assert.equal(metric.snapshot().max, 5);
  });

  it('does not grow with the number of records', () => {
    const metric = new Metric();
    for (let i = 0; i < 10_000; i += 1) metric.record(i);
    assert.equal(metric.snapshot().count, 10_000);
    assert.equal(metric.snapshot().max, 9999);
  });

  it('resets to empty', () => {
    const metric = new Metric();
    metric.record(1);
    metric.reset();
    assert.deepEqual(metric.snapshot(), { latest: null, ewma: null, max: null, count: 0 });
  });

  it('times synchronous work and returns both the value and the duration', () => {
    const { ms, result } = timeSync(() => 2 + 2);
    assert.equal(result, 4);
    assert.ok(Number.isFinite(ms) && ms >= 0);
  });

  it('times asynchronous work', async () => {
    const { ms, result } = await timeAsync(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    });
    assert.equal(result, 'done');
    assert.ok(Number.isFinite(ms) && ms >= 0);
  });
});
