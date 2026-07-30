'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { categorizeLines, compareLines, lineToType } = require('../src/lines');

describe('lineToType', () => {
  it('classifies regular trams', () => {
    assert.equal(lineToType('4'), 'tram');
    assert.equal(lineToType('0'), 'tram');
    assert.equal(lineToType('33'), 'tram');
  });

  it('classifies buses by number range', () => {
    assert.equal(lineToType('128'), 'bus');
    assert.equal(lineToType('240'), 'busNight');
    assert.equal(lineToType('612'), 'busSuburban');
    assert.equal(lineToType('714'), 'busTemporary');
    assert.equal(lineToType('920'), 'busZone');
  });

  it('classifies express and substitute lines', () => {
    assert.equal(lineToType('A'), 'busExpress');
    assert.equal(lineToType('n'), 'busExpress', 'express letters are case insensitive');
    assert.equal(lineToType('B4'), 'busSpecial');
  });

  it('classifies temporary trams', () => {
    assert.equal(lineToType('74'), 'tramSpecial', 'historic line 74 is a sightseeing tram');
    assert.equal(lineToType('79'), 'tramTemporary');
    assert.equal(lineToType('T2'), 'tramTemporary');
  });

  it('never throws on junk input', () => {
    assert.equal(lineToType(undefined), 'unknown');
    assert.equal(lineToType(null), 'unknown');
    assert.equal(lineToType(42), 'unknown');
    assert.equal(lineToType(''), 'unknown');
    assert.equal(lineToType('   '), 'unknown');
  });
});

describe('categorizeLines', () => {
  it('groups lines and builds the tram/bus unions', () => {
    const result = categorizeLines(['4', '128', '240', 'A', 'B4', '612']);

    assert.deepEqual(result.tram, ['4']);
    assert.deepEqual(result.bus, ['128']);
    assert.deepEqual(result.busNight, ['240']);
    assert.deepEqual(result.allTrams, ['4']);
    assert.deepEqual(result.allBuses, ['128', '240', '612', 'A', 'B4']);
  });

  it('drops duplicates and blank entries', () => {
    const result = categorizeLines(['4', '4', ' ', '', null, '4 ']);
    assert.deepEqual(result.tram, ['4']);
  });

  it('sorts numerically, not lexicographically', () => {
    const result = categorizeLines(['33', '4', '10', 'A']);
    assert.deepEqual(result.allTrams, ['4', '10', '33']);
  });

  it('keeps unknown labels out of the tram and bus unions', () => {
    const result = categorizeLines(['???']);
    assert.deepEqual(result.unknown, ['???']);
    assert.deepEqual(result.allBuses, []);
    assert.deepEqual(result.allTrams, []);
  });
});

describe('compareLines', () => {
  it('puts numbers before letters', () => {
    assert.deepEqual(['A', '10', '2'].sort(compareLines), ['2', '10', 'A']);
  });
});
