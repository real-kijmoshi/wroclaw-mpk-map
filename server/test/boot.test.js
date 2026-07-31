'use strict';

/**
 * Boots the real entry point.
 *
 * The rest of the suite builds the Express app directly, so nothing covered
 * `start()` — and a stale reference in its startup log crashed the process
 * immediately after the socket opened, which every other test happily passed
 * through. This exercises the actual boot path.
 *
 * Env has to be set before requiring anything, because config reads it once.
 */

process.env.PORT = '0';
process.env.GTFS_URLS = 'http://127.0.0.1:1/never-answers.zip';
process.env.GTFS_USE_CACHE = 'false';
process.env.ALERT_PAGE_URLS = 'http://127.0.0.1:1/none';
process.env.VEHICLE_POSITION_URLS = 'http://127.0.0.1:1/none';
process.env.LOG_LEVEL = 'silent';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { start, stopBackgroundWork } = require('../index');

describe('server boot', () => {
  let server;
  let base;

  before(async () => {
    server = start();
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    // Leaving the cron task running keeps the event loop alive and the test
    // process never exits.
    stopBackgroundWork();
    server?.close();
  });

  it('starts listening before the timetable is available', () => {
    assert.ok(server.listening);
  });

  it('serves /health while the feed is still unreachable', async () => {
    const response = await fetch(`${base}/health`);
    // 503 is correct here: the process is up, the data is not.
    assert.equal(response.status, 503);

    const body = await response.json();
    assert.equal(body.status, 'starting');
    assert.ok(['loading', 'failed'].includes(body.gtfs.state), body.gtfs.state);
  });

  it('answers the index route without any data loaded', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).endpoints));
  });
});
