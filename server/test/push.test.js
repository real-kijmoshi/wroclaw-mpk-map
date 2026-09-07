'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');

const { PushRegistry } = require('../src/push');

const TOKEN = 'ExponentPushToken[abcdefghijklmnop]';
const OTHER = 'ExponentPushToken[qrstuvwxyz012345]';

/** A stand-in for Expo that records what it was asked to deliver. */
const fakeExpo = (tickets = null) => {
  const calls = [];
  const send = async (url, init) => {
    const batch = JSON.parse(init.body);
    calls.push({ url, batch });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: tickets ? tickets(batch) : batch.map(() => ({ status: 'ok', id: 'x' })),
      }),
    };
  };
  send.calls = calls;
  return send;
};

const incident = (id, overrides = {}) => ({
  id,
  status: 'active',
  affected: ['4'],
  lastUpdatedAt: 1_000,
  shortNotificationTitle: 'Tramwaje 4 i 10 objazdem',
  shortNotificationBody: 'Awaria na Legnickiej, objazd przez Rynek.',
  ...overrides,
});

describe('PushRegistry', () => {
  let file;
  let registry;

  const build = (options = {}) =>
    new PushRegistry({
      file,
      enabled: true,
      endpoint: 'https://example.invalid/push',
      logger: { warn() {}, info() {} },
      ...options,
    });

  beforeEach(() => {
    file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wroclive-push-')),
      'push-subscriptions.json',
    );
    registry = build();
  });

  it('accepts only a real Expo token', () => {
    assert.equal(registry.register({ token: TOKEN, lines: ['4'] }).ok, true);
    assert.equal(registry.register({ token: 'nonsense' }).ok, false);
    assert.equal(registry.register({ token: '' }).ok, false);
    assert.equal(registry.subscriptions.size, 1);
  });

  it('replaces a token’s lines rather than stacking a second row', () => {
    registry.register({ token: TOKEN, lines: ['4'] });
    registry.register({ token: TOKEN, lines: ['33', '17'] });
    assert.equal(registry.subscriptions.size, 1);
    assert.deepEqual(registry.get(TOKEN).lines, ['33', '17']);
  });

  it('primes itself on a first run instead of announcing the backlog', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.load();
    registry.register({ token: TOKEN, lines: ['4'] });

    // The archive has just restored hours-old incidents. None of this is news.
    const result = await registry.notifyIncidents([incident('i1'), incident('i2')]);
    assert.equal(result.skipped, 'primed');
    assert.equal(send.calls.length, 0);

    // And a restart must not undo that: the file now says what is old news.
    const restarted = build({ fetchImpl: send }).load();
    assert.equal(restarted.primed, true);
    await restarted.notifyIncidents([incident('i1'), incident('i2')]);
    assert.equal(send.calls.length, 0, 'a restart is not an incident');
  });

  it('sends what is new, once, to the phones that follow the line', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });
    registry.register({ token: OTHER, lines: ['33'] });

    const sent = await registry.notifyIncidents([incident('i1')]);
    assert.equal(sent.sent, 1);
    assert.equal(send.calls.length, 1);
    assert.deepEqual(
      send.calls[0].batch.map((message) => message.to),
      [TOKEN],
      'only the phone following line 4 hears about a line 4 incident',
    );
    assert.equal(send.calls[0].batch[0].title, 'Tramwaje 4 i 10 objazdem');
    assert.equal(send.calls[0].batch[0].body, 'Awaria na Legnickiej, objazd przez Rynek.');

    // The same incident on the next refresh five minutes later is not news.
    await registry.notifyIncidents([incident('i1')]);
    assert.equal(send.calls.length, 1);
  });

  it('does not re-announce a closure that has been running all summer', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });

    // Two months old and still in force — Wrocław has roadworks like this.
    const summer = incident('i1', { lastUpdatedAt: Date.now() - 60 * 86_400_000 });
    await registry.notifyIncidents([summer]);
    assert.equal(send.calls.length, 1);

    // Ageing it out of `sent` while it is still in the list would announce it
    // again to everyone who has known about it since June.
    await registry.notifyIncidents([summer]);
    assert.equal(send.calls.length, 1);
    assert.ok(registry.sent.has('i1'));
  });

  it('sends again when a running incident moves on', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });

    await registry.notifyIncidents([incident('i1')]);
    // "Tram 4 is running again" is the message people are actually waiting for.
    await registry.notifyIncidents([incident('i1', { lastUpdatedAt: 2_000 })]);
    assert.equal(send.calls.length, 2);
  });

  it('treats an empty line list as the whole network', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: [] });

    await registry.notifyIncidents([incident('i1', { affected: ['122'] })]);
    assert.equal(send.calls[0].batch.length, 1);
  });

  it('falls back to the incident’s own words when there is no lock-screen copy', async () => {
    const send = fakeExpo();
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });

    await registry.notifyIncidents([
      incident('i1', {
        shortNotificationTitle: null,
        shortNotificationBody: null,
        title: 'Awaria tramwaju',
        summary: 'Linia 4 kursuje objazdem.',
      }),
    ]);
    assert.equal(send.calls[0].batch[0].title, 'Awaria tramwaju');
    assert.equal(send.calls[0].batch[0].body, 'Linia 4 kursuje objazdem.');
  });

  it('drops a token the platform says is gone', async () => {
    const send = fakeExpo(() => [
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });

    await registry.notifyIncidents([incident('i1')]);
    assert.equal(registry.subscriptions.size, 0, 'the app is gone from that phone');
    assert.equal(registry.status.droppedTokens, 1);
  });

  it('survives a delivery failure without losing the refresh', async () => {
    const send = async () => {
      throw new Error('network is down');
    };
    registry = build({ fetchImpl: send });
    registry.prime([]);
    registry.register({ token: TOKEN, lines: ['4'] });

    const result = await registry.notifyIncidents([incident('i1')]);
    assert.equal(result.sent, 0);
    assert.equal(registry.status.lastError, 'network is down');
  });

  it('sends nothing at all when it is switched off', async () => {
    const send = fakeExpo();
    registry = build({ enabled: false, fetchImpl: send });
    registry.register({ token: TOKEN, lines: ['4'] });
    const result = await registry.notifyIncidents([incident('i1')]);
    assert.equal(result.skipped, 'disabled');
    assert.equal(send.calls.length, 0);
  });

  it('starts empty rather than throwing on an unreadable file', () => {
    fs.writeFileSync(file, '{ this is not json');
    const loaded = build().load();
    assert.equal(loaded.subscriptions.size, 0);
    assert.equal(loaded.primed, false, 'a cache miss must not license a backlog blast');
  });
});
