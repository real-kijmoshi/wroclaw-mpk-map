'use strict';

/**
 * Feed discovery against a stand-in for the city's data API.
 *
 * Modelled on the real thing: `/od2/6/` answers with a bare list of file ids
 * and every id has to be resolved separately. Captured 2026-07-31.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const config = require('../src/config');
const { fileIdsFrom, resolveFeedCandidates } = require('../src/gtfs/catalogue');

// The three files the portal showed as most recently published, in the order
// the real `pliki` array gives them.
const FILES = {
  119: { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_25072026', rozszerzenie: 'zip' },
  117: { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_18072026', rozszerzenie: 'zip' },
  121: { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_01082026', rozszerzenie: 'zip' },
  114: { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_13072026', rozszerzenie: 'zip' },
};

describe('resolveFeedCandidates against the two-step data API', () => {
  let server;
  const original = { ...config.gtfs };

  before(async () => {
    process.env.NO_PROXY = '127.0.0.1,localhost';

    server = http.createServer((req, res) => {
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.url === '/od2/6/') {
        // The real shape: ids only, newest upload first, no names or urls.
        return json({ id: 6, active: true, pliki: [119, 117, 121, 114] });
      }

      const match = /^\/od2\/6\/(\d+)\/$/.exec(req.url);
      if (match && FILES[match[1]]) return json(FILES[match[1]]);

      res.writeHead(404).end('{}');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const base = `http://127.0.0.1:${server.address().port}`;
    config.gtfs.catalogueUrl = `${base}/od2/6/`;
    config.gtfs.downloadBase = `${base}/hdb/download`;
    config.gtfs.ckanHosts = [];
    config.gtfs.mirrors = [];
    config.gtfs.overrideUrls = [];
  });

  after(() => {
    Object.assign(config.gtfs, original);
    server?.close();
  });

  it('reads bare file ids out of the dataset payload', () => {
    assert.deepEqual(
      fileIdsFrom({ id: 6, active: true, pliki: [119, 117, 121] }),
      [119, 117, 121],
    );
    assert.deepEqual(fileIdsFrom({ id: 6, active: true }), []);
    assert.deepEqual(fileIdsFrom(null), []);
  });

  it('resolves each id and serves the timetable in force, not the newest', async () => {
    // 2026-07-31: GTFS_01082026 exists but does not take effect until tomorrow.
    const candidates = await resolveFeedCandidates({ now: Date.UTC(2026, 6, 31) });

    assert.equal(candidates[0].name, 'OtwartyWroclaw_rozklad_jazdy_GTFS_25072026');
    assert.deepEqual(
      candidates.map((candidate) => candidate.name),
      [
        'OtwartyWroclaw_rozklad_jazdy_GTFS_25072026',
        'OtwartyWroclaw_rozklad_jazdy_GTFS_18072026',
        'OtwartyWroclaw_rozklad_jazdy_GTFS_13072026',
        'OtwartyWroclaw_rozklad_jazdy_GTFS_01082026',
      ],
    );
  });

  it('rolls onto the August snapshot the day it takes effect', async () => {
    const candidates = await resolveFeedCandidates({ now: Date.UTC(2026, 7, 1) });
    assert.equal(candidates[0].name, 'OtwartyWroclaw_rozklad_jazdy_GTFS_01082026');
  });

  it('builds a download url for metadata that carries none', async () => {
    const [first] = await resolveFeedCandidates({ now: Date.UTC(2026, 6, 31) });
    assert.match(first.url, /\/hdb\/download\/119\/$/);
  });
});
