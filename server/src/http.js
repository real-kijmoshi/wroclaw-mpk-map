'use strict';

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

module.exports = { fetchWithTimeout, tryEachSource };
