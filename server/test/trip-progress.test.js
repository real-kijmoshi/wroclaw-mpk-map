'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const { tripProgress } = require('../src/live-activities');

const APP_TRIP_PROGRESS = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'trip-progress.ts');

/**
 * The app's `tripProgress()`, run rather than read.
 *
 * The lock screen is drawn from the server's count while the app is suspended
 * and from the app's own while it is open, so the two copies must agree stop
 * for stop — a Live Activity that says 3 while the sheet says 2 is the kind of
 * disagreement a rider notices on the one tram they are trying not to miss.
 */
function loadAppTripProgress() {
  const source = stripTypeScriptTypes(fs.readFileSync(APP_TRIP_PROGRESS, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(`${source}; return { tripProgress, activityStaleAt };`)();
}

const stop = (id, etaSeconds = 60) => ({ id, name: `Stop ${id}`, etaSeconds });

const FIXTURES = [
  ['on the way', { atStop: null, nextStops: [stop('A'), stop('B'), stop('C', 240)] }, 'C'],
  ['standing at an intermediate stop', { atStop: { id: 'A' }, nextStops: [stop('A', 0), stop('B'), stop('C')] }, 'C'],
  ['one stop out', { atStop: null, nextStops: [stop('C', 50), stop('D')] }, 'C'],
  ['standing at the destination', { atStop: { id: 'C' }, nextStops: [stop('C', 0), stop('D')] }, 'C'],
  ['destination behind', { atStop: null, nextStops: [stop('D')] }, 'C'],
  ['no ETA served', { atStop: null, nextStops: [stop('A'), stop('C', null)] }, 'C'],
  ['no trip at all', null, 'C'],
];

describe('trip progress, app and server', () => {
  it('count the same stops for every shape of payload', (t) => {
    if (typeof stripTypeScriptTypes !== 'function') {
      t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
      return;
    }
    const appTripProgress = loadAppTripProgress().tripProgress;
    for (const [label, trip, destination] of FIXTURES) {
      assert.deepEqual(appTripProgress(trip, destination), tripProgress(trip, destination), label);
    }
  });
});

describe('trip progress, next stop', () => {
  it('says when the next stop is due, skipping the one being left', () => {
    const trip = { atStop: { id: 'A' }, nextStops: [stop('A', 0), stop('B', 90), stop('C', 240)] };
    assert.equal(tripProgress(trip, 'C').nextStopEtaSeconds, 90);
    assert.equal(tripProgress({ atStop: null, nextStops: [stop('A', null), stop('C')] }, 'C').nextStopEtaSeconds, null);
  });
});

describe('Live Activity stale date', () => {
  const now = 1_000_000;
  const arrivesAt = now + 10 * 60_000;
  const load = (t) => {
    if (typeof stripTypeScriptTypes !== 'function') {
      t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
      return null;
    }
    return loadAppTripProgress().activityStaleAt;
  };

  it('keeps a trip nobody pushes to only until its next stop is passed', (t) => {
    const activityStaleAt = load(t);
    if (!activityStaleAt) return;
    // The screenshot: "4 stops" still on the lock screen after getting off.
    assert.equal(activityStaleAt({ arrivesAt, nextStopAt: now + 60_000, pushed: false, now }), now + 80_000);
  });

  it('lasts to the arrival when the server is pushing, or when no count is drawn', (t) => {
    const activityStaleAt = load(t);
    if (!activityStaleAt) return;
    assert.equal(activityStaleAt({ arrivesAt, nextStopAt: now + 60_000, pushed: true, now }), arrivesAt + 60_000);
    assert.equal(activityStaleAt({ arrivesAt, nextStopAt: null, pushed: false, now }), arrivesAt + 60_000);
  });

  it('never goes stale in the past, or later than the arrival', (t) => {
    const activityStaleAt = load(t);
    if (!activityStaleAt) return;
    assert.equal(activityStaleAt({ arrivesAt, nextStopAt: now - 30_000, pushed: false, now }), now + 20_000);
    assert.equal(
      activityStaleAt({ arrivesAt: now + 30_000, nextStopAt: now + 120_000, pushed: false, now }),
      now + 90_000,
    );
  });
});
