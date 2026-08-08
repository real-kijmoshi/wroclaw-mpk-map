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
 * `onResult` is called for every individual attempt — ok with the value, or
 * failure with the error — so a caller can track per-source health across
 * polls without the function itself holding state.
 *
 * @param {string[]} urls candidate URLs, highest priority first
 * @param {(url: string) => Promise<T>} attempt
 * @param {{ label?: string, onResult?: (result: { url: string, ok: boolean, value?: T, error?: Error }) => void }} options
 * @returns {Promise<{ url: string, value: T }>}
 * @template T
 */
const tryEachSource = async (urls, attempt, { label = 'source', onResult } = {}) => {
  const errors = [];

  for (const url of urls) {
    try {
      const value = await attempt(url);
      onResult?.({ url, ok: true, value });
      return { url, value };
    } catch (error) {
      onResult?.({ url, ok: false, error });
      errors.push(`${url}: ${error.message}`);
      logger.warn(`${label} unavailable at ${url} — ${error.message}`);
    }
  }

  const detail = errors.length ? `\n  - ${errors.join('\n  - ')}` : '';
  throw new Error(`All ${label} candidates failed${detail}`);
};

/**
 * Per-URL health of a candidate source list, so a repeatedly failing source
 * stops costing a timeout on every poll while a preferred primary can still
 * recover through periodic probes.
 *
 * State is bounded: one small record per configured URL, no history.
 */
class SourceHealth {
  /**
   * @param {string[]} urls candidate URLs, highest priority first
   * @param {{ backoffThreshold?: number, probeIntervalPolls?: number, maxBackoffPolls?: number }} options
   */
  constructor(
    urls,
    { backoffThreshold = 3, probeIntervalPolls = 6, maxBackoffPolls = 30 } = {},
  ) {
    this.backoffThreshold = backoffThreshold;
    this.probeIntervalPolls = probeIntervalPolls;
    this.maxBackoffPolls = maxBackoffPolls;
    this.urls = [];
    this.byUrl = new Map();
    /** The most recently successful URL, tried first while it stays healthy. */
    this.lastGoodUrl = null;
    this.pollCount = 0;
    this.probeIndex = 0;
    this.lastProbePoll = -probeIntervalPolls;
    this.sync(urls);
  }

  /** Adopt the currently configured list; state for removed URLs is dropped. */
  sync(urls) {
    this.urls = [...urls];
    for (const url of this.byUrl.keys()) {
      if (!this.urls.includes(url)) this.byUrl.delete(url);
    }
    for (const url of this.urls) {
      if (!this.byUrl.has(url)) {
        this.byUrl.set(url, {
          url,
          consecutiveFailures: 0,
          backoffUntilPoll: 0,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastError: null,
        });
      }
    }
  }

  recordSuccess(url) {
    const state = this.byUrl.get(url);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.backoffUntilPoll = 0;
    state.lastSuccessAt = new Date().toISOString();
    state.lastAttemptAt = state.lastSuccessAt;
    state.lastError = null;
    this.lastGoodUrl = url;
  }

  recordFailure(url, error) {
    const state = this.byUrl.get(url);
    if (!state) return;
    state.consecutiveFailures += 1;
    state.lastError = error?.message ?? String(error);
    state.lastAttemptAt = new Date().toISOString();
    if (state.consecutiveFailures >= this.backoffThreshold) {
      // Backoff grows with each extra failure but is capped, so a dead source
      // is probed every so often rather than never.
      const extra = state.consecutiveFailures - this.backoffThreshold;
      const polls = Math.min(this.backoffThreshold * 2 ** extra, this.maxBackoffPolls);
      state.backoffUntilPoll = this.pollCount + polls;
    }
  }

  #inBackoff(url) {
    const state = this.byUrl.get(url);
    return state ? state.backoffUntilPoll > this.pollCount : false;
  }

  /** Which source to exercise on a probe cycle, or null when none is due. */
  #probeTarget() {
    // A primary that is not already the active source is probed first so it
    // can be preferred again the moment it recovers.
    const primary = this.urls[0];
    if (primary && primary !== this.lastGoodUrl) return primary;
    const candidates = this.urls.filter(
      (url) => url !== this.lastGoodUrl && this.#inBackoff(url),
    );
    if (!candidates.length) return null;
    return candidates[this.probeIndex++ % candidates.length];
  }

  /**
   * Which URLs to attempt on the next poll, in priority order.
   *
   * The last good source is tried first so a poll never waits on a known-dead
   * source. Sources in backoff are skipped except on a probe cycle, and a probe
   * target goes first so it is actually exercised even while a fallback is
   * healthy.
   */
  plan() {
    this.pollCount += 1;

    const ordered = this.lastGoodUrl
      ? [this.lastGoodUrl, ...this.urls.filter((url) => url !== this.lastGoodUrl)]
      : [...this.urls];

    let probeTarget = null;
    if (this.pollCount - this.lastProbePoll >= this.probeIntervalPolls) {
      probeTarget = this.#probeTarget();
      this.lastProbePoll = this.pollCount;
    }

    const attempts = probeTarget
      ? [probeTarget, ...ordered.filter((url) => url !== probeTarget)]
      : ordered;

    const filtered = attempts.filter((url) => url === probeTarget || !this.#inBackoff(url));
    if (!filtered.length) {
      // Every source is in backoff and no probe is due — something still has
      // to be tried, and the most recently good source is the best guess.
      if (this.lastGoodUrl) filtered.push(this.lastGoodUrl);
      else filtered.push(...this.urls);
    }

    return filtered;
  }

  /** Compact per-URL view for /health. */
  snapshot() {
    return this.urls.map((url) => {
      const state = this.byUrl.get(url);
      return {
        url,
        lastSuccessAt: state.lastSuccessAt,
        lastAttemptAt: state.lastAttemptAt,
        consecutiveFailures: state.consecutiveFailures,
        backoff: state.backoffUntilPoll > this.pollCount,
        lastError: state.lastError,
      };
    });
  }
}

module.exports = { fetchWithTimeout, requestText, tryEachSource, SourceHealth };
