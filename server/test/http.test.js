'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const { requestText } = require('../src/http');

/**
 * `requestText` exists because nitter.net answers the global fetch() with a
 * genuine 200 and an empty body while the same request over Node's own
 * http(s) module gets the real content — see its doc comment in src/http.js.
 * These tests can't reproduce that specific behavior (it needs the real
 * origin), but they pin the request/redirect/timeout logic that behavior
 * depends on, against a stand-in server, the way test/vehicles.test.js does
 * for its own endpoint.
 */
describe('requestText', () => {
  const servers = [];

  const startServer = (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
  };

  before(() => {
    process.env.NO_PROXY = '127.0.0.1,localhost';
  });

  after(() => {
    servers.forEach((server) => server.close());
  });

  it('resolves ok, status and body text for a plain 200', async () => {
    const base = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });

    const response = await requestText(`${base}/`, { timeoutMs: 2000 });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'hello');
  });

  it('reports ok: false without throwing on a non-2xx status', async () => {
    const base = await startServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    const response = await requestText(`${base}/missing`, { timeoutMs: 2000 });
    assert.equal(response.ok, false);
    assert.equal(response.status, 404);
  });

  it('follows a single redirect', async () => {
    const base = await startServer((req, res) => {
      if (req.url === '/from') {
        res.writeHead(302, { Location: '/to' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('landed');
    });

    const response = await requestText(`${base}/from`, { timeoutMs: 2000 });
    assert.equal(response.ok, true);
    assert.equal(response.text, 'landed');
  });

  it('does not follow a second redirect', async () => {
    const base = await startServer((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { Location: '/b' });
        res.end();
        return;
      }
      if (req.url === '/b') {
        res.writeHead(302, { Location: '/c' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('unreachable in one hop');
    });

    const response = await requestText(`${base}/a`, { timeoutMs: 2000 });
    assert.equal(response.status, 302);
    assert.equal(response.text, '');
  });

  it('rejects once the timeout elapses', async () => {
    const base = await startServer(() => {
      // Never respond — the client has to give up on its own.
    });

    await assert.rejects(() => requestText(`${base}/slow`, { timeoutMs: 50 }), /timed out/);
  });

  it('sends this project\'s user agent and any extra headers', async () => {
    let seen;
    const base = await startServer((req, res) => {
      seen = req.headers;
      res.writeHead(200);
      res.end('ok');
    });

    await requestText(`${base}/`, { timeoutMs: 2000, headers: { Accept: 'application/rss+xml' } });
    assert.match(seen['user-agent'], /wroclaw-mpk-map/);
    assert.equal(seen.accept, 'application/rss+xml');
  });
});
