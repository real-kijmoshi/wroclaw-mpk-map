'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const { ApnsClient } = require('../src/apns');
const { IncidentPushService, freshIncidents, incidentAlert, parseDevice } = require('../src/incident-push');

const TOKEN = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);
const MIN = 60_000;
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const incident = (id, minutesAgo, { affected = ['4'], status = 'active', sources = [id] } = {}) => ({
  id: `incident-${id}`,
  status,
  affected,
  title: `Tramwaje ${affected.join(', ')} nie kursują`,
  shortNotificationTitle: null,
  shortNotificationBody: null,
  sourceAlertIds: sources,
  firstSeenAt: NOW - minutesAgo * MIN,
});

/** An alerts service stand-in whose incident list a test can swap between passes. */
const alertsWith = (initial = []) => {
  const alerts = { list: initial, status: { lastRefreshAt: '2026-11-14T08:00:00Z' } };
  alerts.getIncidents = () => alerts.list;
  return alerts;
};

const startFakeApns = async (respond = () => ({ status: 200 })) => {
  // Alerts only: the silent verification sent on registration goes to
  // `verifications`, so a test counts what a rider would actually see.
  const received = [];
  const verifications = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      const token = headers[':path'].split('/').pop();
      const push = { headers, token, body: JSON.parse(body) };
      (headers['apns-push-type'] === 'background' ? verifications : received).push(push);
      const { status, reason } = respond(token, headers);
      stream.respond({ ':status': status });
      stream.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, verifications, origin: `http://127.0.0.1:${server.address().port}` };
};

const servers = [];
after(() => {
  for (const server of servers) server.close();
});

async function serviceWith(alerts, respond) {
  const fake = await startFakeApns(respond);
  servers.push(fake.server);
  const apns = new ApnsClient({ keyId: 'KEY', teamId: 'TEAM', privateKey: PEM, origin: fake.origin });
  const service = new IncidentPushService({ apns, alerts, bundleId: 'com.kijmoshi.wroclive' });
  // Primed: this pass is not the first one after a fresh deploy.
  service.primed = true;
  return { service, received: fake.received, verifications: fake.verifications, apns };
}

describe('incident push registration', () => {
  it('keeps the token, the scope and valid line names only', () => {
    const device = parseDevice({ token: TOKEN, mode: 'mine', lines: ['4', 'a', '<b>', '4', 145] });
    assert.deepEqual(device, { token: TOKEN, mode: 'mine', lines: ['4', 'A'] });
    assert.match(parseDevice({ token: 'nope', mode: 'all' }), /token/);
    assert.match(parseDevice({ token: TOKEN, mode: 'off' }), /mode/);
  });

  it('answers 503 without an APNs key, so the app keeps announcing locally', () => {
    const service = new IncidentPushService({ apns: new ApnsClient({ keyId: '', teamId: '' }), alerts: alertsWith(), bundleId: 'x' });
    assert.equal(service.register({ token: TOKEN, mode: 'all' }).status, 503);
  });

  it('keeps the opt-in date when a device registers again', async () => {
    const { service } = await serviceWith(alertsWith());
    service.register({ token: TOKEN, mode: 'all' }, NOW - 60 * MIN);
    service.register({ token: TOKEN, mode: 'mine', lines: ['4'] }, NOW);
    assert.equal(service.devices.get(TOKEN).enabledAt, NOW - 60 * MIN);
    assert.equal(service.devices.get(TOKEN).mode, 'mine');
  });
});

describe('incident push registry bounds', () => {
  const DAY = 24 * 60 * MIN;
  const token = (index) => index.toString(16).padStart(64, '0');

  // The verification push: real installs answer 200, a script's tokens are
  // made up. A 500 is APNs unable to say right now — the token stays unproven.
  const unverifiable = (prefix) => (token, headers) =>
    headers['apns-push-type'] === 'background' && token.startsWith(prefix) ? { status: 500 } : { status: 200 };

  it('confirms a new token only once APNs accepts the silent verification push', async () => {
    const { service, verifications } = await serviceWith(alertsWith());
    const result = service.register({ token: TOKEN, mode: 'all' }, NOW);
    assert.equal(service.devices.get(TOKEN).confirmed, false);
    await result.verified;
    assert.equal(service.devices.get(TOKEN).confirmed, true);
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].headers['apns-priority'], '5');
    assert.deepEqual(verifications[0].body, { aps: { 'content-available': 1 } });
    // Re-registering a confirmed phone does not ask APNs again.
    await service.register({ token: TOKEN, mode: 'all' }, NOW + MIN).verified;
    assert.equal(verifications.length, 1);
  });

  it('drops a made-up token as soon as APNs rejects its verification', async () => {
    const { service } = await serviceWith(alertsWith(), () => ({ status: 400, reason: 'BadDeviceToken' }));
    await service.register({ token: TOKEN, mode: 'all' }, NOW).verified;
    assert.equal(service.devices.has(TOKEN), false);
  });

  it('cannot be made permanent by waiting and registering again', async () => {
    // The rule this replaced trusted a token that came back a day later.
    const { service } = await serviceWith(alertsWith(), unverifiable('00'));
    await service.register({ token: token(1), mode: 'all' }, NOW - 3 * DAY).verified;
    await service.register({ token: token(1), mode: 'all' }, NOW).verified;
    assert.equal(service.devices.get(token(1)).confirmed, false);
  });

  it('makes room by evicting only what APNs has not vouched for', async () => {
    const { service } = await serviceWith(alertsWith(), unverifiable('00'));
    service.maxDevices = 3;
    await service.register({ token: OTHER, mode: 'all' }, NOW - 3 * DAY).verified;
    for (let index = 1; index <= 2; index += 1) {
      await service.register({ token: token(index), mode: 'all' }, NOW - index * MIN).verified;
    }
    // A new rider still gets in, and the rider already listening is untouched.
    assert.equal(service.register({ token: TOKEN, mode: 'all' }, NOW).ok, true);
    assert.equal(service.devices.has(OTHER), true);
    assert.equal(service.devices.has(token(2)), false);
  });

  it('refuses a newcomer rather than evict a confirmed phone', async () => {
    const { service } = await serviceWith(alertsWith());
    service.maxDevices = 1;
    await service.register({ token: OTHER, mode: 'all' }, NOW).verified;
    assert.equal(service.register({ token: TOKEN, mode: 'all' }, NOW).status, 503);
    assert.deepEqual([...service.devices.keys()], [OTHER]);
  });

  it('confirms a token whose verification failed once a real alert reaches it', async () => {
    const alerts = alertsWith();
    const { service } = await serviceWith(alerts, unverifiable('cd'));
    await service.register({ token: TOKEN, mode: 'all' }, NOW - 60 * MIN).verified;
    assert.equal(service.devices.get(TOKEN).confirmed, false);
    alerts.list = [incident('a', 5)];
    await service.tick(NOW);
    assert.equal(service.devices.get(TOKEN).confirmed, true);
  });

  it('drops a registration nobody has refreshed, on a pass and on restore', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'incident-push-')), 'incident-push.json');
    const { service, apns } = await serviceWith(alertsWith());
    service.file = file;
    service.register({ token: TOKEN, mode: 'all' }, NOW - 40 * DAY);
    service.register({ token: OTHER, mode: 'all' }, NOW);
    service.saveNow();
    const restored = new IncidentPushService({ apns, alerts: alertsWith(), bundleId: 'x', file });
    restored.load(NOW);
    assert.deepEqual([...restored.devices.keys()], [OTHER]);
    await service.tick(NOW);
    assert.deepEqual([...service.devices.keys()], [OTHER]);
    service.stop();
  });
});

describe('which incidents are new', () => {
  it('is new only when none of its posts has been seen, so a growing cluster is not news twice', () => {
    const first = freshIncidents([incident('a', 5, { sources: ['p1'] })], {}, NOW);
    assert.equal(first.fresh.length, 1);
    // A second post joins: the cluster's id changes with it, its posts do not.
    const grown = freshIncidents([incident('b', 5, { sources: ['p1', 'p2'] })], first.seen, NOW + MIN);
    assert.equal(grown.fresh.length, 0);
  });

  it('skips resolved and stale incidents but remembers their posts', () => {
    const { fresh, seen } = freshIncidents(
      [incident('a', 5, { status: 'resolved' }), incident('b', 4 * 60)],
      {},
      NOW,
    );
    assert.equal(fresh.length, 0);
    assert.deepEqual(Object.keys(seen).sort(), ['a', 'b']);
  });

  it('uses the app\'s wording when the AI wrote no short title', () => {
    assert.deepEqual(incidentAlert(incident('a', 5, { affected: ['4', '10'] })), {
      title: 'Utrudnienia: linie 4, 10',
      body: 'Tramwaje 4, 10 nie kursują',
    });
  });
});

describe('incident push passes', () => {
  it('pushes a new incident to the devices whose scope it is in', async () => {
    const alerts = alertsWith();
    const { service, received } = await serviceWith(alerts);
    service.register({ token: TOKEN, mode: 'mine', lines: ['10'] }, NOW - 60 * MIN);
    service.register({ token: OTHER, mode: 'all' }, NOW - 60 * MIN);
    alerts.list = [incident('a', 5, { affected: ['4'] })];
    await service.tick(NOW);
    assert.deepEqual(received.map((push) => push.token), [OTHER]);
    const push = received[0];
    assert.equal(push.headers['apns-push-type'], 'alert');
    assert.equal(push.headers['apns-topic'], 'com.kijmoshi.wroclive');
    assert.equal(push.headers['apns-collapse-id'], 'incident:incident-a');
    assert.equal(push.body.aps.alert.title, 'Utrudnienia: linia 4');
    // Under `body`: that is what expo-notifications hands the app as `data`.
    assert.deepEqual(push.body.body, { kind: 'incident', incidentId: 'incident-a' });
  });

  it('pushes each incident once, and nothing that began before the device opted in', async () => {
    const alerts = alertsWith();
    const { service, received } = await serviceWith(alerts);
    service.register({ token: TOKEN, mode: 'all' }, NOW - 10 * MIN);
    alerts.list = [incident('old', 30), incident('new', 5)];
    await service.tick(NOW);
    await service.tick(NOW + MIN);
    assert.deepEqual(received.map((push) => push.body.body.incidentId), ['incident-new']);
  });

  it('reads "mine" with no lines as every line', async () => {
    const alerts = alertsWith();
    const { service, received } = await serviceWith(alerts);
    service.register({ token: TOKEN, mode: 'mine', lines: [] }, NOW - 60 * MIN);
    alerts.list = [incident('a', 5, { affected: ['145'] })];
    await service.tick(NOW);
    assert.equal(received.length, 1);
  });

  it('folds a burst into one summary', async () => {
    const alerts = alertsWith();
    const { service, received } = await serviceWith(alerts);
    service.register({ token: TOKEN, mode: 'all' }, NOW - 60 * MIN);
    alerts.list = ['a', 'b', 'c', 'd', 'e'].map((id, index) => incident(id, 10 - index));
    await service.tick(NOW);
    assert.equal(received.length, 3);
    const summary = received.find((push) => push.headers['apns-collapse-id'] === 'incident:summary');
    assert.equal(summary.body.aps.alert.title, '3 nowe utrudnienia');
  });

  it('only learns on its first pass after a fresh deploy, and waits for the alerts to load', async () => {
    const alerts = alertsWith([incident('a', 5)]);
    alerts.status.lastRefreshAt = null;
    const { service, received } = await serviceWith(alerts);
    service.primed = false;
    service.register({ token: TOKEN, mode: 'all' }, NOW - 60 * MIN);
    await service.tick(NOW);
    assert.equal(service.primed, false, 'nothing learnt before the alerts service has refreshed');
    alerts.status.lastRefreshAt = '2026-11-14T09:00:00Z';
    await service.tick(NOW);
    assert.equal(received.length, 0, 'the incidents already active are not news');
    alerts.list = [incident('a', 5), incident('b', 1)];
    await service.tick(NOW + MIN);
    assert.deepEqual(received.map((push) => push.body.body.incidentId), ['incident-b']);
  });

  it('forgets a token APNs says is dead', async () => {
    const alerts = alertsWith();
    const { service } = await serviceWith(alerts, (token) =>
      token === TOKEN ? { status: 400, reason: 'BadDeviceToken' } : { status: 200 },
    );
    service.register({ token: TOKEN, mode: 'all' }, NOW - 60 * MIN);
    service.register({ token: OTHER, mode: 'all' }, NOW - 60 * MIN);
    alerts.list = [incident('a', 5)];
    await service.tick(NOW);
    assert.deepEqual([...service.devices.keys()], [OTHER]);
  });

  it('keeps registrations and what was announced across a restart', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'incident-push-')), 'incident-push.json');
    const alerts = alertsWith();
    const { service, apns } = await serviceWith(alerts);
    service.file = file;
    service.register({ token: TOKEN, mode: 'mine', lines: ['4'] }, NOW - 60 * MIN);
    alerts.list = [incident('a', 5)];
    await service.tick(NOW);
    service.stop();

    const restarted = new IncidentPushService({ apns, alerts, bundleId: 'x', file });
    restarted.load(NOW + MIN);
    assert.equal(restarted.devices.get(TOKEN).enabledAt, NOW - 60 * MIN);
    assert.equal(restarted.primed, true);
    const { fresh } = freshIncidents(alerts.list, restarted.seen, NOW + MIN);
    assert.equal(fresh.length, 0, 'a restart does not announce the same incident again');
  });
});

describe('/incident-push', () => {
  const { createApp } = require('../src/app');
  const { GtfsStore } = require('../src/gtfs/store');
  const fakeAlerts = { status: { providers: [], lastRefreshAt: null, count: 0 }, getAlerts: () => [], getIncidents: () => [] };
  const fakeVehicles = { snapshot: { locations: [], count: 0 }, status: {}, getVehicle: () => null };

  const serve = async (incidentPush) => {
    const app = createApp({ gtfs: new GtfsStore(), vehicles: fakeVehicles, alerts: fakeAlerts, incidentPush });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
  };
  const post = (base, body) =>
    fetch(`${base}/incident-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers 503 without a key, so the app keeps announcing locally', async () => {
    const service = new IncidentPushService({ apns: new ApnsClient({ keyId: '', teamId: '' }), alerts: fakeAlerts, bundleId: 'x' });
    const { base, close } = await serve(service);
    try {
      assert.equal((await post(base, { token: TOKEN, mode: 'all' })).status, 503);
    } finally {
      close();
    }
  });

  it('registers, rejects nonsense, and removes a device', async () => {
    const service = new IncidentPushService({
      apns: new ApnsClient({ keyId: 'K', teamId: 'T', privateKey: PEM, origin: 'http://127.0.0.1:1' }),
      alerts: fakeAlerts,
      bundleId: 'x',
    });
    const { base, close } = await serve(service);
    try {
      assert.equal((await post(base, { token: TOKEN, mode: 'mine', lines: ['4'] })).status, 204);
      assert.equal(service.status.devices, 1);
      assert.equal((await post(base, { token: TOKEN, mode: 'loud' })).status, 400);
      assert.equal((await fetch(`${base}/incident-push/${TOKEN}`, { method: 'DELETE' })).status, 204);
      assert.equal(service.status.devices, 0);
    } finally {
      service.stop();
      close();
    }
  });

  it('rate-limits registration per client, so one script cannot fill the registry', async () => {
    const service = new IncidentPushService({
      apns: new ApnsClient({ keyId: 'K', teamId: 'T', privateKey: PEM, origin: 'http://127.0.0.1:1' }),
      alerts: fakeAlerts,
      bundleId: 'x',
    });
    const { base, close } = await serve(service);
    try {
      const statuses = [];
      for (let index = 0; index < 35; index += 1) {
        statuses.push((await post(base, { token: index.toString(16).padStart(64, '0'), mode: 'all' })).status);
      }
      assert.equal(statuses.filter((status) => status === 204).length, 30);
      assert.equal(statuses.at(-1), 429);
    } finally {
      service.stop();
      close();
    }
  });
});
