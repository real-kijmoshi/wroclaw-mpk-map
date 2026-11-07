'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const APP_ALERT_TIMING = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'alert-timing.ts');

/** The app's `alertFireTime()`, run rather than read — same harness as trip-progress.test.js. */
function loadAlertFireTime(t) {
  if (typeof stripTypeScriptTypes !== 'function') {
    t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
    return null;
  }
  const source = stripTypeScriptTypes(fs.readFileSync(APP_ALERT_TIMING, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(`${source}; return alertFireTime;`)();
}

const NOW = 1_000_000;
const stop = (id, etaSeconds) => ({ id, name: `Stop ${id}`, etaSeconds });
const detail = (nextStops, atStop = null) => ({ trip: { atStop, nextStops } });
const timing = (tripLeadStops = 1, arrivalLeadSeconds = 120) => ({ tripLeadStops, arrivalLeadSeconds });

describe('alert fire time', () => {
  it('fires an arrival alert the chosen lead before the ETA', (t) => {
    const alertFireTime = loadAlertFireTime(t);
    if (!alertFireTime) return;
    const trip = detail([stop('A', 60), stop('C', 600)]);
    const alert = { kind: 'arrival', stopId: 'C' };
    assert.deepEqual(alertFireTime(trip, alert, NOW, timing(1, 120)), { at: NOW + 480_000 });
    assert.deepEqual(alertFireTime(trip, alert, NOW, timing(1, 300)), { at: NOW + 300_000 });
    // Closer than the lead: now, never in the past.
    assert.deepEqual(alertFireTime(detail([stop('C', 30)]), alert, NOW, timing()), { at: NOW });
  });

  it('fires a trip alert when the destination is the chosen number of stops away', (t) => {
    const alertFireTime = loadAlertFireTime(t);
    if (!alertFireTime) return;
    const trip = detail([stop('A', 60), stop('B', 180), stop('C', 300), stop('D', 420)]);
    const alert = { kind: 'trip', stopId: 'D' };
    assert.deepEqual(alertFireTime(trip, alert, NOW, timing(1)), { at: NOW + 300_000 });
    assert.deepEqual(alertFireTime(trip, alert, NOW, timing(2)), { at: NOW + 180_000 });
    assert.deepEqual(alertFireTime(trip, alert, NOW, timing(3)), { at: NOW + 60_000 });
  });

  it('fires at once when the destination is already within the threshold', (t) => {
    const alertFireTime = loadAlertFireTime(t);
    if (!alertFireTime) return;
    const trip = detail([stop('B', 60), stop('C', 180)]);
    assert.deepEqual(alertFireTime(trip, { kind: 'trip', stopId: 'C' }, NOW, timing(2)), { at: NOW });
  });

  it('counts the stop being left as the threshold, the way tripProgress does', (t) => {
    const alertFireTime = loadAlertFireTime(t);
    if (!alertFireTime) return;
    // Standing at A: B and C are still to come, so C is two stops away right now.
    const trip = detail([stop('A', 0), stop('B', 90), stop('C', 240)], { id: 'A' });
    assert.deepEqual(alertFireTime(trip, { kind: 'trip', stopId: 'C' }, NOW, timing(2)), { at: NOW });
    assert.deepEqual(alertFireTime(trip, { kind: 'trip', stopId: 'C' }, NOW, timing(1)), { at: NOW + 90_000 });
  });

  it('reports a stop that is behind the vehicle or has no ETA as passed', (t) => {
    const alertFireTime = loadAlertFireTime(t);
    if (!alertFireTime) return;
    const alert = { kind: 'trip', stopId: 'C' };
    assert.deepEqual(alertFireTime(detail([stop('D', 60)]), alert, NOW, timing()), { passed: true });
    assert.deepEqual(alertFireTime(detail([stop('C', null)]), alert, NOW, timing()), { passed: true });
    assert.deepEqual(alertFireTime({ trip: null }, alert, NOW, timing()), { passed: true });
  });
});
