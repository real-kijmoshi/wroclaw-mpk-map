'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');

const CONFIG = path.join(__dirname, '..', 'src', 'config.js');

/** `config.trustProxy` as a fresh process reads it from the environment. */
const hopsFor = (value) => {
  const env = { ...process.env };
  if (value === undefined) delete env.TRUST_PROXY;
  else env.TRUST_PROXY = value;
  const out = execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG)}).trustProxy))`], { env });
  return JSON.parse(String(out));
};

describe('TRUST_PROXY', () => {
  it('is a hop count, so a client cannot forge its address in X-Forwarded-For', () => {
    // `true` used to reach Express as `true`, which trusts every entry and reads
    // the client-written leftmost one: one header per request beat the limiter.
    assert.equal(hopsFor('true'), 1);
    assert.equal(hopsFor('2'), 2);
    assert.equal(hopsFor('false'), 0);
    assert.equal(hopsFor('nonsense'), 0);
    assert.equal(hopsFor(undefined), 0);
  });

  it('reads the address the trusted proxy saw, not the one the client wrote', async () => {
    const express = require('express');
    const app = express();
    app.set('trust proxy', 1);
    app.get('/', (req, res) => res.send(req.ip));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
        // The client forged the first entry; nginx appended the real one.
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      });
      assert.equal(await response.text(), '203.0.113.9');
    } finally {
      server.close();
    }
  });
});
