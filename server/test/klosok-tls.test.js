'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Agent } = require('undici');

// Config reads .env; force the flag to its documented default so a local
// .env override cannot silently change what this file tests.
process.env.KLOSOK_TLS_ALLOW_INVALID_CERT = '';

const config = require('../src/config');
const { fetchWithTimeout } = require('../src/http');
const { fetchKlosokFeed } = require('../src/klosok/fetch');

/** The TLS options the undici Agent was built with (Symbol('options')). */
const agentConnect = (agent) => {
  const optionsSymbol = Object.getOwnPropertySymbols(agent).find(
    (symbol) => symbol.description === 'options',
  );
  return optionsSymbol ? agent[optionsSymbol].connect : null;
};

describe('Kłosok TLS escape hatch', () => {
  let captured;
  let originalFetch;

  const stubFetch = () => {
    captured = [];
    originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      captured.push({ url: String(url), init: init || {} });
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) };
    };
  };

  const restoreFetch = () => {
    global.fetch = originalFetch;
  };

  it('defaults to strict TLS verification', () => {
    assert.equal(config.klosok.tlsAllowInvalidCert, false);
  });

  it('uses the dedicated undici agent only when the flag is on', async () => {
    stubFetch();
    try {
      await fetchKlosokFeed('https://mapadlugoleka.klosok.eu/vehicle_positions.pb', {
        allowInvalidCert: true,
      });
      await fetchKlosokFeed('https://mapadlugoleka.klosok.eu/vehicle_positions.pb', {
        allowInvalidCert: false,
      });
      // No explicit flag: falls back to the config default (false).
      await fetchKlosokFeed('https://mapadlugoleka.klosok.eu/vehicle_positions.pb');
    } finally {
      restoreFetch();
    }

    assert.equal(captured.length, 3);
    const [relaxed, strict, defaulted] = captured;

    assert.ok(relaxed.init.dispatcher instanceof Agent);
    assert.equal(agentConnect(relaxed.init.dispatcher).rejectUnauthorized, false);
    assert.equal(strict.init.dispatcher, undefined);
    assert.equal(defaulted.init.dispatcher, undefined);
  });

  it('never attaches a dispatcher to the shared fetch used by every other source', async () => {
    stubFetch();
    try {
      await fetchWithTimeout('https://mpk.wroc.pl/bus_position', { timeoutMs: 1000 });
      await fetchWithTimeout('https://open-data.cui.wroclaw.pl/hdb/db/14?download=json', {
        timeoutMs: 1000,
      });
    } finally {
      restoreFetch();
    }

    assert.equal(captured.length, 2);
    for (const call of captured) {
      assert.equal(call.init.dispatcher, undefined);
    }
  });
});
