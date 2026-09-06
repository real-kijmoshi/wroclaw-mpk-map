'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  FleetRoster,
  UNKNOWN,
  loadRoster,
  normaliseNumber,
  validateEntry,
} = require('../src/fleet');

const BUNDLED = path.join(__dirname, '..', 'src', 'fleet-roster.json');

/** A roster built straight from entry literals, bypassing the file. */
const rosterOf = (...raw) =>
  new FleetRoster({
    entries: raw.map((row, index) => {
      const { entry, error } = validateEntry(row, index);
      assert.equal(error, undefined, `fixture entry ${index}: ${error}`);
      return entry;
    }),
  });

const writeRoster = (payload) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-roster-'));
  const file = path.join(dir, 'roster.json');
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return file;
};

describe('fleet roster', () => {
  it('resolves a side number inside a declared range', () => {
    const roster = rosterOf({
      kind: 'tram',
      from: 2901,
      to: 2940,
      model: 'Moderus Beta MF 24 AC',
      lowFloor: 'partial',
      wheelchair: true,
      airConditioning: true,
    });

    const found = roster.describe(2915, 'tram');
    assert.equal(found.model, 'Moderus Beta MF 24 AC');
    assert.equal(found.lowFloor, 'partial');
    assert.equal(found.wheelchair, true);
    assert.equal(found.airConditioning, true);
  });

  it('matches the ends of a range and nothing past them', () => {
    const roster = rosterOf({ kind: 'tram', from: 3001, to: 3017, model: 'Škoda 16T' });

    assert.equal(roster.describe(3001, 'tram').model, 'Škoda 16T');
    assert.equal(roster.describe(3017, 'tram').model, 'Škoda 16T');
    assert.equal(roster.describe(3000, 'tram'), UNKNOWN);
    assert.equal(roster.describe(3018, 'tram'), UNKNOWN);
  });

  /**
   * Tram and bus side numbers are separate series, so nothing stops them from
   * colliding. Answering "Škoda 16T" for bus 3005 is the kind of confident
   * wrong answer this module exists to avoid.
   */
  it('never resolves a bus against a tram range', () => {
    const roster = rosterOf({ kind: 'tram', from: 3001, to: 3017, model: 'Škoda 16T' });

    assert.equal(roster.describe(3005, 'bus'), UNKNOWN);
    assert.equal(roster.describe(3005, 'night-bus'), UNKNOWN);
    assert.equal(roster.describe(3005, 'tram'), roster.describe(3005, 'tram-night'));
  });

  /**
   * The tracker spells the line's category finely — `night-bus`, `express-bus`,
   * `suburban-bus` are all buses wearing bus numbers, and a roster keyed on
   * "bus" has to answer for all of them.
   */
  it('reads every bus category as a bus', () => {
    const roster = rosterOf({ kind: 'bus', from: 8001, to: 8010, model: 'Volvo 7900A' });

    for (const type of ['bus', 'night-bus', 'express-bus', 'suburban-bus', 'unknown']) {
      assert.equal(roster.describe(8005, type).model, 'Volvo 7900A', type);
    }
  });

  it('answers UNKNOWN for a vehicle with no usable side number', () => {
    const roster = rosterOf({ kind: 'tram', from: 3001, to: 3017, model: 'Škoda 16T' });

    // MPK's own bus_position feed carries no side number at all until an Open
    // Data record is merged in, so this is the common case, not an edge one.
    for (const value of [null, undefined, '', '  ', 'ABC', '30-05', Number.NaN]) {
      assert.equal(roster.describe(value, 'tram'), UNKNOWN, String(value));
    }
  });

  it('accepts a side number as text or as a number', () => {
    const roster = rosterOf({ kind: 'tram', numbers: [3401, 3402], model: 'Pesa Twist 2010NW' });

    assert.equal(roster.describe('3401', 'tram').model, 'Pesa Twist 2010NW');
    assert.equal(roster.describe(3402, 'tram').model, 'Pesa Twist 2010NW');
    assert.equal(normaliseNumber(' 3401 '), 3401);
    assert.equal(normaliseNumber('34a'), null);
  });

  /**
   * The attribute object is handed to every vehicle of a model on every poll —
   * several hundred vehicles, six times a minute — so it has to be the same
   * frozen object each time rather than a fresh allocation.
   */
  it('interns one frozen attribute object per model', () => {
    const roster = rosterOf({ kind: 'tram', from: 2801, to: 2822, model: 'Moderus Beta MF 19 AC' });

    const first = roster.describe(2801, 'tram');
    const second = roster.describe(2822, 'tram');
    assert.equal(first, second);
    assert.equal(Object.isFrozen(first), true);
  });

  /**
   * "The feed does not say" and "the feed says no" send a rider to two
   * different places, so an attribute the roster omits stays null instead of
   * collapsing to false.
   */
  it('keeps an unstated attribute null rather than false', () => {
    const roster = rosterOf({ kind: 'tram', from: 3001, to: 3017, model: 'Škoda 16T' });

    const found = roster.describe(3010, 'tram');
    assert.equal(found.airConditioning, null);
    assert.equal(found.wheelchair, null);
    assert.equal(found.lowFloor, null);
  });

  it('drops a nonsense value instead of serving it', () => {
    const roster = rosterOf({
      kind: 'tram',
      from: 3001,
      to: 3017,
      model: 'Škoda 16T',
      lowFloor: 'sort of',
      wheelchair: 'tak',
      airConditioning: 1,
    });

    const found = roster.describe(3010, 'tram');
    assert.equal(found.lowFloor, null);
    assert.equal(found.wheelchair, null);
    assert.equal(found.airConditioning, null);
  });
});

describe('fleet roster loading', () => {
  it('reads the bundled roster and every entry in it is valid', () => {
    const roster = loadRoster();

    assert.equal(roster.warnings.length, 0, roster.warnings.join('; '));
    assert.ok(roster.size > 0);
    assert.equal(roster.isEmpty, false);

    // Pinned so a roster edit that guts the file is a test failure rather than
    // a map that quietly stops saying what anything is.
    const payload = JSON.parse(fs.readFileSync(BUNDLED, 'utf8'));
    for (const entry of payload.entries) {
      assert.ok(entry.model, 'every entry names a model');
      assert.ok(['tram', 'bus'].includes(entry.kind), `${entry.model} has a kind`);
      // An entry that states equipment without saying where that was checked
      // is exactly the unsourced guess this file must not accumulate.
      const states =
        entry.lowFloor != null || entry.wheelchair != null || entry.airConditioning != null;
      if (states) assert.ok(entry.source, `${entry.model} states equipment without a source`);
    }
  });

  it('keeps the good entries when one is malformed', () => {
    const file = writeRoster({
      entries: [
        { kind: 'tram', from: 3001, to: 3017, model: 'Škoda 16T' },
        { kind: 'tram', model: 'no numbers at all' },
        { kind: 'boat', from: 1, to: 2, model: 'Wrong kind' },
        { kind: 'bus', numbers: [8001], model: 'Volvo 7900A' },
      ],
    });

    const roster = loadRoster(file);
    assert.equal(roster.size, 2);
    assert.equal(roster.warnings.length, 2);
    assert.equal(roster.describe(3005, 'tram').model, 'Škoda 16T');
    assert.equal(roster.describe(8001, 'bus').model, 'Volvo 7900A');
  });

  /**
   * A roster is a nicety on top of a working map; none of the ways an operator
   * can get the file wrong is worth refusing to serve positions over.
   */
  it('fails soft on a missing or unreadable file', () => {
    for (const file of [
      path.join(os.tmpdir(), 'no-such-fleet-roster.json'),
      writeRoster('{ not json'),
      writeRoster({ entries: 'nope' }),
    ]) {
      const roster = loadRoster(file);
      assert.equal(roster.isEmpty, true);
      assert.ok(roster.warnings.length > 0);
      assert.equal(roster.describe(3005, 'tram'), UNKNOWN);
    }
  });

  /**
   * An operator who names their own roster runs their own fleet. Falling back
   * to Wrocław's models for their side numbers would state the wrong vehicle
   * as fact, which is worse than stating nothing.
   */
  it('does not fall back to the bundled roster when a file was named', () => {
    const roster = loadRoster(writeRoster({ entries: [] }));

    assert.equal(roster.describe(3005, 'tram'), UNKNOWN);
    assert.equal(roster.describe(2915, 'tram'), UNKNOWN);
  });
});
