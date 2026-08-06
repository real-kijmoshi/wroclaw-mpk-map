'use strict';

const http = require('node:http');
const https = require('node:https');

const config = require('./config');
const logger = require('./logger');

/**
 * fetch() with a timeout. Node 18+ ships an undici-backed global fetch, so no
 * HTTP client dependency is needed.
 */
const fetchWithTimeout = async (url, { timeoutMs = 15_000, ...init } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': config.userAgent,
        'Accept-Encoding': 'gzip, deflate',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A GET request over Node's own http(s) module instead of the global
 * fetch() (undici).
 *
 * Exists for one confirmed reason: nitter.net answers fetch() with a genuine
 * `200` and an empty body — no Content-Type, no other response headers a
 * real hit carries — while the exact same request over this module, or curl,
 * or a browser, gets the full feed. Every header this project sends was
 * identical between the two; the only variable left is the client itself, so
 * this reads as the origin fingerprinting undici specifically (a known
 * pattern for sites hardened against scraping) rather than anything about
 * the request. `fetchWithTimeout` above is unaffected for every other
 * upstream this project talks to and should stay the default; reach for this
 * only where a source has demonstrated the same silent-empty-body behavior.
 *
 * Follows at most one redirect — enough for a Nitter instance moving
 * http -> https or bare -> www, not a general-purpose redirect chain.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string, string>, redirectsLeft?: number }} options
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, text: string }>}
 */
const requestText = (url, { timeoutMs = 15_000, headers = {}, redirectsLeft = 1 } = {}) =>
  new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'http:' ? http : https;

    const request = client.get(
      url,
      { headers: { 'User-Agent': config.userAgent, ...headers } },
      (response) => {
        const { statusCode, statusMessage, headers: responseHeaders } = response;

        if (statusCode >= 300 && statusCode < 400 && responseHeaders.location && redirectsLeft > 0) {
          response.resume();
          const next = new URL(responseHeaders.location, url).toString();
          resolve(requestText(next, { timeoutMs, headers, redirectsLeft: redirectsLeft - 1 }));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText: statusMessage,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)));
  });

/**
 * Try each candidate URL in order until one produces a usable result.
 *
 * Upstream endpoints for Wrocław data have moved more than once, so rather than
 * hardcoding a single URL every source is a prioritised list. The URL that
 * worked is returned so it can be surfaced on /health and preferred next time.
 *
 * @param {string[]} urls candidate URLs, highest priority first
 * @param {(url: string) => Promise<T>} attempt
 * @param {{ label?: string }} options
 * @returns {Promise<{ url: string, value: T }>}
 * @template T
 */
const tryEachSource = async (urls, attempt, { label = 'source' } = {}) => {
  const errors = [];

  for (const url of urls) {
    try {
      const value = await attempt(url);
      return { url, value };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      logger.warn(`${label} unavailable at ${url} — ${error.message}`);
    }
  }

  const detail = errors.length ? `\n  - ${errors.join('\n  - ')}` : '';
  throw new Error(`All ${label} candidates failed${detail}`);
};

module.exports = { fetchWithTimeout, requestText, tryEachSource };
