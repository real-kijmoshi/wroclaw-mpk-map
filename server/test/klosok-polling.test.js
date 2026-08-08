'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const config = require('../src/config');
const logger = require('../src/logger');
const { KlosokService } = require('../src/klosok/service');

// Dependency-free fake clock: ordered timer queue, microtask flushing between
// ticks so promise-backed poll loops settle before we assert.
const installFakeClock = () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let now = 0;
  const timers = [];
  const flushMicrotasks = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  };
  const advance = async (ms) => {
    now += ms;
    for (let guard = 0; guard < 100; guard += 1) {
      timers.sort((a, b) => a.fireAt - b.fireAt);
      let fired = false;
      let i = 0;
      while (i < timers.length) {
        const t = timers[i];
        i += 1;
        if (!t.cancelled && t.fireAt <= now) {
          t.cancelled = true;
          const result = t.cb();
          fired = true;
          if (result && typeof result.then === 'function') await result.catch(() => {});
        }
      }
      await flushMicrotasks();
      if (!fired && !timers.some((t) => !t.cancelled && t.fireAt <= now)) return;
    }
  };
  global.setTimeout = (cb, delay, ...args) => {
    const entry = { fireAt: now + (delay ?? 0), cb, args, cancelled: false };
    timers.push(entry);
    return entry;
  };
  global.clearTimeout = (handle) => {
    if (handle && !handle.cancelled) handle.cancelled = true;
  };
  return {
    advance,
    get now() { return now; },
    uninstall: () => {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      timers.length = 0;
    },
  };
};

describe('KlosokService polling lifecycle (fake timers)', () => {
  let clock;
  let service;
  let originalConfig;
  let originalError;

  beforeEach(() => {
    clock = installFakeClock();
    originalConfig = {
      enabled: config.klosok.enabled,
      gtfsRtUrl: config.klosok.gtfsRtUrl,
      pollIntervalMs: config.klosok.pollIntervalMs,
    };
    config.klosok.enabled = true;
    config.klosok.gtfsRtUrl = 'https://example.test/feed.pb';
    config.klosok.pollIntervalMs = 1000;
    originalError = logger.error;
    logger.error = () => {};
  });

  afterEach(() => {
    service?.stop();
    clock.uninstall();
    config.klosok.enabled = originalConfig.enabled;
    config.klosok.gtfsRtUrl = originalConfig.gtfsRtUrl;
    config.klosok.pollIntervalMs = originalConfig.pollIntervalMs;
    logger.error = originalError;
  });

  it('slow poll does not overlap — call count stays 1 across several intervals', async () => {
    let polls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    service = new KlosokService();
    service.poll = async () => {
      polls += 1;
      await gate;
    };

    service.start();
    await clock.advance(0);

    assert.equal(polls, 1, 'one immediate poll started');
    assert.ok(service.timer, 'placeholder timer held');

    await clock.advance(5000);
    assert.equal(polls, 1, 'no second poll while first is pending');

    release();
    await clock.advance(0);
    assert.ok(service.timer, 'exactly one next timer');
    assert.equal(polls, 1, 'still 1 until the timer fires');

    await clock.advance(1000);
    assert.equal(polls, 2, 'second poll fires after the timer');
  });

  it('double start creates only one loop', async () => {
    let polls = 0;
    service = new KlosokService();
    service.poll = async () => { polls += 1; };

    service.start();
    service.start();
    await clock.advance(0);

    assert.equal(polls, 1, 'only one poll ran');
    assert.ok(service.timer, 'single timer');
  });

  it('stop() during an in-flight poll prevents rearming', async () => {
    let polls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    service = new KlosokService();
    service.poll = async () => {
      polls += 1;
      await gate;
    };

    service.start();
    await clock.advance(0);
    assert.equal(polls, 1, 'poll in flight');

    service.stop();
    assert.equal(service.timer, null, 'stop() clears the timer');
    assert.equal(service._stopped, true);

    release();
    await clock.advance(0);
    assert.equal(service.timer, null, 'no timer re-armed after stop');
    assert.equal(polls, 1, 'no second poll after stop');
  });

  it('a failed poll still schedules exactly one retry', async () => {
    let polls = 0;
    service = new KlosokService();
    service.poll = async () => {
      polls += 1;
      throw new Error('feed down');
    };

    service.start();
    await clock.advance(0);

    assert.equal(polls, 1, 'failed poll still ran once');
    assert.ok(service.timer, 'one retry timer armed');

    await clock.advance(1000);
    assert.equal(polls, 2, 'exactly one retry ran');
    assert.ok(service.timer, 'one more retry armed');
  });
});
