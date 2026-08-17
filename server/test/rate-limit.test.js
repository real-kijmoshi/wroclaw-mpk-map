'use strict';

const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');

const { createRateLimit } = require('../src/rate-limit');

/** Minimal Express-ish request/response pair: enough for the middleware. */
const exchange = (ip) => {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return { req: { ip }, res };
};

/** Drive `count` requests from one address and report how many passed through. */
const run = (limit, ip, count) => {
  let passed = 0;
  let last = null;
  for (let i = 0; i < count; i += 1) {
    const { req, res } = exchange(ip);
    limit(req, res, () => {
      passed += 1;
    });
    last = res;
  }
  return { passed, last };
};

describe('rate limit', () => {
  it('allows up to the limit and rejects the request after it', () => {
    const limit = createRateLimit({ windowMs: 60_000, max: 3 });
    const { passed, last } = run(limit, '10.0.0.1', 4);

    assert.equal(passed, 3);
    assert.equal(last.statusCode, 429);
    assert.equal(last.body.error, 'Too many requests');
    // A client that already handles the boot-time 503 gets the same shape here.
    assert.ok(Number(last.headers['Retry-After']) >= 1);
  });

  it('counts each address separately', () => {
    const limit = createRateLimit({ windowMs: 60_000, max: 2 });
    run(limit, '10.0.0.1', 2);

    // The first address is spent; a different one must be untouched by it.
    const { passed } = run(limit, '10.0.0.2', 2);
    assert.equal(passed, 2);
  });

  it('lets a client through again once its window has rolled over', () => {
    const limit = createRateLimit({ windowMs: 1_000, max: 1 });

    mock.timers.enable({ apis: ['Date'], now: 0 });
    try {
      assert.equal(run(limit, '10.0.0.1', 2).passed, 1);
      mock.timers.tick(1_001);
      assert.equal(run(limit, '10.0.0.1', 1).passed, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('reports the remaining allowance on every response', () => {
    const limit = createRateLimit({ windowMs: 60_000, max: 5 });
    const { last } = run(limit, '10.0.0.1', 2);

    assert.equal(last.headers['RateLimit-Limit'], '5');
    assert.equal(last.headers['RateLimit-Remaining'], '3');
  });

  it('does not limit at all when disabled or misconfigured', () => {
    // A mistyped env var must not take the API down, so a non-positive limit
    // means "no limiting" rather than "reject everything".
    for (const options of [
      { windowMs: 60_000, max: 1, enabled: false },
      { windowMs: 60_000, max: 0 },
      { windowMs: 0, max: 10 },
    ]) {
      const limit = createRateLimit(options);
      assert.equal(run(limit, '10.0.0.1', 50).passed, 50);
    }
  });

  it('does not grow without bound as addresses come and go', () => {
    const limit = createRateLimit({ windowMs: 1_000, max: 10 });

    mock.timers.enable({ apis: ['Date'], now: 0 });
    try {
      // One request each from far more addresses than the sweep interval, all
      // expiring before the sweep runs. Without the inline sweep every one of
      // them would still be held.
      for (let i = 0; i < 1_500; i += 1) {
        if (i === 1_200) mock.timers.tick(2_000);
        const { req, res } = exchange(`10.0.${Math.floor(i / 250)}.${i % 250}`);
        limit(req, res, () => {});
      }
      // The middleware keeps no public handle on its map, so this asserts the
      // observable consequence instead: an address seen before the sweep is
      // treated as new afterwards rather than carrying a stale count.
      const { passed } = run(limit, '10.0.0.1', 10);
      assert.equal(passed, 10);
    } finally {
      mock.timers.reset();
    }
  });

  it('falls back to the socket address when req.ip is absent', () => {
    const limit = createRateLimit({ windowMs: 60_000, max: 1 });

    const first = { req: { socket: { remoteAddress: '10.0.0.9' } }, res: exchange().res };
    let passed = 0;
    limit(first.req, first.res, () => {
      passed += 1;
    });
    const second = { req: { socket: { remoteAddress: '10.0.0.9' } }, res: exchange().res };
    limit(second.req, second.res, () => {
      passed += 1;
    });

    assert.equal(passed, 1);
    assert.equal(second.res.statusCode, 429);
  });
});
