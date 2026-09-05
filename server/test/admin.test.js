'use strict';

// Env has to be set before requiring anything, because config reads it once.
process.env.ADMIN_TOKEN = 'test-admin-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { RuntimeSettings, validateModel } = require('../src/runtime-settings');
const { GtfsStore } = require('../src/gtfs/store');
const { StatsTracker } = require('../src/stats');
const { buildFixtureZip } = require('./fixtures/gtfs');

const fakeVehicles = {
  status: { source: 'test', lastSuccessAt: null, lastError: null, consecutiveFailures: 0, count: 2 },
  openDataStatus: {
    source: 'https://open-data.cui.wroclaw.pl/hdb/db/14?download=json',
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    count: 0,
  },
  stats: { mpk: 1, merged: 1, openData: 0, total: 2, activeLines: 2 },
  snapshot: {
    locations: [
      {
        id: '4-1',
        line: '4',
        type: 'tram',
        lat: 51.11,
        lon: 17.032,
        heading: 90,
        trip: { headsign: 'Oporów', towards: 'Oporów' },
        updatedAt: null,
      },
    ],
    count: 1,
    lastUpdated: null,
    source: 'test',
    stale: false,
  },
  getVehicle(id) {
    return this.snapshot.locations.find((entry) => entry.id === id) ?? null;
  },
  describeCache: new Map(),
};

const fakeAlerts = {
  status: { providers: [], lastRefreshAt: null, count: 1 },
  getAlerts: () => [],
  aiModel: 'env/model',
  incidentStatus: {
    enabled: true,
    provider: 'openrouter',
    model: 'env/model',
    lastSuccessAt: null,
    lastError: null,
    incidentCount: 0,
  },
  setAiModel(model) {
    // Uses the real validator rather than a copy of it: a fake with its own
    // rules would keep passing after the real ones changed, which is how the
    // route tests would stop testing the route.
    const checked = validateModel(model);
    if (!checked.ok) return checked;
    this.aiModel = checked.value;
    this.incidentStatus.model = checked.value;
    return { ok: true };
  },
};

describe('Admin dashboard', () => {
  const gtfs = new GtfsStore();
  const stats = new StatsTracker({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-')), 'stats.json'),
  });
  let server;
  let base;
  let runtimeSettings;

  const put = async (path, body, { token } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const get = async (path, { token } = {}) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${base}${path}`, { headers });
    const body = response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';

    runtimeSettings = new RuntimeSettings({
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'admin-settings-')),
    });
    const app = createApp({
      gtfs,
      vehicles: fakeVehicles,
      alerts: fakeAlerts,
      stats,
      runtimeSettings,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    stats.stop();
    server?.close();
  });

  it('serves the admin page shell without a token', async () => {
    const { status, headers, body } = await get('/admin');
    assert.equal(status, 200);
    assert.ok(headers.get('content-type').includes('text/html'));
    assert.ok(body.includes('statystyki'));
    assert.ok(body.includes('Aktywne klientogodziny'));
    assert.equal(body.includes("card('DAU'"), false);
  });

  it('rejects stats requests without a token', async () => {
    const { status, body } = await get('/admin/api/stats');
    assert.equal(status, 401);
    assert.equal(body.error, 'Unauthorized');
  });

  it('rejects a wrong token', async () => {
    const { status } = await get('/admin/api/stats', { token: 'nope' });
    assert.equal(status, 401);
  });

  it('serves a fresh snapshot to an authenticated caller', async () => {
    const { status, body } = await get('/admin/api/stats', { token: 'test-admin-secret' });
    assert.equal(status, 200);
    assert.equal(body.activeClientHoursToday, 0);
    assert.equal('dau' in body, false);
    assert.equal(body.requestsToday, 0);
    assert.ok(Array.isArray(body.daily));
    assert.equal(body.hourly.length, 24);
  });

  it('counts API traffic but not the admin or health endpoints', async () => {
    await get('/locations?format=map');
    await get('/vehicle/4-1');
    await get('/vehicle/128-7');
    await get('/health');

    const { status, body } = await get('/admin/api/stats', { token: 'test-admin-secret' });
    assert.equal(status, 200);
    assert.equal(body.activeClientHoursToday, 1 / 360, 'one poll represents ten active seconds');
    assert.equal(body.requestsToday, 3, '/health and /admin itself are not counted');
    // Different vehicle ids land in the same /vehicle/:id bucket.
    assert.deepEqual(body.topEndpointsToday, [
      { endpoint: '/vehicle/:id', count: 2 },
      { endpoint: '/locations', count: 1 },
    ]);
  });

  it('does not leak the snapshot to a client that hits a plain 404', async () => {
    const { status } = await get('/admin/api/stats/extra');
    assert.equal(status, 404);
  });

  describe('health and AI panels', () => {
    const token = 'test-admin-secret';

    it('keeps every new endpoint behind the token', async () => {
      for (const path of ['/admin/api/health', '/admin/api/ai']) {
        assert.equal((await get(path)).status, 401, `${path} is unauthenticated`);
        assert.equal((await get(path, { token: 'wrong' })).status, 401, `${path} takes any token`);
      }
      assert.equal((await put('/admin/api/ai/model', { model: 'x/y' })).status, 401);
      assert.equal(
        (await put('/admin/api/ai/model', { model: 'x/y' }, { token: 'wrong' })).status,
        401,
      );
    });

    it('serves the same health payload the public endpoint does', async () => {
      const admin = await get('/admin/api/health', { token });
      const open = await get('/health');
      assert.equal(admin.status, 200);
      assert.equal(admin.body.status, open.body.status);
      assert.deepEqual(admin.body.lines, open.body.lines);
    });

    it('never exposes the API key, only whether one exists', async () => {
      const { status, body } = await get('/admin/api/ai', { token });
      assert.equal(status, 200);
      assert.equal(typeof body.hasApiKey, 'boolean');
      assert.ok(!('apiKey' in body), 'the key itself is not in the payload');
      assert.ok(!JSON.stringify(body).includes('sk-'), 'no key-shaped string anywhere');
    });

    it('applies and persists a model change', async () => {
      const { status, body } = await put(
        '/admin/api/ai/model',
        { model: 'openai/gpt-4o-mini' },
        { token },
      );
      assert.equal(status, 200);
      assert.equal(body.model, 'openai/gpt-4o-mini');
      assert.equal(fakeAlerts.aiModel, 'openai/gpt-4o-mini', 'applied to the running service');
      assert.equal(runtimeSettings.values.aiModel, 'openai/gpt-4o-mini', 'and written down');

      const reloaded = new RuntimeSettings({ cacheDir: path.dirname(runtimeSettings.file) });
      assert.equal(reloaded.load().aiModel, 'openai/gpt-4o-mini', 'survives a restart');
    });

    it('rejects a model the service will not take, and does not store it', async () => {
      await put('/admin/api/ai/model', { model: 'good/model' }, { token });

      const { status, body } = await put(
        '/admin/api/ai/model',
        { model: 'https://evil.example.com/v1' },
        { token },
      );
      assert.equal(status, 400);
      assert.match(body.error, /letters, digits/);
      // The bad value must not be left on disk to be loaded at the next boot.
      assert.equal(runtimeSettings.values.aiModel, 'good/model');
    });

    it('does not let the base URL or key be set through this route', async () => {
      // The security boundary: a settable base URL would redirect the provider,
      // and the API key it sends, to a server of the caller's choosing.
      const before = await get('/admin/api/ai', { token });
      await put(
        '/admin/api/ai/model',
        { model: 'fine/model', baseUrl: 'https://evil.example.com', apiKey: 'sk-stolen' },
        { token },
      );
      const after = await get('/admin/api/ai', { token });

      assert.equal(after.body.baseUrl, before.body.baseUrl, 'base URL unchanged');
      assert.equal(after.body.model, 'fine/model', 'only the model moved');
    });

    it('clears the override and goes back to the environment', async () => {
      await put('/admin/api/ai/model', { model: 'temp/model' }, { token });
      const { status, body } = await put('/admin/api/ai/model', { model: null }, { token });

      assert.equal(status, 200);
      assert.equal(body.source, 'env');
      assert.equal(runtimeSettings.values.aiModel, null, 'the override file is cleared');
    });
  });
});
