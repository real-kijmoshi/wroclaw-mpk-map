'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const { after, describe, it } = require('node:test');

const { ApnsClient } = require('../src/apns');
const { LiveActivityService, bothFleets, parseRegistration, tripProgress } = require('../src/live-activities');

const TOKEN = 'ab'.repeat(32);
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const registration = (overrides = {}) => ({
  token: TOKEN,
  vehicleId: '10-1234',
  stopId: 'S2',
  view: { line: '10', color: '#0B5FBF', towards: 'Leśnica', stopName: 'Kliniki', amberLight: '#9A5B00', amberDark: '#FFB020' },
  ...overrides,
});

/** A plaintext HTTP/2 stand-in for api.push.apple.com that records every push. */
const startFakeApns = async (status = 200, reason = null) => {
  const received = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (body += chunk));
    stream.on('end', () => {
      received.push({ headers, body: JSON.parse(body) });
      stream.respond({ ':status': status });
      stream.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, origin: `http://127.0.0.1:${server.address().port}` };
};

describe('Live Activity registration', () => {
  it('accepts a complete registration and keeps only what the layout draws', () => {
    const record = parseRegistration(registration({ view: { ...registration().view, extra: '<script>' } }));
    assert.equal(record.token, TOKEN);
    assert.deepEqual(Object.keys(record.view).sort(), ['amberDark', 'amberLight', 'color', 'line', 'stopName', 'towards']);
  });

  it('rejects what is not a push token, and anything without a stop to count to', () => {
    assert.match(parseRegistration(registration({ token: 'not-hex' })), /token/);
    assert.match(parseRegistration(registration({ stopId: '' })), /required/);
    assert.match(parseRegistration(registration({ view: {} })), /view/);
  });

  it('replaces a colour that is not a plain hex value rather than echoing it', () => {
    const record = parseRegistration(registration({ view: { ...registration().view, color: 'red; x' } }));
    assert.match(record.view.color, /^#[0-9A-Fa-f]{6}$/);
  });

  it('reads a registration without a kind as an arrival, so builds from before trips keep working', () => {
    assert.equal(parseRegistration(registration()).kind, 'arrival');
    assert.equal(parseRegistration(registration()).view.totalStops, undefined);
  });

  it('accepts a trip with its stop count clamped, and refuses a kind it does not know', () => {
    const trip = parseRegistration(registration({ kind: 'trip', view: { ...registration().view, totalStops: 9999 } }));
    assert.equal(trip.kind, 'trip');
    assert.equal(trip.view.totalStops, 200);
    assert.equal(parseRegistration(registration({ kind: 'trip', view: { ...registration().view, totalStops: 'x' } })).view.totalStops, 1);
    assert.match(parseRegistration(registration({ kind: 'boat' })), /kind/);
  });

  it('answers 503 without an APNs key, so the app keeps updating the activity itself', () => {
    const service = new LiveActivityService({ apns: new ApnsClient({ keyId: '', teamId: '' }), bundleId: 'x' });
    assert.equal(service.register(registration()).status, 503);
    assert.equal(service.status.enabled, false);
  });
});

describe('vehicle lookup', () => {
  it('finds a Kłosok bus, so an alert armed on one is not ended on the first pass', () => {
    const mpk = { pollRevision: 7, getVehicle: (id) => (id === '10-1' ? { id } : null) };
    const klosok = { getVehicle: (id) => (id === 'klosok:931-5' ? { id } : null) };
    const fleets = bothFleets(mpk, klosok);
    assert.deepEqual(fleets.getVehicle('klosok:931-5'), { id: 'klosok:931-5' });
    assert.deepEqual(fleets.getVehicle('10-1'), { id: '10-1' });
    assert.equal(fleets.getVehicle('klosok:none'), null);
    assert.equal(fleets.pollRevision, 7);
    assert.equal(bothFleets(mpk, null).getVehicle('klosok:931-5'), null);
  });
});

describe('trip progress', () => {
  const stop = (id, etaSeconds = 60) => ({ id, name: `Stop ${id}`, etaSeconds });

  it('counts the destination itself as one of the stops to go', () => {
    const trip = { atStop: null, nextStops: [stop('A'), stop('B'), stop('C', 240)] };
    assert.deepEqual(tripProgress(trip, 'C'), { arrived: false, stopsAway: 3, etaSeconds: 240, nextStop: 'Stop A', nextStopEtaSeconds: 60 });
  });

  it('does not count the stop the vehicle is standing at — it is being left, not reached', () => {
    const trip = { atStop: { id: 'A' }, nextStops: [stop('A', 0), stop('B'), stop('C')] };
    const progress = tripProgress(trip, 'C');
    assert.equal(progress.stopsAway, 2);
    assert.equal(progress.nextStop, 'Stop B');
  });

  it('says arrived when standing at the destination, and null once it is behind', () => {
    assert.equal(tripProgress({ atStop: { id: 'C' }, nextStops: [stop('C', 0)] }, 'C').stopsAway, 0);
    assert.equal(tripProgress({ atStop: { id: 'C' }, nextStops: [stop('C', 0)] }, 'C').arrived, true);
    assert.equal(tripProgress({ atStop: null, nextStops: [stop('D')] }, 'C'), null);
  });
});

describe('APNs client', () => {
  const servers = [];
  after(() => servers.forEach((server) => server.close()));

  it('sends a signed liveactivity push to the device path', async () => {
    const fake = await startFakeApns();
    servers.push(fake.server);
    const client = new ApnsClient({ keyId: 'KEY123', teamId: 'TEAM456', privateKey: PEM, origin: fake.origin });
    const result = await client.send(TOKEN, { aps: { event: 'update' } }, { topic: 'com.x.push-type.liveactivity', priority: 5 });
    client.close();

    assert.deepEqual(result, { status: 200, reason: null });
    const { headers, body } = fake.received[0];
    assert.equal(headers[':path'], `/3/device/${TOKEN}`);
    assert.equal(headers['apns-push-type'], 'liveactivity');
    assert.equal(headers['apns-topic'], 'com.x.push-type.liveactivity');
    assert.equal(headers['apns-priority'], '5');
    assert.deepEqual(body, { aps: { event: 'update' } });

    // The bearer token is an ES256 JWT that verifies against the key's public half.
    const [header, claims, signature] = headers.authorization.replace('bearer ', '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM456');
    assert.ok(
      crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    );
  });

  it('reuses one auth token rather than minting one per push', async () => {
    const fake = await startFakeApns();
    servers.push(fake.server);
    const client = new ApnsClient({ keyId: 'K', teamId: 'T', privateKey: PEM, origin: fake.origin });
    await client.send(TOKEN, {}, { topic: 't' });
    await client.send(TOKEN, {}, { topic: 't' });
    client.close();
    assert.equal(fake.received[0].headers.authorization, fake.received[1].headers.authorization);
  });
});

describe('Live Activity service', () => {
  const servers = [];
  after(() => servers.forEach((server) => server.close()));

  const setup = async ({ status = 200, reason = null } = {}) => {
    const fake = await startFakeApns(status, reason);
    servers.push(fake.server);
    const state = { eta: 300, present: true, stops: ['S2'] };
    const service = new LiveActivityService({
      apns: new ApnsClient({ keyId: 'K', teamId: 'T', privateKey: PEM, origin: fake.origin }),
      gtfs: {},
      vehicles: { getVehicle: (id) => (state.present && id === '10-1234' ? { id } : null) },
      bundleId: 'com.kijmoshi.wroclive',
      describe: () => ({
        atStop: null,
        nextStops: state.stops.map((id) => ({ id, name: id, etaSeconds: state.eta })),
      }),
    });
    assert.equal(service.register(registration()).ok, true);
    return { fake, state, service };
  };

  it("pushes the countdown in the content state expo-widgets decodes", async () => {
    const { fake, service } = await setup();
    const now = Date.now();
    await service.tick(now);
    service.stop();

    const { headers, body } = fake.received[0];
    assert.equal(headers['apns-topic'], 'com.kijmoshi.wroclive.push-type.liveactivity');
    assert.equal(body.aps.event, 'update');
    assert.equal(body.aps['content-state'].name, 'Arrival');
    const props = JSON.parse(body.aps['content-state'].props);
    assert.equal(props.arrivesAt, now + 300_000);
    assert.equal(props.stopName, 'Kliniki');
    assert.equal(body.aps['stale-date'], Math.floor((now + 300_000 + 60_000) / 1000));
  });

  it('stays quiet while the arrival has not moved, and speaks when it does', async () => {
    const { fake, state, service } = await setup();
    const now = Date.now();
    await service.tick(now);
    await service.tick(now + 10_000); // arrival 10 s closer, clock 10 s on: unchanged
    state.eta = 240;
    await service.tick(now + 10_000);
    service.stop();
    assert.equal(fake.received.length, 2);
  });

  it('ends the activity once the stop is behind the vehicle', async () => {
    const { fake, state, service } = await setup();
    state.stops = ['S3'];
    await service.tick(Date.now());
    service.stop();
    assert.equal(fake.received[0].body.aps.event, 'end');
    assert.equal(service.status.active, 0);
  });

  it('ends it when the vehicle leaves the feed', async () => {
    const { fake, state, service } = await setup();
    state.present = false;
    await service.tick(Date.now());
    service.stop();
    assert.equal(fake.received[0].body.aps.event, 'end');
  });

  it('draws a trip with its own layout, and pushes when a stop is passed even if the clock has not moved', async () => {
    const { fake, state, service } = await setup();
    service.unregister(TOKEN);
    assert.equal(service.register(registration({ kind: 'trip', view: { ...registration().view, totalStops: 6 } })).ok, true);
    state.stops = ['S0', 'S1', 'S2'];
    const now = Date.now();
    await service.tick(now);
    state.stops = ['S1', 'S2'];
    state.eta = 290; // ten seconds later and ten seconds closer: the clock alone would stay quiet
    await service.tick(now + 10_000);
    service.stop();

    assert.equal(fake.received.length, 2);
    const first = fake.received[0].body.aps['content-state'];
    assert.equal(first.name, 'Trip');
    const props = JSON.parse(first.props);
    assert.equal(props.stopsAway, 3);
    assert.equal(props.nextStop, 'S0');
    assert.equal(props.totalStops, 6);
    assert.equal(JSON.parse(fake.received[1].body.aps['content-state'].props).stopsAway, 2);
    // The first draw can wait; a stop passed cannot — Apple may hold a
    // priority-5 push back until after the rider has got off.
    assert.equal(fake.received[0].headers['apns-priority'], '5');
    assert.equal(fake.received[1].headers['apns-priority'], '10');
  });

  it('forgets a token APNs says is dead', async () => {
    const { service } = await setup({ status: 410, reason: 'Unregistered' });
    await service.tick(Date.now());
    service.stop();
    assert.equal(service.status.active, 0);
    assert.match(service.status.lastError, /410 Unregistered/);
  });
});

describe('/live-activities', () => {
  const { createApp } = require('../src/app');
  const { GtfsStore } = require('../src/gtfs/store');
  const fakeAlerts = { status: { providers: [], lastRefreshAt: null, count: 0 }, getAlerts: () => [] };
  const fakeVehicles = { snapshot: { locations: [], count: 0 }, status: {}, getVehicle: () => null };

  const serve = async (liveActivities) => {
    const app = createApp({ gtfs: new GtfsStore(), vehicles: fakeVehicles, alerts: fakeAlerts, liveActivities });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => server.close() };
  };

  it('answers 503 without a key, so the app knows to keep the activity itself', async () => {
    const service = new LiveActivityService({ apns: new ApnsClient({ keyId: '', teamId: '' }), bundleId: 'x' });
    const { base, close } = await serve(service);
    try {
      const response = await fetch(`${base}/live-activities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registration()),
      });
      assert.equal(response.status, 503);
    } finally {
      close();
    }
  });

  it('registers and removes an activity when push is configured', async () => {
    const service = new LiveActivityService({
      apns: new ApnsClient({ keyId: 'K', teamId: 'T', privateKey: PEM, origin: 'http://127.0.0.1:1' }),
      bundleId: 'x',
    });
    const { base, close } = await serve(service);
    try {
      const created = await fetch(`${base}/live-activities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registration()),
      });
      assert.equal(created.status, 204);
      assert.equal(service.status.active, 1);

      const bad = await fetch(`${base}/live-activities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(registration({ token: 'nope' })),
      });
      assert.equal(bad.status, 400);

      const removed = await fetch(`${base}/live-activities/${TOKEN}`, { method: 'DELETE' });
      assert.equal(removed.status, 204);
      assert.equal(service.status.active, 0);
    } finally {
      service.stop();
      close();
    }
  });
});
