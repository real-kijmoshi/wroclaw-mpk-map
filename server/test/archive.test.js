'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { isInForce, readEffectiveWindow, serviceDayKey } = require('../src/gtfs/archive');
const { buildFixtureZip } = require('./fixtures/gtfs');

describe('readEffectiveWindow', () => {
  it('prefers the dates the feed states outright', () => {
    const zip = buildFixtureZip({ feedDates: { start: '20260725', end: '20260731' } });
    assert.deepEqual(readEffectiveWindow(zip), { start: '20260725', end: '20260731' });
  });

  it('falls back to the span of calendar.txt', () => {
    // The fixture's calendar runs 20200101–20401231.
    assert.deepEqual(readEffectiveWindow(buildFixtureZip()), {
      start: '20200101',
      end: '20401231',
    });
  });

  it('returns null when the archive says nothing about dates', () => {
    assert.equal(readEffectiveWindow(buildFixtureZip({ omit: ['calendar'] })), null);
  });

  it('reads through a nested archive too', () => {
    const zip = buildFixtureZip({ prefix: 'GTFS/', feedDates: { start: '20260101', end: '20260201' } });
    assert.deepEqual(readEffectiveWindow(zip), { start: '20260101', end: '20260201' });
  });
});

describe('isInForce', () => {
  // This is what stops a future-dated snapshot being served early when the
  // candidates arrive without names to sort by.
  const august = buildFixtureZip({ feedDates: { start: '20260801', end: '20260831' } });
  const july = buildFixtureZip({ feedDates: { start: '20260725', end: '20260731' } });

  it('rejects a snapshot that has not taken effect yet', () => {
    assert.equal(isInForce(august, new Date('2026-07-31T12:00:00+02:00')), false);
    assert.equal(isInForce(july, new Date('2026-07-31T12:00:00+02:00')), true);
  });

  it('rolls over on the day it takes effect', () => {
    assert.equal(isInForce(august, new Date('2026-08-01T00:30:00+02:00')), true);
    assert.equal(isInForce(july, new Date('2026-08-01T00:30:00+02:00')), false);
  });

  it('accepts an archive that declares no dates rather than rejecting everything', () => {
    assert.equal(isInForce(buildFixtureZip({ omit: ['calendar'] })), true);
  });
});

describe('serviceDayKey', () => {
  it('uses the Warsaw day, not UTC', () => {
    // 23:30 UTC is already the next day in Warsaw.
    assert.equal(serviceDayKey(new Date('2026-07-31T23:30:00Z')), '20260801');
  });
});
