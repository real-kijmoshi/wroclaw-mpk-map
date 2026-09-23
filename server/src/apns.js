'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http2 = require('node:http2');

/**
 * A minimal APNs client for Live Activity updates: token-based auth (an ES256
 * JWT signed with the operator's .p8 key) over one reused HTTP/2 session.
 *
 * Deliberately small — no dependency — because it sends exactly one kind of
 * push. Apple asks that the auth token be reused for between 20 and 60 minutes
 * rather than minted per request, and that the connection be kept open rather
 * than reopened per push; both are done here.
 */

const PRODUCTION = 'https://api.push.apple.com';
const SANDBOX = 'https://api.sandbox.push.apple.com';
/** Apple rejects tokens older than an hour and throttles fresher ones; 50 min sits between. */
const TOKEN_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const base64url = (input) => Buffer.from(input).toString('base64url');

class ApnsClient {
  /**
   * @param {{ keyId: string, teamId: string, privateKey?: string, privateKeyPath?: string,
   *   production?: boolean, origin?: string }} options
   */
  constructor({ keyId, teamId, privateKey = '', privateKeyPath = '', production = true, origin = '' }) {
    this.keyId = keyId;
    this.teamId = teamId;
    this.origin = origin || (production ? PRODUCTION : SANDBOX);
    this.key = null;
    this.error = null;
    try {
      const pem = privateKey || (privateKeyPath ? fs.readFileSync(privateKeyPath, 'utf8') : '');
      // Env files often carry the PEM on one line with literal "\n".
      if (pem) this.key = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
    } catch (error) {
      this.error = `APNs key unreadable: ${error.message}`;
    }
    this.token = null;
    this.tokenAt = 0;
    this.session = null;
  }

  get configured() {
    return Boolean(this.key && this.keyId && this.teamId);
  }

  #authToken(now = Date.now()) {
    if (this.token && now - this.tokenAt < TOKEN_TTL_MS) return this.token;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) }));
    const signature = crypto
      .sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.key, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    this.token = `${header}.${claims}.${signature}`;
    this.tokenAt = now;
    return this.token;
  }

  #connect() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    this.session = http2.connect(this.origin);
    this.session.on('error', () => {
      // A dropped connection is reopened on the next push.
      this.session = null;
    });
    this.session.on('goaway', () => {
      this.session = null;
    });
    // Idle between polls must not keep a test or a shutdown alive.
    this.session.unref?.();
    return this.session;
  }

  /**
   * Send one push. Resolves `{ status, reason }`; never throws for an APNs
   * answer, only for a missing key.
   */
  send(deviceToken, payload, { topic, pushType = 'liveactivity', priority = 10 } = {}) {
    if (!this.configured) throw new Error('APNs is not configured');
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let request;
      try {
        request = this.#connect().request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${this.#authToken()}`,
          'apns-topic': topic,
          'apns-push-type': pushType,
          'apns-priority': String(priority),
          'content-type': 'application/json',
        });
      } catch (error) {
        this.session = null;
        done({ status: 0, reason: error.message });
        return;
      }
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.close();
        done({ status: 0, reason: 'timeout' });
      });
      let status = 0;
      let body = '';
      request.on('response', (headers) => {
        status = Number(headers[':status']) || 0;
      });
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let reason = null;
        try {
          reason = body ? JSON.parse(body).reason ?? null : null;
        } catch {
          reason = body || null;
        }
        done({ status, reason });
      });
      request.on('error', (error) => done({ status: 0, reason: error.message }));
      request.end(JSON.stringify(payload));
    });
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}

module.exports = { ApnsClient, PRODUCTION, SANDBOX };
