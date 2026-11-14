'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const APP_LIB = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib');

/** Run an import-free app module, the way trip-progress.test.js does. */
function loadAppModule(t, file, names) {
  if (typeof stripTypeScriptTypes !== 'function') {
    t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
    return null;
  }
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(APP_LIB, file), 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(`${source}; return { ${names.join(', ')} };`)();
}

describe('incident focus view', () => {
  it('never centres the camera on 0,0 when no stop has a position', (t) => {
    const mod = loadAppModule(t, 'incident-focus.ts', ['incidentFocusView']);
    if (!mod) return;
    assert.equal(mod.incidentFocusView([]), null);
    assert.equal(mod.incidentFocusView([{ lat: Number.NaN, lon: 17 }, { lat: 51, lon: Infinity }]), null);
  });

  it('ignores a stop without coordinates instead of averaging it in', (t) => {
    const mod = loadAppModule(t, 'incident-focus.ts', ['incidentFocusView']);
    if (!mod) return;
    const view = mod.incidentFocusView([{ lat: 51.11, lon: 17.03 }, { lat: Number.NaN, lon: 0 }]);
    assert.deepEqual(view, { lat: 51.11, lon: 17.03, zoom: 16 });
  });

  it('centres on the bounding box, so a cluster cannot drag it off a lone stop', (t) => {
    const mod = loadAppModule(t, 'incident-focus.ts', ['incidentFocusView']);
    if (!mod) return;
    const junction = Array.from({ length: 5 }, () => ({ lat: 51.10, lon: 17.00 }));
    const view = mod.incidentFocusView([...junction, { lat: 51.12, lon: 17.04 }]);
    assert.ok(Math.abs(view.lat - 51.11) < 1e-9);
    assert.ok(Math.abs(view.lon - 17.02) < 1e-9);
  });

  it('zooms out as the stops spread across town', (t) => {
    const mod = loadAppModule(t, 'incident-focus.ts', ['incidentFocusView']);
    if (!mod) return;
    const near = mod.incidentFocusView([{ lat: 51.11, lon: 17.03 }, { lat: 51.112, lon: 17.031 }]);
    const far = mod.incidentFocusView([{ lat: 51.08, lon: 16.95 }, { lat: 51.14, lon: 17.10 }]);
    assert.equal(near.zoom, 16);
    assert.equal(far.zoom, 12);
  });
});

describe('leave alert follow', () => {
  const NOW = 10_000_000;
  const current = { departureAt: NOW + 600_000, firesAt: NOW + 300_000 };

  it('keeps the reminder when its departure is missing from one board', (t) => {
    const mod = loadAppModule(t, 'leave-timing.ts', ['followLeaveAlert']);
    if (!mod) return;
    assert.deepEqual(mod.followLeaveAlert(current, null, NOW), { action: 'keep' });
  });

  it('drops it once a missing departure is really gone', (t) => {
    const mod = loadAppModule(t, 'leave-timing.ts', ['followLeaveAlert']);
    if (!mod) return;
    assert.deepEqual(mod.followLeaveAlert(current, null, NOW + 630_000), { action: 'drop' });
  });

  it('drops it when the board says the departure has left', (t) => {
    const mod = loadAppModule(t, 'leave-timing.ts', ['followLeaveAlert']);
    if (!mod) return;
    const live = { departureAt: NOW - 31_000, firesAt: NOW - 400_000 };
    assert.deepEqual(mod.followLeaveAlert(current, live, NOW), { action: 'drop' });
  });

  it('ignores churn and reschedules a real change', (t) => {
    const mod = loadAppModule(t, 'leave-timing.ts', ['followLeaveAlert']);
    if (!mod) return;
    const jitter = { departureAt: current.departureAt + 10_000, firesAt: current.firesAt + 10_000 };
    const late = { departureAt: current.departureAt + 120_000, firesAt: current.firesAt + 120_000 };
    assert.deepEqual(mod.followLeaveAlert(current, jitter, NOW), { action: 'keep' });
    assert.deepEqual(mod.followLeaveAlert(current, late, NOW), { action: 'reschedule' });
  });

  it('does not move a reminder that has already gone out', (t) => {
    const mod = loadAppModule(t, 'leave-timing.ts', ['followLeaveAlert']);
    if (!mod) return;
    const fired = { departureAt: NOW + 200_000, firesAt: NOW - 1_000 };
    const late = { departureAt: NOW + 400_000, firesAt: NOW + 100_000 };
    assert.deepEqual(mod.followLeaveAlert(fired, late, NOW), { action: 'keep' });
  });
});

describe('classic marker spacing', () => {
  // 100pt across 0.01° both ways: one point is 0.0001°.
  const view = { latitudeDelta: 0.01, longitudeDelta: 0.01, width: 100, height: 100 };
  const at = (id, x, y) => ({ id, lat: y * 0.0001, lon: x * 0.0001 });

  it('drops a badge that would land on one already drawn', (t) => {
    const mod = loadAppModule(t, 'marker-spacing.ts', ['spaceMarkers']);
    if (!mod) return;
    const kept = mod.spaceMarkers([at('a', 0, 0), at('b', 10, 0), at('c', 50, 0)], view, 40);
    assert.deepEqual(kept.map((item) => item.id), ['a', 'c']);
  });

  it('separates two badges either side of what a grid would call a boundary', (t) => {
    const mod = loadAppModule(t, 'marker-spacing.ts', ['spaceMarkers']);
    if (!mod) return;
    // 45.5pt and 46.5pt: different cells of a 46pt grid, one point apart.
    const kept = mod.spaceMarkers([at('a', 45.5, 0), at('b', 46.5, 0)], view, 40);
    assert.deepEqual(kept.map((item) => item.id), ['a']);
  });

  it('always keeps the selected vehicle and keeps the input priority', (t) => {
    const mod = loadAppModule(t, 'marker-spacing.ts', ['spaceMarkers']);
    if (!mod) return;
    const kept = mod.spaceMarkers([at('a', 0, 0), at('sel', 5, 0)], view, 40, (item) => item.id === 'sel');
    assert.deepEqual(kept.map((item) => item.id), ['a', 'sel']);
  });
});

describe('classic marker spacing, app and Leaflet page', () => {
  /** The page's hand copy, lifted out of its template string and run. */
  function readPageFunction(name) {
    const source = fs.readFileSync(path.join(APP_LIB, 'map-html.ts'), 'utf8');
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name} not found in map-html.ts`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && (depth -= 1) === 0) {
        return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
      }
    }
    throw new assert.AssertionError({ message: `${name} is not a complete function` });
  }

  it('keeps the same badges on both surfaces', (t) => {
    const mod = loadAppModule(t, 'marker-spacing.ts', ['spaceMarkers']);
    if (!mod) return;
    const spacePoints = readPageFunction('spacePoints');
    // One point is 0.0001° in this view, so the two inputs describe one scene.
    const view = { latitudeDelta: 0.01, longitudeDelta: 0.01, width: 100, height: 100 };
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 400;
    const scene = Array.from({ length: 80 }, (_, index) => ({ id: String(index), x: random(), y: random() }));
    for (const keepIndex of [-1, 0]) {
      const app = mod
        .spaceMarkers(
          scene.map((point) => ({ id: point.id, lat: point.y * 0.0001, lon: point.x * 0.0001 })),
          view,
          40,
          (item) => keepIndex === 0 && item.id === '0',
        )
        .map((item) => item.id);
      const flags = spacePoints(scene, 40, keepIndex);
      const page = scene.filter((_, index) => flags[index]).map((point) => point.id);
      assert.deepEqual(page, app);
    }
  });
});

describe('incident notifications', () => {
  const NOW = 50_000_000;
  const HOUR = 60 * 60 * 1_000;
  const incident = (id, minutesAgo, affected = ['4'], status = 'active') => ({
    id,
    status,
    affected,
    firstSeenAt: NOW - minutesAgo * 60_000,
  });
  const load = (t) => loadAppModule(t, 'incident-alert-plan.ts', ['planIncidentAlerts']);
  const on = (mode = 'all', enabledAt = NOW - HOUR, seen = {}) => ({ mode, enabledAt, seen });

  it('announces nothing that started before it was switched on', (t) => {
    const mod = load(t);
    if (!mod) return;
    // The archive holds days of incidents; switching this on must not replay them.
    const history = Array.from({ length: 100 }, (_, index) => incident(`old${index}`, 120 + index));
    const plan = mod.planIncidentAlerts(history, on('all', NOW - 10 * 60_000), [], NOW);
    assert.equal(plan.separate.length, 0);
    assert.equal(plan.summarised, 0);
  });

  it('announces each new incident once', (t) => {
    const mod = load(t);
    if (!mod) return;
    const first = mod.planIncidentAlerts([incident('a', 5)], on(), [], NOW);
    assert.deepEqual(first.separate.map((item) => item.id), ['a']);
    const again = mod.planIncidentAlerts([incident('a', 5)], on('all', NOW - HOUR, first.seen), [], NOW + 60_000);
    assert.equal(again.separate.length, 0);
  });

  it('stays quiet when off, and on resolved or stale incidents', (t) => {
    const mod = load(t);
    if (!mod) return;
    assert.equal(mod.planIncidentAlerts([incident('a', 5)], { mode: 'off', enabledAt: NOW - HOUR, seen: {} }, [], NOW).separate.length, 0);
    assert.equal(mod.planIncidentAlerts([incident('a', 5, ['4'], 'resolved')], on(), [], NOW).separate.length, 0);
    // A background wake hours late must not announce this morning's news.
    assert.equal(mod.planIncidentAlerts([incident('a', 4 * 60)], on('all', NOW - 10 * HOUR), [], NOW).separate.length, 0);
  });

  it('keeps to the rider\'s lines in "mine", and remembers what it skipped', (t) => {
    const mod = load(t);
    if (!mod) return;
    const plan = mod.planIncidentAlerts([incident('a', 5, ['4']), incident('b', 5, ['145'])], on('mine'), ['145'], NOW);
    assert.deepEqual(plan.separate.map((item) => item.id), ['b']);
    // Widening to "all" later does not replay 'a': it is not new any more.
    const wider = mod.planIncidentAlerts([incident('a', 5, ['4'])], on('all', NOW - HOUR, plan.seen), [], NOW);
    assert.equal(wider.separate.length, 0);
  });

  it('reads "mine" with nothing selected as every line, the way the map does', (t) => {
    const mod = load(t);
    if (!mod) return;
    // An empty selection is the map showing everything. Read literally it
    // matched nothing, and the setting said "on" over total silence.
    const plan = mod.planIncidentAlerts([incident('a', 5, ['4']), incident('b', 5, ['145'])], on('mine'), [], NOW);
    assert.deepEqual(plan.separate.map((item) => item.id).sort(), ['a', 'b']);
  });

  it('folds a burst into one summary, newest shown separately', (t) => {
    const mod = load(t);
    if (!mod) return;
    const burst = ['a', 'b', 'c', 'd', 'e'].map((id, index) => incident(id, 10 - index));
    const plan = mod.planIncidentAlerts(burst, on(), [], NOW);
    assert.deepEqual(plan.separate.map((item) => item.id), ['e', 'd']);
    assert.equal(plan.summarised, 3);
  });

  it('forgets seen ids after their time', (t) => {
    const mod = load(t);
    if (!mod) return;
    const plan = mod.planIncidentAlerts([], on('all', NOW - HOUR, { old: NOW - 4 * 24 * HOUR, recent: NOW - HOUR }), [], NOW);
    assert.deepEqual(Object.keys(plan.seen), ['recent']);
  });
});

describe('departure on time', () => {
  const load = (t) => loadAppModule(t, 'departures.ts', ['departureOnTime']);
  const departure = (inSeconds, predictedInSeconds, realtime = true) => ({ inSeconds, predictedInSeconds, realtime });

  it('is on time within formatDelay\'s "Punktualnie" window', (t) => {
    const mod = load(t);
    if (!mod) return;
    assert.equal(mod.departureOnTime(departure(600, 600)), true);
    assert.equal(mod.departureOnTime(departure(600, 600 + 89)), true);
    assert.equal(mod.departureOnTime(departure(600, 600 - 89)), true);
    // 90 s rounds to two minutes: "2 min spóźnienia", not on time.
    assert.equal(mod.departureOnTime(departure(600, 600 + 90)), false);
    assert.equal(mod.departureOnTime(departure(600, 600 - 150)), false);
  });

  it('never calls a timetable-only departure on time', (t) => {
    const mod = load(t);
    if (!mod) return;
    // No prediction is no evidence: the countdown stays amber.
    assert.equal(mod.departureOnTime(departure(600, 600, false)), false);
    assert.equal(mod.departureOnTime(departure(600, null)), false);
    assert.equal(mod.departureOnTime(departure(600, undefined)), false);
  });
});
