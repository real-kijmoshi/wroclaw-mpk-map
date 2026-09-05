import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  etaParts,
  formatAge,
  formatDelay,
  formatDistance,
  formatScheduled,
  plural,
} from '../src/lib/format.ts';

const POJAZD: [string, string, string] = ['pojazd', 'pojazdy', 'pojazdów'];

describe('plural', () => {
  // Polish has three forms and picking the wrong one reads as broken software.
  // The teens are the trap: 22 takes the "few" form but 12 does not.
  it('uses the singular only for exactly one', () => {
    assert.equal(plural(1, POJAZD), 'pojazd');
    assert.equal(plural(0, POJAZD), 'pojazdów');
  });

  it('uses the few form for 2-4', () => {
    for (const n of [2, 3, 4]) assert.equal(plural(n, POJAZD), 'pojazdy');
  });

  it('uses the many form for 5-21', () => {
    for (const n of [5, 9, 10, 11, 21]) assert.equal(plural(n, POJAZD), 'pojazdów');
  });

  it('keeps the teens on the many form', () => {
    // 12-14 are the exception to the units rule; 112-114 inherit it.
    for (const n of [12, 13, 14, 112, 113, 114]) {
      assert.equal(plural(n, POJAZD), 'pojazdów', `${n}`);
    }
  });

  it('returns to the few form above the teens', () => {
    for (const n of [22, 23, 24, 102, 122]) assert.equal(plural(n, POJAZD), 'pojazdy', `${n}`);
  });
});

describe('etaParts', () => {
  it('says "teraz" under half a minute', () => {
    assert.deepEqual(etaParts(0), { value: 'teraz', unit: '' });
    assert.deepEqual(etaParts(29), { value: 'teraz', unit: '' });
  });

  it('never rounds a real wait down to zero minutes', () => {
    assert.deepEqual(etaParts(30), { value: '1', unit: 'min' });
  });

  it('switches to hours past an hour', () => {
    assert.deepEqual(etaParts(60 * 60), { value: '1:00', unit: 'h' });
    assert.deepEqual(etaParts(95 * 60), { value: '1:35', unit: 'h' });
  });

  it('has a dash for a number it does not have', () => {
    for (const value of [null, undefined, Number.NaN, Infinity]) {
      assert.deepEqual(etaParts(value as number), { value: '—', unit: '' });
    }
  });
});

describe('formatDelay', () => {
  it('says the server has no schedule rather than inventing one', () => {
    // The server reports null when it cannot identify the run; the app must
    // not turn that into a plausible-looking "0 min".
    assert.deepEqual(formatDelay(null), { text: 'Brak rozkładu', tone: 'unknown' });
    assert.deepEqual(formatDelay(undefined), { text: 'Brak rozkładu', tone: 'unknown' });
  });

  it('treats under two rounded minutes either way as on time', () => {
    for (const seconds of [-89, 0, 89]) {
      assert.equal(formatDelay(seconds).tone, 'onTime', `${seconds}s`);
    }
  });

  it('turns late exactly where the minute rounds to two', () => {
    // 89s rounds to 1 minute and reads as punctual; 90s rounds to 2 and does
    // not. Pinned because the threshold is on the rounded minutes, not the
    // seconds, and moving one without the other is an easy slip.
    assert.equal(formatDelay(89).tone, 'onTime');
    assert.equal(formatDelay(90).tone, 'late');
  });

  it('turns early a second later than it turns late', () => {
    // Not symmetric, and deliberately pinned so nobody "fixes" it by accident:
    // Math.round breaks .5 toward +Infinity, so -90s rounds to -1 (punctual)
    // where +90s rounds to 2 (late). The gap is one second at a two-minute
    // threshold — invisible to a rider, and not worth special-casing.
    assert.equal(formatDelay(-90).tone, 'onTime');
    assert.equal(formatDelay(-91).tone, 'early');
  });

  it('names late and early separately', () => {
    assert.deepEqual(formatDelay(300), { text: '5 min spóźnienia', tone: 'late' });
    assert.deepEqual(formatDelay(-300), { text: '5 min przed czasem', tone: 'early' });
  });
});

describe('formatScheduled', () => {
  it('drops the seconds', () => {
    assert.equal(formatScheduled('23:11:00'), '23:11');
  });

  it('wraps GTFS hours past midnight', () => {
    // A trip that began yesterday is timetabled as 25:04; a rider reads 01:04.
    assert.equal(formatScheduled('25:04:00'), '01:04');
    assert.equal(formatScheduled('24:00:00'), '00:00');
  });

  it('is null for anything that is not a time', () => {
    for (const value of [null, undefined, '', 'wkrótce']) {
      assert.equal(formatScheduled(value), null);
    }
  });
});

describe('formatDistance', () => {
  it('rounds metres to ten below a kilometre', () => {
    assert.equal(formatDistance(124), '120 m');
    assert.equal(formatDistance(999), '1000 m');
  });

  it('uses a Polish decimal comma above a kilometre', () => {
    assert.equal(formatDistance(1500), '1,5 km');
  });

  it('is null when there is no distance', () => {
    assert.equal(formatDistance(null), null);
    assert.equal(formatDistance(Number.NaN), null);
  });
});

describe('formatAge', () => {
  it('reads a fresh timestamp as "przed chwilą"', () => {
    assert.equal(formatAge(Date.now() - 5_000), 'przed chwilą');
  });

  it('counts minutes, then hours, then days', () => {
    assert.equal(formatAge(Date.now() - 5 * 60_000), '5 min temu');
    assert.equal(formatAge(Date.now() - 3 * 3_600_000), '3 godz. temu');
    assert.equal(formatAge(Date.now() - 25 * 3_600_000), 'wczoraj');
    assert.equal(formatAge(Date.now() - 3 * 86_400_000), '3 dni temu');
  });

  it('accepts an ISO string as well as a number', () => {
    assert.equal(formatAge(new Date(Date.now() - 5_000).toISOString()), 'przed chwilą');
  });

  it('is empty rather than "NaN temu" for junk', () => {
    assert.equal(formatAge(null), '');
    assert.equal(formatAge('nigdy'), '');
  });
});
