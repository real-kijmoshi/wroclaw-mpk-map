'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const config = require('../src/config');
const logger = require('../src/logger');
const { KdService } = require('../src/kd/service');

// Dependency-free fake clock: ordered timer queue, microtask flushing between
// ticks so promise-backed poll loops settle before we assert. Swaps in
// global.setTimeout / global.clearTimeout and restores on uninstall.
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

describe('KdService polling lifecycle (fake timers)', () => {
  let clock;
  let service;
  let originalConfig;
  let originalError;

  beforeEach(() => {
    clock = installFakeClock();
    originalConfig = {
      enabled: config.kd.enabled,
      realtimeUrl: config.kd.realtimeUrl,
      publicRealtimeEnabled: config.kd.publicRealtimeEnabled,
      refreshIntervalMs: config.kd.refreshIntervalMs,
      publicRealtimePollIntervalMs: config.kd.publicRealtimePollIntervalMs,
    };
    config.kd.enabled = true;
    config.kd.realtimeUrl = '';
    config.kd.publicRealtimeEnabled = true;
    config.kd.refreshIntervalMs = 1000;
    config.kd.publicRealtimePollIntervalMs = 500;
    originalError = logger.error;
    logger.error = () => {};
  });

  afterEach(() => {
    service?.stop();
    clock.uninstall();
    config.kd.enabled = originalConfig.enabled;
    config.kd.realtimeUrl = originalConfig.realtimeUrl;
    config.kd.publicRealtimeEnabled = originalConfig.publicRealtimeEnabled;
    config.kd.refreshIntervalMs = originalConfig.refreshIntervalMs;
    config.kd.publicRealtimePollIntervalMs = originalConfig.publicRealtimePollIntervalMs;
    logger.error = originalError;
  });

  it('slow static poll does not overlap — call count stays 1 across several intervals', async () => {
    let staticPolls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    service = new KdService();
    service.refreshStatic = async () => {
      staticPolls += 1;
      await gate;
    };
    service.pollRealtime = async () => {};

    service.start();
    await clock.advance(0);

    assert.equal(staticPolls, 1, 'one immediate static poll started');
    assert.ok(service.staticTimer, 'placeholder timer held');

    await clock.advance(5000);
    assert.equal(staticPolls, 1, 'no second static poll while first is pending');

    release();
    await clock.advance(0);
    assert.ok(service.staticTimer, 'exactly one next static timer');
    assert.equal(staticPolls, 1, 'still 1 until the timer fires');

    await clock.advance(1000);
    assert.equal(staticPolls, 2, 'second poll fires after the timer');
  });

  it('slow realtime poll does not overlap — call count stays 1 across several intervals', async () => {
    let realtimePolls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    service = new KdService();
    service.refreshStatic = async () => {};
    service.pollRealtime = async () => {
      realtimePolls += 1;
      await gate;
    };

    service.start();
    await clock.advance(0);

    assert.equal(realtimePolls, 1, 'one immediate realtime poll started');
    await clock.advance(3000);
    assert.equal(realtimePolls, 1, 'no second realtime poll while first is pending');

    release();
    await clock.advance(0);
    assert.ok(service.realtimeTimer, 'exactly one next realtime timer');

    await clock.advance(500);
    assert.equal(realtimePolls, 2);
  });

  it('double start creates only one loop per source', async () => {
    let staticPolls = 0;
    let realtimePolls = 0;
    service = new KdService();
    service.refreshStatic = async () => { staticPolls += 1; };
    service.pollRealtime = async () => { realtimePolls += 1; };

    service.start();
    service.start();
    await clock.advance(0);

    assert.equal(staticPolls, 1, 'only one static loop');
    assert.equal(realtimePolls, 1, 'only one realtime loop');
    assert.ok(service.staticTimer, 'single static timer');
    assert.ok(service.realtimeTimer, 'single realtime timer');
  });

  it('stop() during an in-flight poll prevents rearming', async () => {
    let staticPolls = 0;
    let realtimePolls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    service = new KdService();
    service.refreshStatic = async () => { staticPolls += 1; await gate; };
    service.pollRealtime = async () => { realtimePolls += 1; await gate; };

    service.start();
    await clock.advance(0);
    assert.equal(staticPolls, 1, 'static poll in flight');

    service.stop();
    assert.equal(service.staticTimer, null, 'stop() clears the static timer');
    assert.equal(service.realtimeTimer, null, 'stop() clears the realtime timer');
    assert.equal(service._stopped, true);

    release();
    await clock.advance(0);
    assert.equal(service.staticTimer, null, 'static does not re-arm after stop');
    assert.equal(service.realtimeTimer, null, 'realtime does not re-arm after stop');
    assert.equal(staticPolls, 1, 'no second static poll after stop');
    assert.equal(realtimePolls, 1, 'no second realtime poll after stop');
  });

  it('a failed poll still schedules exactly one retry', async () => {
    let staticPolls = 0;
    service = new KdService();
    service.refreshStatic = async () => {
      staticPolls += 1;
      throw new Error('network down');
    };
    service.pollRealtime = async () => {};

    service.start();
    await clock.advance(0);

    assert.equal(staticPolls, 1, 'failed poll still ran once');
    assert.ok(service.staticTimer, 'one retry timer armed');

    await clock.advance(1000);
    assert.equal(staticPolls, 2, 'exactly one retry ran');
    assert.ok(service.staticTimer, 'one more retry armed');
  });

  it('static and realtime loops run independently', async () => {
    let staticPolls = 0;
    let realtimePolls = 0;
    service = new KdService();
    service.refreshStatic = async () => { staticPolls += 1; };
    service.pollRealtime = async () => { realtimePolls += 1; };

    config.kd.refreshIntervalMs = 2000;
    config.kd.publicRealtimePollIntervalMs = 500;

    service.start();
    await clock.advance(0);
    assert.equal(staticPolls, 1, 'one initial static poll');
    assert.equal(realtimePolls, 1, 'one initial realtime poll');

    // 500ms: only realtime fires
    await clock.advance(500);
    assert.equal(realtimePolls, 2, 'realtime re-arms at 500ms');
    assert.equal(staticPolls, 1, 'static does not fire at 500ms');

    // 1000ms: only realtime fires
    await clock.advance(500);
    assert.equal(realtimePolls, 3, 'realtime re-arms at 1000ms');
    assert.equal(staticPolls, 1, 'static still does not fire');

    // 1500ms: only realtime fires
    await clock.advance(500);
    assert.equal(realtimePolls, 4, 'realtime re-arms at 1500ms');
    assert.equal(staticPolls, 1, 'static still does not fire');

    // 2000ms: both fire
    await clock.advance(500);
    assert.equal(staticPolls, 2, 'static re-arms at 2000ms');
    assert.equal(realtimePolls, 5, 'realtime re-arms at 2000ms');
  });
});
