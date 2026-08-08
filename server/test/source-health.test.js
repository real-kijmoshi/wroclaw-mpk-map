'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { SourceHealth } = require('../src/http');

describe('SourceHealth', () => {
  it('tries the last good source first', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    health.recordSuccess('b');
    // The first plan is always a probe of the primary.
    assert.deepEqual(health.plan(), ['a', 'b']);
    assert.deepEqual(health.plan(), ['b', 'a'], 'the last good source is preferred');
  });

  it('skips a source in backoff after repeated failures', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    for (let i = 0; i < 3; i += 1) health.recordFailure('a', new Error('down'));
    health.recordSuccess('b');

    health.plan(); // initial probe
    assert.deepEqual(health.plan(), ['b'], 'a is in backoff and skipped');
    assert.deepEqual(health.plan(), ['b', 'a'], 'a is retried once the window passes');
  });

  it('grows the backoff window with each extra failure, bounded by maxBackoffPolls', () => {
    const three = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000, backoffThreshold: 3 });
    three.recordSuccess('b');
    for (let i = 0; i < 3; i += 1) three.recordFailure('a', new Error('down'));
    three.plan(); // initial probe

    let skippedThree = 0;
    let plan = three.plan();
    while (plan.length === 1) {
      skippedThree += 1;
      plan = three.plan();
    }
    assert.equal(skippedThree, 1, 'three failures back off for a short window');
    assert.deepEqual(plan, ['b', 'a']);

    const capped = new SourceHealth(['a', 'b'], {
      probeIntervalPolls: 1000,
      backoffThreshold: 3,
      maxBackoffPolls: 30,
    });
    capped.recordSuccess('b');
    for (let i = 0; i < 20; i += 1) capped.recordFailure('a', new Error('down'));
    capped.plan(); // initial probe

    let skippedCapped = 0;
    plan = capped.plan();
    while (plan.length === 1) {
      skippedCapped += 1;
      plan = capped.plan();
    }
    assert.ok(skippedCapped >= 20, `backoff should be long, got ${skippedCapped} skipped polls`);
    assert.deepEqual(plan, ['b', 'a']);
  });

  it('probes a backed-off primary on a probe cycle so it can recover', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 2 });
    for (let i = 0; i < 3; i += 1) health.recordFailure('a', new Error('down'));
    health.recordSuccess('b');

    // plan #1: probe due, so 'a' is exercised even though it is in backoff.
    assert.deepEqual(health.plan(), ['a', 'b']);
    // plan #2: no probe, 'a' still in backoff -> skipped.
    assert.deepEqual(health.plan(), ['b']);
    // plan #3: probe due again -> 'a' probed.
    assert.deepEqual(health.plan(), ['a', 'b']);
  });

  it('recovers a source as soon as it succeeds', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    for (let i = 0; i < 5; i += 1) health.recordFailure('a', new Error('down'));
    health.recordSuccess('b');

    health.plan(); // initial probe
    assert.deepEqual(health.plan(), ['b'], 'a is deep in backoff');

    health.recordSuccess('a');
    assert.deepEqual(health.plan(), ['a', 'b'], 'a is preferred again immediately');
  });

  it('falls back to the last good source when everything is in backoff', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    health.recordSuccess('b');
    for (let i = 0; i < 3; i += 1) health.recordFailure('a', new Error('down'));
    for (let i = 0; i < 3; i += 1) health.recordFailure('b', new Error('down'));

    health.plan(); // initial probe
    // Everything is in backoff, but the plan must name something rather than
    // return nothing — the best guess is the source that last worked.
    assert.deepEqual(health.plan(), ['b']);
  });

  it('reports compact per-URL state', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    health.recordFailure('a', new Error('boom'));
    health.recordSuccess('b');

    const snapshot = health.snapshot();
    assert.equal(snapshot.length, 2);
    assert.equal(snapshot[0].url, 'a');
    assert.equal(snapshot[0].consecutiveFailures, 1);
    assert.equal(snapshot[0].backoff, false);
    assert.match(snapshot[0].lastError, /boom/);
    assert.ok(snapshot[0].lastAttemptAt);
    assert.equal(snapshot[1].url, 'b');
    assert.equal(snapshot[1].consecutiveFailures, 0);
    assert.equal(snapshot[1].lastError, null);
    assert.ok(snapshot[1].lastSuccessAt);
  });

  it('drops state for sources removed by sync', () => {
    const health = new SourceHealth(['a', 'b'], { probeIntervalPolls: 1000 });
    health.recordSuccess('a');
    health.recordFailure('b', new Error('down'));
    health.sync(['a']);

    assert.deepEqual(
      health.snapshot().map((entry) => entry.url),
      ['a'],
    );
    assert.equal(health.lastGoodUrl, 'a');
  });
});
