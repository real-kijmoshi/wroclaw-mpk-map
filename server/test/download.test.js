'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');

const config = require('../src/config');
const { assertComplete } = require('../src/gtfs/archive');
const { isInForce } = require('../src/gtfs/archive');
const { downloadGtfs } = require('../src/gtfs/download');
const { buildFixtureZip } = require('./fixtures/gtfs');

describe('GTFS download with bare portal file ids', () => {
  it('chooses the latest effective complete archive, not the first upload', async () => {
    const archives = {
      130: buildFixtureZip({ feedDates: { start: '20260829', end: '20260920' } }),
      136: buildFixtureZip({ feedDates: { start: '20260919', end: '20261004' } }),
      135: buildFixtureZip({
        feedDates: { start: '20260925', end: '20261010' },
        omit: ['shapes'],
      }),
    };
    const server = http.createServer((req, res) => {
      if (req.url === '/od2/6/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 6, active: true, pliki: [130, 136, 135] }));
        return;
      }
      const id = /^\/hdb\/download\/(\d+)\/$/.exec(req.url)?.[1];
      if (id && archives[id]) {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(archives[id]);
        return;
      }
      res.writeHead(404).end();
    });
    const original = { ...config.gtfs };
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      Object.assign(config.gtfs, {
        catalogueUrl: `${base}/od2/6/`,
        downloadBase: `${base}/hdb/download`,
        ckanHosts: [],
        mirrors: [],
        overrideUrls: [],
        maxFileLookups: 3,
        maxIdDownloads: 3,
        maxCandidates: 3,
        useCache: false,
      });

      const result = await downloadGtfs({
        validate: assertComplete,
        prefer: isInForce,
        now: Date.parse('2026-09-19T12:00:00+02:00'),
      });
      assert.match(result.source, /\/136\/$/);
      assert.equal(result.effectiveStart, '20260919');
      assert.equal(result.effectiveEnd, '20261004');
      assert.equal(result.fromCache, false);
    } finally {
      Object.assign(config.gtfs, original);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
