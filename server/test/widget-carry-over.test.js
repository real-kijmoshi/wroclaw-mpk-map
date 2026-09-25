'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const APP_CARRY_OVER = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'widget-carry-over.ts');

/**
 * The app's `carryOverRows()`, run rather than read.
 *
 * A refresh whose fetch failed used to hand the widget an empty board, so a
 * terminus with a tram every few minutes read "Brak danych o odjazdach" until
 * the next refresh, hours later.
 */
function load(t) {
  if (typeof stripTypeScriptTypes !== 'function') {
    t.skip('this Node cannot strip TypeScript types (needs 22.13+)');
    return null;
  }
  const source = stripTypeScriptTypes(fs.readFileSync(APP_CARRY_OVER, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(`${source}; return carryOverRows;`)();
}

const now = 1_800_000_000_000;
const row = (line, minutes) => ({ line, at: now + minutes * 60_000 });
// Two entries of an earlier timeline: each carries only the rows still to come at its minute.
const previous = [
  { props: { stops: [{ id: '1231', rows: [row('2', -5), row('4', 1), row('2', 6)] }, { id: '99', rows: [row('9', 3)] }] } },
  { props: { stops: [{ id: '1231', rows: [row('4', 1), row('2', 6), row('4', 11)] }] } },
];

describe('widget carry-over', () => {
  it('keeps the rows a missing board already had, merged across entries, departed ones dropped', (t) => {
    const carryOverRows = load(t);
    if (!carryOverRows) return;
    const carried = carryOverRows(['1231'], previous, now);
    assert.deepEqual(carried.get('1231'), [row('4', 1), row('2', 6), row('4', 11)]);
    assert.equal(carried.has('99'), false, 'only the stops asked for');
  });

  it('carries nothing for a stop the old timeline did not have, or had nothing left for', (t) => {
    const carryOverRows = load(t);
    if (!carryOverRows) return;
    assert.equal(carryOverRows(['new'], previous, now).size, 0);
    assert.equal(carryOverRows(['1231'], previous, now + 60 * 60_000).size, 0);
    assert.equal(carryOverRows(['1231'], [], now).size, 0);
  });
});
