'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { StatsTracker, dayKey, hourOf } = require('../src/stats');
const DEFAULTS = require('../src/config.defaults.json');

/**
 * What N map polls are worth in client-hours, at whatever the client poll
 * interval currently is. Written as the conversion rather than the fraction it
 * happens to produce today: the interval tracks the app's own vehicle poll and
 * is expected to be retuned, and these tests are about the counting, not about
 * that number. The number itself is pinned once, against the app, below.
 */
const hoursFor = (polls) => (polls * DEFAULTS.stats.clientPollIntervalMs) / 3_600_000;

// A stable day boundary: these UTC instants all fall inside Europe/Warsaw day
// (2026-08-0N) because Warsaw is UTC+2 in August.
const atDay = (day, hour = 12) => new Date(`2026-08-0${day}T${String(hour).padStart(2, '0')}:00:00Z`);

const fakeReq = (routePath, query = {}) => ({ route: { path: routePath }, query });

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-')), 'stats.json');

describe('StatsTracker', () => {
  it('counts requests, map polls and endpoint buckets without identifiers', () => {
    const now = () => atDay(7);
    const stats = new StatsTracker({ now });

    for (let poll = 0; poll < 6; poll += 1) {
      stats.record({ ...fakeReq('/locations', { format: 'map' }), ip: `10.0.0.${poll}` });
    }
    stats.record(fakeReq('/vehicle/4-1'));

    const snapshot = stats.snapshot();
    assert.equal(snapshot.activeClientHoursToday, hoursFor(6));
    assert.equal(snapshot.requestsToday, 7);
    assert.deepEqual(snapshot.topEndpointsToday, [
      { endpoint: '/locations', count: 6 },
      { endpoint: '/vehicle/4-1', count: 1 },
    ]);
    assert.equal(snapshot.today, '2026-08-07');
    assert.equal('dau' in snapshot, false);
  });

  it('groups requests that share a route pattern into one bucket', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record(fakeReq('/vehicle/:id'));
    stats.record(fakeReq('/vehicle/:id'));

    const snapshot = stats.snapshot();
    assert.deepEqual(snapshot.topEndpointsToday, [{ endpoint: '/vehicle/:id', count: 2 }]);
  });

  it('does not treat a plain browser fleet request as app activity', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record(fakeReq('/locations'));
    assert.equal(stats.snapshot().activeClientHoursToday, 0);
    assert.equal(stats.snapshot().requestsToday, 1);
  });

  it('computes active client-hours across calendar days', () => {
    let current;
    const now = () => current;
    const stats = new StatsTracker({ now });

    current = atDay(1);
    for (let poll = 0; poll < 6; poll += 1) stats.record(fakeReq('/locations', { format: 'map' }));

    current = atDay(2);
    for (let poll = 0; poll < 12; poll += 1) stats.record(fakeReq('/locations', { format: 'map' }));

    const snapshot = stats.snapshot();
    assert.equal(snapshot.today, '2026-08-02');
    assert.equal(snapshot.activeClientHoursToday, hoursFor(12));
    assert.equal(snapshot.activeClientHours7d, hoursFor(18));
    assert.equal(snapshot.activeClientHours30d, hoursFor(18));
    assert.equal(snapshot.requestsToday, 12);
    assert.equal(snapshot.requests7d, 18);
    assert.equal(snapshot.requests30d, 18);
  });

  it('keeps only the configured number of days', () => {
    let current;
    const now = () => current;
    const stats = new StatsTracker({ now, daysToKeep: 3 });

    for (let day = 1; day <= 5; day += 1) {
      current = atDay(day);
      stats.record(fakeReq('/locations', { format: 'map' }));
    }

    const snapshot = stats.snapshot();
    assert.equal(stats.days.size, 3);
    assert.equal(snapshot.activeClientHoursToday, hoursFor(1), 'only day 5 is today');
    assert.equal(snapshot.activeClientHours30d, hoursFor(3), 'the two pruned days no longer count');
    assert.equal(snapshot.daily.length, 3);
    assert.deepEqual(snapshot.daily[0].date, '2026-08-03');
  });

  it('ignores health, browser and admin traffic', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record(fakeReq('/health'));
    stats.record(fakeReq('/status'));
    stats.record(fakeReq('/map'));
    stats.record(fakeReq('/'));
    stats.record(fakeReq('/admin'));
    stats.record(fakeReq('/admin/api/stats'));

    const snapshot = stats.snapshot();
    assert.equal(snapshot.activeClientHoursToday, 0);
    assert.equal(snapshot.requestsToday, 0);
  });

  it('ignores unmatched requests (404s)', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record({ route: undefined });
    assert.equal(stats.snapshot().requestsToday, 0);
  });

  it('buckets requests by hour of day in the configured time zone', () => {
    // 14:00 UTC is 16:00 in Europe/Warsaw (UTC+2 in August).
    const now = () => atDay(7, 14);
    const stats = new StatsTracker({ now });
    stats.record(fakeReq('/locations'));

    const hourly = stats.snapshot().hourly;
    assert.equal(hourly[16].requests, 1);
    assert.equal(hourly[15].requests, 0);
  });

  it('survives a save/load round-trip with identical counts', () => {
    const file = tempFile();
    let current;
    const now = () => current;

    current = atDay(1);
    const first = new StatsTracker({ file, now });
    first.record(fakeReq('/locations', { format: 'map' }));
    first.record(fakeReq('/vehicle/4-1'));
    first.save();

    current = atDay(2);
    const second = new StatsTracker({ file, now });
    assert.equal(second.snapshot().activeClientHours30d, hoursFor(1), 'loaded from disk');
    assert.equal(second.snapshot().requests30d, 2);
    assert.equal(second.snapshot().requestsToday, 0, 'the requests were on day 1, not today');
    assert.deepEqual(second.snapshot().daily[0], {
      date: '2026-08-01',
      requests: 2,
      mapPolls: 1,
      activeClientHours: hoursFor(1),
    });
    const persisted = fs.readFileSync(file, 'utf8');
    assert.equal(persisted.includes('10.0.0.'), false);
    assert.equal(persisted.includes('users'), false);
  });

  it('deletes all legacy IP-bearing history on startup', () => {
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({
      days: { '2026-08-06': { requests: 4, users: ['10.0.0.1', '10.0.0.2'] } },
    }));

    const stats = new StatsTracker({ file, now: () => atDay(7) });
    assert.equal(stats.snapshot().requests30d, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      schemaVersion: 2,
      savedAt: atDay(7).toISOString(),
      days: {},
    });
  });

  it('discards a corrupted snapshot instead of retaining unknown data', () => {
    const file = tempFile();
    fs.writeFileSync(file, '{ not json');
    const stats = new StatsTracker({ file, now: () => atDay(7) });
    stats.record(fakeReq('/locations', { format: 'map' }));
    assert.equal(stats.snapshot().activeClientHoursToday, hoursFor(1));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  });

  it('exposes the day key and hour helpers', () => {
    const tracker = new StatsTracker({});
    assert.equal(typeof dayKey(atDay(7), tracker.formatters), 'string');
    assert.equal(hourOf(atDay(7, 9), tracker.formatters), 11, '09:00 UTC is 11:00 Warsaw');
  });
});
