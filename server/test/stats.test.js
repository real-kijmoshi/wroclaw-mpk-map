'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { StatsTracker, dayKey, hourOf } = require('../src/stats');

// A stable day boundary: these UTC instants all fall inside Europe/Warsaw day
// (2026-08-0N) because Warsaw is UTC+2 in August.
const atDay = (day, hour = 12) => new Date(`2026-08-0${day}T${String(hour).padStart(2, '0')}:00:00Z`);

const fakeReq = (routePath, ip = '10.0.0.1') => ({ route: { path: routePath }, ip });

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-')), 'stats.json');

describe('StatsTracker', () => {
  it('counts requests, unique users and endpoint buckets for today', () => {
    const now = () => atDay(7);
    const stats = new StatsTracker({ now });

    stats.record(fakeReq('/locations', '10.0.0.1'));
    stats.record(fakeReq('/locations', '10.0.0.2'));
    stats.record(fakeReq('/vehicle/4-1', '10.0.0.1'));

    const snapshot = stats.snapshot();
    assert.equal(snapshot.dau, 2);
    assert.equal(snapshot.requestsToday, 3);
    assert.deepEqual(snapshot.topEndpointsToday, [
      { endpoint: '/locations', count: 2 },
      { endpoint: '/vehicle/4-1', count: 1 },
    ]);
    assert.equal(snapshot.today, '2026-08-07');
  });

  it('groups requests that share a route pattern into one bucket', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record(fakeReq('/vehicle/:id'));
    stats.record(fakeReq('/vehicle/:id'));

    const snapshot = stats.snapshot();
    assert.deepEqual(snapshot.topEndpointsToday, [{ endpoint: '/vehicle/:id', count: 2 }]);
  });

  it('computes DAU, WAU and MAU across calendar days', () => {
    let current;
    const now = () => current;
    const stats = new StatsTracker({ now });

    // Day 1: 10.0.0.1 + 10.0.0.2. Day 2: 10.0.0.2 + 10.0.0.3.
    current = atDay(1);
    stats.record(fakeReq('/locations', '10.0.0.1'));
    stats.record(fakeReq('/locations', '10.0.0.2'));

    current = atDay(2);
    stats.record(fakeReq('/locations', '10.0.0.2'));
    stats.record(fakeReq('/locations', '10.0.0.3'));

    const snapshot = stats.snapshot();
    assert.equal(snapshot.today, '2026-08-02');
    assert.equal(snapshot.dau, 2, 'users seen only today');
    assert.equal(snapshot.wau, 3, 'union of the last 7 days');
    assert.equal(snapshot.mau, 3, 'union of the last 30 days');
    assert.equal(snapshot.requestsToday, 2);
    assert.equal(snapshot.requests7d, 4);
    assert.equal(snapshot.requests30d, 4);
  });

  it('keeps only the configured number of days', () => {
    let current;
    const now = () => current;
    const stats = new StatsTracker({ now, daysToKeep: 3 });

    for (let day = 1; day <= 5; day += 1) {
      current = atDay(day);
      stats.record(fakeReq('/locations', `10.0.0.${day}`));
    }

    const snapshot = stats.snapshot();
    assert.equal(stats.days.size, 3);
    assert.equal(snapshot.dau, 1, 'only day 5 is today');
    assert.equal(snapshot.mau, 3, 'the two pruned days no longer count');
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
    assert.equal(snapshot.dau, 0);
    assert.equal(snapshot.requestsToday, 0);
  });

  it('ignores unmatched requests (404s)', () => {
    const stats = new StatsTracker({ now: () => atDay(7) });
    stats.record({ route: undefined, ip: '10.0.0.1' });
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
    first.record(fakeReq('/locations', '10.0.0.1'));
    first.record(fakeReq('/vehicle/4-1', '10.0.0.2'));
    first.save();

    current = atDay(2);
    const second = new StatsTracker({ file, now });
    assert.equal(second.snapshot().mau, 2, 'loaded from disk');
    assert.equal(second.snapshot().requests30d, 2);
    assert.equal(second.snapshot().requestsToday, 0, 'the requests were on day 1, not today');
    assert.deepEqual(second.snapshot().daily[0], { date: '2026-08-01', requests: 2, users: 2 });
  });

  it('recovers from a corrupted snapshot instead of dying', () => {
    const file = tempFile();
    fs.writeFileSync(file, '{ not json');
    const stats = new StatsTracker({ file, now: () => atDay(7) });
    stats.record(fakeReq('/locations'));
    assert.equal(stats.snapshot().dau, 1);
  });

  it('exposes the day key and hour helpers', () => {
    const tracker = new StatsTracker({});
    assert.equal(typeof dayKey(atDay(7), tracker.formatters), 'string');
    assert.equal(hourOf(atDay(7, 9), tracker.formatters), 11, '09:00 UTC is 11:00 Warsaw');
  });
});
