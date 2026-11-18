'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const APP_TIMELINE = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'widget-timeline.ts');

/**
 * The widget's timeline used to end in one entry half an hour after the app
 * last wrote it, and WidgetKit hands a layout the entry's date as "now". So
 * that entry stayed up indefinitely: at 18:33 the widget still listed the
 * 08:08–08:14 trams from a 07:38 refresh, two of them in amber as if they
 * could still be caught.
 */
function load(t) {
  if (typeof stripTypeScriptTypes !== 'function') {
    t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
    return null;
  }
  const source = stripTypeScriptTypes(fs.readFileSync(APP_TIMELINE, 'utf8')).replace(/^export /gm, '');
  return new Function(`${source}; return { timelineSlots, listedAt, departedAt, withinBudget, COUNTDOWN_MINUTES, MAX_TIMELINE_ENTRIES };`)();
}

const MINUTE = 60_000;
// 2026-11-17 07:38:20 Europe/Warsaw, as an epoch: only the arithmetic matters.
const NOW = Date.UTC(2026, 10, 17, 6, 38, 20);
const START = Math.floor(NOW / MINUTE) * MINUTE;

/** The rows an entry would carry, as `syncDeparturesWidget()` builds them. */
function rowsAt(mod, slot, departures) {
  return slot.expired ? [] : departures.filter((at) => mod.listedAt(at, slot.date));
}

describe('widget timeline', () => {
  it('counts down once a minute for the first half hour', (t) => {
    const mod = load(t);
    if (!mod) return;
    const slots = mod.timelineSlots(NOW, [NOW + 5 * MINUTE, NOW + 90 * MINUTE]);
    const countdown = slots.filter((slot) => !slot.final);
    assert.equal(countdown.length, mod.COUNTDOWN_MINUTES);
    countdown.forEach((slot, minute) => assert.equal(slot.date, START + minute * MINUTE));
  });

  it('never ends on an entry that lists a departure', (t) => {
    const mod = load(t);
    if (!mod) return;
    // The 07:38 board: a tram every few minutes for the next two hours.
    const departures = Array.from({ length: 30 }, (_, index) => NOW + (index * 4 + 2) * MINUTE);
    const slots = mod.timelineSlots(NOW, departures);
    const last = slots[slots.length - 1];
    assert.equal(last.expired, true);
    assert.deepEqual(rowsAt(mod, last, departures), []);
    // And only the last one is expired.
    assert.equal(slots.filter((slot) => slot.expired).length, 1);
  });

  it('lists nothing in any entry after it has left', (t) => {
    const mod = load(t);
    if (!mod) return;
    const departures = Array.from({ length: 30 }, (_, index) => NOW + (index * 7 + 1) * MINUTE + 13_000);
    const slots = mod.timelineSlots(NOW, departures);
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const rows = rowsAt(mod, slot, departures);
      const next = slots[index + 1];
      if (!next) {
        assert.deepEqual(rows, []);
        continue;
      }
      // Shown until the next entry takes over: nothing listed may have left
      // by then by more than a minute and a half.
      for (const at of rows) assert.ok(at >= next.date - 90_000, `row ${at} stays up past its departure`);
    }
  });

  it('follows the board past the half hour, one entry per departure', (t) => {
    const mod = load(t);
    if (!mod) return;
    const departures = [NOW + 45 * MINUTE, NOW + 70 * MINUTE, NOW + 120 * MINUTE];
    const slots = mod.timelineSlots(NOW, departures);
    const later = slots.filter((slot) => slot.date > START + mod.COUNTDOWN_MINUTES * MINUTE);
    assert.deepEqual(later.map((slot) => slot.date), departures.map(mod.departedAt));
    assert.ok(later.every((slot) => slot.final));
    // The 120-minute tram is listed until it leaves.
    const before = slots.filter((slot) => slot.date < mod.departedAt(NOW + 120 * MINUTE)).at(-1);
    assert.ok(rowsAt(mod, before, departures).includes(NOW + 120 * MINUTE));
  });

  it('stays within its entry budget, and stops where it can no longer follow', (t) => {
    const mod = load(t);
    if (!mod) return;
    // A dozen starred stops, thirty departures each, all at different minutes.
    const departures = Array.from({ length: 360 }, (_, index) => NOW + (31 + index) * MINUTE);
    const slots = mod.timelineSlots(NOW, departures);
    assert.ok(slots.length <= mod.MAX_TIMELINE_ENTRIES);
    const last = slots.at(-1);
    assert.equal(last.expired, true);
    // Up to its last entry, nothing listed has left.
    const previous = slots.at(-2);
    assert.ok(rowsAt(mod, previous, departures).every((at) => at >= last.date - 90_000));
  });

  it('ends at minute thirty when nothing runs past it', (t) => {
    const mod = load(t);
    if (!mod) return;
    for (const departures of [[], [NOW + 3 * MINUTE]]) {
      const slots = mod.timelineSlots(NOW, departures);
      assert.equal(slots.length, mod.COUNTDOWN_MINUTES + 1);
      assert.equal(slots.at(-1).date, START + mod.COUNTDOWN_MINUTES * MINUTE);
      assert.equal(slots.at(-1).expired, true);
    }
  });

  it('lasts the evening on a long board — the 19:06 widget that said "odśwież"', (t) => {
    const mod = load(t);
    if (!mod) return;
    // 16:25, a tram every four minutes for the next twelve hours.
    const departures = Array.from({ length: 160 }, (_, index) => NOW + (index * 4 + 2) * MINUTE);
    const slots = mod.timelineSlots(NOW, departures);
    const lastListing = slots.filter((slot) => !slot.expired).at(-1);
    // Still listing departures two and a half hours on, not "odśwież".
    assert.ok(lastListing.date >= NOW + 150 * MINUTE);
    assert.equal(slots.at(-1).expired, true);
  });

  it('cuts to its byte budget and still ends on an expired entry', (t) => {
    const mod = load(t);
    if (!mod) return;
    const departures = Array.from({ length: 300 }, (_, index) => NOW + (31 + index) * MINUTE);
    const slots = mod.timelineSlots(NOW, departures);
    const cut = mod.withinBudget(slots, () => 1_000, 50_000);
    // Fifty entries fit; the fifty-first is the one that says "odśwież".
    assert.equal(cut.length, 51);
    assert.equal(cut.at(-1).expired, true);
    assert.equal(cut.filter((slot) => slot.expired).length, 1);
    // The cut entry takes over exactly where the kept ones stop being true.
    assert.equal(cut.at(-1).date, slots[50].date);
    // Under budget, nothing changes.
    assert.deepEqual(mod.withinBudget(slots, () => 1, 1e9), slots);
    // The countdown half hour survives any budget.
    assert.ok(mod.withinBudget(slots, () => 1_000, 1).length > mod.COUNTDOWN_MINUTES);
  });
});
