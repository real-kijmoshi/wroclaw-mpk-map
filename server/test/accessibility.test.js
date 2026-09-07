'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { buildFixtureZip } = require('./fixtures/gtfs');

/**
 * Whether a stop can be boarded from a wheelchair, and whether the run that
 * calls there can be, are two different facts and both are optional in GTFS.
 * The rule these tests pin is that "the publisher did not say" survives all
 * the way to the client as `null` — printing it as "no" would tell a
 * wheelchair user a usable stop is unusable, on the strength of a blank cell.
 */
describe('accessibility', () => {
  describe('when the feed carries the columns', () => {
    const store = new GtfsStore();

    before(async () => {
      await store.build(buildFixtureZip({ accessibility: true }));
    });

    it('reads a stop as yes, no, or unstated', () => {
      assert.equal(store.getStop('1').wheelchairBoarding, true, '1 = accessible');
      assert.equal(store.getStop('3').wheelchairBoarding, false, '2 = not accessible');
      assert.equal(store.getStop('4').wheelchairBoarding, null, '0 = the column says nothing');
      assert.equal(store.getStop('5').wheelchairBoarding, null, 'an empty cell says nothing either');
    });

    it('carries the run’s own accessibility onto its departures', () => {
      const departures = store.getDepartures('1', {
        now: new Date('2026-06-15T07:00:00+02:00'),
        limit: 5,
      });

      const lowFloor = departures.find((departure) => departure.tripId === 't4a');
      assert.equal(lowFloor.wheelchair, true);

      // t4a2 runs the same shape and is not marked, so it stays unknown —
      // accessibility is a property of the vehicle rostered to the run, not
      // of the route it happens to be running.
      const unstated = departures.find((departure) => departure.tripId === 't4a2');
      assert.equal(unstated.wheelchair, null);
    });
  });

  describe('when the feed omits them', () => {
    const store = new GtfsStore();

    before(async () => {
      await store.build(buildFixtureZip());
    });

    it('says nothing rather than saying no', () => {
      // Wrocław's snapshots have shipped both with and without these columns.
      // A missing column must not flip every stop in the city to "step access".
      for (const id of ['1', '2', '3', '4', '5']) {
        assert.equal(store.getStop(id).wheelchairBoarding, null);
      }
      const [first] = store.getDepartures('1', {
        now: new Date('2026-06-15T07:00:00+02:00'),
        limit: 1,
      });
      assert.equal(first.wheelchair, null);
    });
  });
});
