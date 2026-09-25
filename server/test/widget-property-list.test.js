'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { describe, it } = require('node:test');

const APP_PROPERTY_LIST = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'property-list.ts');

/**
 * The app's `toPropertyList()`, run rather than read.
 *
 * A widget timeline lives in UserDefaults, which stores property lists only.
 * Expo hands a JS `null` over as `NSNull`, and a single one — a stop with no
 * label, a walk too far to estimate — made iOS refuse the whole timeline: the
 * widget said "star a stop" with five starred and its picker never loaded.
 */
function loadToPropertyList() {
  const source = stripTypeScriptTypes(fs.readFileSync(APP_PROPERTY_LIST, 'utf8'))
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  return new Function(`${source}; return toPropertyList;`)();
}

/** True when `value` has a property-list form: no null, no undefined, no NaN anywhere. */
function isPropertyList(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isPropertyList);
  if (typeof value === 'object') return Object.values(value).every(isPropertyList);
  return false;
}

describe('widget props as a property list', () => {
  const toPropertyList = loadToPropertyList();

  it('drops every null the widget props carry', () => {
    const props = {
      stops: [
        {
          kind: 'stop',
          id: '123',
          name: 'Spółdzielcza',
          label: null,
          detail: '→ Oporów',
          url: 'wroclive://open?stop=123',
          walk: null,
          destination: undefined,
          rows: [{ line: '2', at: 1, live: false, arriveAt: null, arriveClock: null }],
        },
      ],
      favourites: [{ id: '123', name: 'Spółdzielcza', detail: '' }],
      updatedAt: 1,
      final: false,
    };
    const result = toPropertyList(props);
    assert.ok(isPropertyList(result));
    assert.equal('label' in result.stops[0], false);
    assert.equal('walk' in result.stops[0], false);
    assert.equal('arriveAt' in result.stops[0].rows[0], false);
  });

  it('keeps what is set, falsy values included', () => {
    const row = { line: '4', live: false, at: 0, headsign: '', walk: 0, arriveClock: '07:54' };
    assert.deepEqual(toPropertyList(row), row);
    assert.deepEqual(toPropertyList({ list: [1, null, 2] }), { list: [1, 2] });
    assert.deepEqual(toPropertyList({ bad: Number.NaN, fine: 3 }), { fine: 3 });
  });
});
