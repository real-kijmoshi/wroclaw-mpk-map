'use strict';

const { XMLParser } = require('fast-xml-parser');

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout } = require('./http');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const stripHtml = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Pull line numbers out of a disruption message.
 *
 * The previous implementation matched every number in the text, so dates,
 * times and street numbers all became "affected lines". Matching against the
 * set of lines that actually exist in the timetable removes almost all of that
 * noise.
 *
 * @param {string} text
 * @param {Set<string>} knownLines
 * @returns {string[]}
 */
const extractAffectedLines = (text, knownLines) => {
  if (!text || !knownLines?.size) return [];

  const found = new Set();
  // Split on anything that cannot be part of a line name.
  const tokens = String(text).split(/[^0-9A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const candidate = token.toUpperCase();
    if (!knownLines.has(candidate)) continue;

    // A bare single letter is only a line when a transport word is nearby;
    // otherwise "A" from ordinary prose would match the express line A.
    if (/^[A-Z]$/.test(candidate)) {
      const context = tokens.slice(Math.max(0, i - 4), i).join(' ').toLowerCase();
      if (!/lini|autobus|tramwaj|kurs|zastępcz/.test(context)) continue;
    }

    found.add(candidate);
  }

  return [...found];
};

const toTimestamp = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

/** Parse an RSS 2.0 or Atom document into alert records. */
const parseFeed = (xml, sourceUrl) => {
  const document = parser.parse(xml);
  const channelItems = asArray(document?.rss?.channel?.item);
  const atomEntries = asArray(document?.feed?.entry);

  const items = channelItems.map((item) => ({
    id: String(item.guid?.['#text'] ?? item.guid ?? item.link ?? item.title ?? ''),
    title: stripHtml(item.title),
    content: stripHtml(item.description ?? item['content:encoded'] ?? item.title),
    url: typeof item.link === 'string' ? item.link : (item.link?.['@_href'] ?? null),
    timestamp: toTimestamp(item.pubDate ?? item.date ?? item['dc:date']),
  }));

  const entries = atomEntries.map((entry) => ({
    id: String(entry.id ?? entry.title ?? ''),
    title: stripHtml(entry.title?.['#text'] ?? entry.title),
    content: stripHtml(entry.summary?.['#text'] ?? entry.content?.['#text'] ?? entry.summary ?? entry.content ?? entry.title),
    url: asArray(entry.link).map((link) => link?.['@_href']).find(Boolean) ?? null,
    timestamp: toTimestamp(entry.updated ?? entry.published),
  }));

  return [...items, ...entries]
    .filter((item) => item.title || item.content)
    .map((item) => ({ ...item, source: sourceUrl }));
};

/** RSS/Atom provider — works without any API key. */
class FeedProvider {
  constructor(url) {
    this.url = url;
    this.name = `feed:${url}`;
  }

  async fetch() {
    const response = await fetchWithTimeout(this.url, {
      timeoutMs: config.alerts.timeoutMs,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return parseFeed(await response.text(), this.url);
  }
}

/**
 * X/Twitter provider.
 *
 * Reading another account's timeline is not available on the free API tier any
 * more, which is why the old hardcoded fetch silently returned nothing. It is
 * kept as an opt-in provider for anyone who has a paid bearer token.
 */
class TwitterProvider {
  constructor({ bearerToken, userId, username }) {
    this.bearerToken = bearerToken;
    this.userId = userId;
    this.username = username;
    this.name = 'twitter';
  }

  async fetch() {
    const url = `https://api.twitter.com/2/users/${this.userId}/tweets?max_results=50&tweet.fields=created_at`;
    const response = await fetchWithTimeout(url, {
      timeoutMs: config.alerts.timeoutMs,
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (response.status === 403 || response.status === 401) {
      throw new Error(
        `HTTP ${response.status} — the token cannot read timelines (paid X API access required)`,
      );
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const payload = await response.json();
    return (payload.data ?? []).map((tweet) => ({
      id: `tweet-${tweet.id}`,
      title: null,
      content: stripHtml(tweet.text),
      url: `https://x.com/${this.username}/status/${tweet.id}`,
      timestamp: toTimestamp(tweet.created_at),
      source: 'x.com',
    }));
  }
}

/**
 * Aggregates disruption notices from every configured provider.
 *
 * A provider that fails is reported on /health and skipped; the rest still
 * produce alerts.
 */
class AlertsService {
  constructor(getKnownLines) {
    this.getKnownLines = getKnownLines ?? (() => new Set());
    this.alerts = [];
    this.timer = null;
    this.providers = config.alerts.feeds.map((url) => new FeedProvider(url));

    if (config.alerts.twitter.bearerToken) {
      this.providers.push(new TwitterProvider(config.alerts.twitter));
    }

    this.status = {
      providers: this.providers.map((provider) => ({
        name: provider.name,
        lastSuccessAt: null,
        lastError: null,
        items: 0,
      })),
      lastRefreshAt: null,
      count: 0,
    };
  }

  async refresh() {
    const knownLines = this.getKnownLines();
    const collected = [];

    await Promise.all(
      this.providers.map(async (provider, index) => {
        const state = this.status.providers[index];
        try {
          const items = await provider.fetch();
          state.lastSuccessAt = new Date().toISOString();
          state.lastError = null;
          state.items = items.length;
          collected.push(...items);
        } catch (error) {
          state.lastError = error.message;
          logger.debug(`Alert provider ${provider.name} failed: ${error.message}`);
        }
      }),
    );

    const byId = new Map();
    for (const item of collected) {
      const id = item.id || `${item.source}:${item.timestamp}:${item.title ?? item.content}`;
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        title: item.title || null,
        content: item.content,
        url: item.url,
        timestamp: item.timestamp,
        source: item.source,
        affected: extractAffectedLines(`${item.title ?? ''} ${item.content ?? ''}`, knownLines),
      });
    }

    this.alerts = [...byId.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, config.alerts.maxItems);

    this.status.lastRefreshAt = new Date().toISOString();
    this.status.count = this.alerts.length;

    if (!this.alerts.length && this.providers.length) {
      logger.warn('No alerts available from any provider — check ALERT_FEED_URLS');
    }

    return this.alerts;
  }

  /**
   * @param {{ since?: number, line?: string }} options
   */
  getAlerts({ since = 0, line = null } = {}) {
    return this.alerts.filter(
      (alert) =>
        alert.timestamp >= since &&
        (!line || alert.affected.includes(String(line).toUpperCase())),
    );
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), config.alerts.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AlertsService, FeedProvider, TwitterProvider, extractAffectedLines, parseFeed, stripHtml };
