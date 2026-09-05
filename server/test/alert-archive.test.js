'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { AlertArchive } = require('../src/alert-archive');
const { AlertsService } = require('../src/alerts');

const KNOWN = new Set(['4', '10', '128']);
const LONG = 'Tramwaje linii 4 kursują objazdem przez ulicę Zieloną od poniedziałku rano';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alert-archive-')), 'alert-archive.json');

const alert = (overrides = {}) => ({
  id: 'a1',
  title: null,
  content: LONG,
  url: 'https://x.com/AlertMPK/status/1',
  timestamp: Date.now(),
  source: 'x-bridge:@AlertMPK',
  affected: ['4'],
  types: { 4: 'tram' },
  ...overrides,
});

const provider = (items) => ({ name: 'bridge', async fetch() { return items; } });

const noAi = {
  aiProvider: { enabled: false, name: 'off', status: { reason: 'disabled in test' } },
};

describe('AlertArchive', () => {
  it('round-trips alerts and the AI cache', () => {
    const file = tmpFile();
    const archive = new AlertArchive({ file });
    const cache = new Map([['group-key', { incidents: [{ id: 'i1' }], expiresAt: Date.now() + 60000 }]]);

    archive.save({ alerts: [alert()], aiCache: cache });
    const loaded = new AlertArchive({ file }).load();

    assert.equal(loaded.alerts.length, 1);
    assert.equal(loaded.alerts[0].content, LONG);
    assert.deepEqual(loaded.alerts[0].affected, ['4']);
    assert.equal(loaded.aiCache.length, 1, 'the cache is what stops the AI being re-billed');
    assert.equal(loaded.aiCache[0][0], 'group-key');
  });

  it('drops alerts older than the retention window', () => {
    const file = tmpFile();
    const now = Date.now();
    const day = 86400000;
    const archive = new AlertArchive({ file, daysToKeep: 7 });

    archive.save(
      {
        alerts: [alert({ id: 'fresh', timestamp: now - day }), alert({ id: 'stale', timestamp: now - 30 * day })],
        aiCache: new Map(),
      },
      now,
    );

    const loaded = archive.load(now);
    assert.deepEqual(loaded.alerts.map((entry) => entry.id), ['fresh']);
  });

  it('drops an expired cache entry rather than serving a stale narrative', () => {
    const file = tmpFile();
    const now = Date.now();
    const archive = new AlertArchive({ file });

    archive.save(
      {
        alerts: [],
        aiCache: new Map([
          ['live', { incidents: [], expiresAt: now + 60000 }],
          ['dead', { incidents: [], expiresAt: now - 60000 }],
        ]),
      },
      now,
    );

    assert.deepEqual(archive.load(now).aiCache.map(([key]) => key), ['live']);
  });

  it('treats a corrupt or missing file as empty rather than throwing', () => {
    const file = tmpFile();
    assert.deepEqual(new AlertArchive({ file }).load(), { alerts: [], aiCache: [] });

    fs.writeFileSync(file, '{ this is not json');
    assert.deepEqual(new AlertArchive({ file }).load(), { alerts: [], aiCache: [] });
  });

  it('does not throw when the file cannot be written', () => {
    // A directory where the file should be: writing fails, the refresh must not.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-archive-ro-'));
    const file = path.join(dir, 'blocked.json');
    fs.mkdirSync(file);

    const result = new AlertArchive({ file }).save({ alerts: [alert()], aiCache: new Map() });
    assert.equal(result.ok, false);
  });
});

describe('AlertsService across a restart', () => {
  it('serves the previous run\'s alerts before the first refresh lands', async () => {
    const file = tmpFile();

    const first = new AlertsService(() => KNOWN, [provider([alert()])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    await first.refresh();
    assert.equal(first.alerts.length, 1);

    // A second service on the same file, as a restart would be. restore() is
    // what start() calls; the point is that /alerts answers before any network
    // request has happened.
    const second = new AlertsService(() => KNOWN, [provider([])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    second.restore();

    assert.equal(second.getAlerts().length, 1, 'warm from the first request');
    assert.equal(second.getIncidents().length, 1, '/incidents too, not just /alerts');
    assert.equal(second.status.count, 1);
  });

  it('keeps a post that has scrolled off the bridge window', async () => {
    // The bridge only ever returns its last N posts. Without the archive,
    // anything older vanished from /alerts the moment it fell off.
    const file = tmpFile();
    const older = alert({ id: 'older', content: LONG, timestamp: Date.now() - 3600000 });
    const newer = alert({
      id: 'newer',
      content: 'Awaria tramwaju na Świdnickiej wstrzymała ruch w obu kierunkach dzisiaj',
      timestamp: Date.now(),
    });

    const first = new AlertsService(() => KNOWN, [provider([older])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    await first.refresh();

    const second = new AlertsService(() => KNOWN, [provider([newer])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    second.restore();
    const result = await second.refresh();

    assert.deepEqual(
      result.map((entry) => entry.id).sort(),
      ['newer', 'older'],
      'the post the bridge forgot is still served',
    );
  });

  it('does not duplicate an alert the bridge keeps returning', async () => {
    const file = tmpFile();
    const repeated = alert({ id: 'same' });

    const first = new AlertsService(() => KNOWN, [provider([repeated])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    await first.refresh();
    await first.refresh();
    assert.equal(first.alerts.length, 1, 'a repeated post does not accumulate');

    const second = new AlertsService(() => KNOWN, [provider([repeated])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    second.restore();
    assert.equal((await second.refresh()).length, 1, 'nor does it after a restart');
  });

  it('keeps the original URL when a restored alert is seen again', async () => {
    const file = tmpFile();
    const original = alert({ id: 'x', url: 'https://x.com/AlertMPK/status/original' });

    const first = new AlertsService(() => KNOWN, [provider([original])], {
      ...noAi,
      archive: new AlertArchive({ file }),
    });
    await first.refresh();

    const second = new AlertsService(
      () => KNOWN,
      [provider([{ ...original, id: 'y', url: 'https://x.com/AlertMPK/status/copy' }])],
      { ...noAi, archive: new AlertArchive({ file }) },
    );
    second.restore();
    const [merged] = await second.refresh();

    assert.equal(merged.url, 'https://x.com/AlertMPK/status/original', 'history is the original');
  });

  it('ages history out rather than growing forever', async () => {
    const file = tmpFile();
    const ancient = alert({ id: 'ancient', timestamp: Date.now() - 60 * 86400000 });

    new AlertArchive({ file, daysToKeep: 31 }).save({ alerts: [ancient], aiCache: new Map() });

    const service = new AlertsService(() => KNOWN, [provider([])], {
      ...noAi,
      archive: new AlertArchive({ file, daysToKeep: 31 }),
    });
    service.restore();

    assert.equal(service.getAlerts().length, 0, 'a two-month-old notice is not news');
  });

  it('works with no archive at all', async () => {
    const service = new AlertsService(() => KNOWN, [provider([alert()])], noAi);
    service.restore();
    assert.equal((await service.refresh()).length, 1);
  });
});
