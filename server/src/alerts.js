'use strict';

const { XMLParser } = require('fast-xml-parser');

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout } = require('./http');
const { lineToType } = require('./lines');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const stripHtml = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const toTimestamp = (value, fallback = Date.now()) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Pull line numbers out of a disruption message.
 *
 * Matching against the set of lines that actually exist in the timetable is
 * what keeps dates, times and street numbers from being reported as affected
 * lines — the naive "every number in the text" version reported "22" and "00"
 * from "od godz. 22:00".
 *
 * @param {string} text
 * @param {Set<string>} knownLines
 * @returns {string[]}
 */
const extractAffectedLines = (text, knownLines) => {
  if (!text || !knownLines?.size) return [];

  const found = new Set();
  const tokens = String(text).split(/[^0-9A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/);

  for (let i = 0; i < tokens.length; i += 1) {
    const candidate = tokens[i]?.toUpperCase();
    if (!candidate || !knownLines.has(candidate)) continue;

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

/** Parse an RSS 2.0 or Atom document into alert records. */
const parseFeed = (xml, sourceUrl) => {
  let document;
  try {
    document = parser.parse(xml);
  } catch {
    return [];
  }

  const items = asArray(document?.rss?.channel?.item).map((item) => ({
    id: String(item.guid?.['#text'] ?? item.guid ?? item.link ?? item.title ?? ''),
    title: stripHtml(item.title),
    content: stripHtml(item.description ?? item['content:encoded'] ?? item.title),
    url: typeof item.link === 'string' ? item.link : (item.link?.['@_href'] ?? null),
    timestamp: toTimestamp(item.pubDate ?? item.date ?? item['dc:date']),
  }));

  const entries = asArray(document?.feed?.entry).map((entry) => ({
    id: String(entry.id ?? entry.title ?? ''),
    title: stripHtml(entry.title?.['#text'] ?? entry.title),
    content: stripHtml(
      entry.summary?.['#text'] ?? entry.content?.['#text'] ?? entry.summary ?? entry.content ?? entry.title,
    ),
    url: asArray(entry.link).map((link) => link?.['@_href']).find(Boolean) ?? null,
    timestamp: toTimestamp(entry.updated ?? entry.published),
  }));

  return [...items, ...entries]
    .filter((item) => item.title || item.content)
    .map((item) => ({ ...item, source: sourceUrl }));
};

/** Words that mark a link as a service notice rather than site furniture. */
const NOTICE_WORDS =
  /(lini[aei]|tramwaj|autobus|objazd|zmian|utrudnien|komunikat|awari|remont|wyłącz|zamknię|kursow|przystan)/i;

/** Nav and footer links that would otherwise pass the keyword test. */
const CHROME_WORDS = /^(menu|nawigacja|strona główna|kontakt|polityka|cookies|zobacz wszystkie)$/i;

const DATE_PATTERN = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/;

const polishDate = (text) => {
  const match = DATE_PATTERN.exec(text ?? '');
  if (!match) return null;
  const [, day, month, year] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Scrape service notices out of an HTML page.
 *
 * MPK publishes disruptions as web pages and nothing else — there is no API,
 * and the X timeline the old code read has needed a paid tier since 2023, which
 * is why `/alerts` quietly returned `[]` for a year.
 *
 * Deliberately shape-agnostic, for the same reason the feed listing parser is:
 * it walks anchors and keeps the ones whose text reads like a notice, rather
 * than depending on class names that will be renamed in the next redesign. It
 * will still break eventually — this is the most fragile code in the server —
 * so failures surface in /health under `alerts.providers[].lastError`.
 *
 * @param {string} html
 * @param {string} pageUrl used to resolve relative links
 */
const parsePage = (html, pageUrl) => {
  if (typeof html !== 'string' || !html.includes('<')) return [];

  const results = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1];
    const title = stripHtml(match[2]);

    if (!title || title.length < 12 || title.length > 220) continue;
    if (CHROME_WORDS.test(title)) continue;
    if (!NOTICE_WORDS.test(title)) continue;
    if (/^(#|javascript:|mailto:)/i.test(href)) continue;

    let url;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);

    // Look just past the link for a date and a lead paragraph; these pages
    // print both next to the headline. Falling back to "now" for the date keeps
    // undated notices visible rather than dropping them.
    // Stop at the next link. Each notice on these pages begins with its own
    // headline link, so that is where this one's text ends — a fixed-size
    // window instead runs into the following notice and appends its body to
    // this one.
    const rest = html.slice(match.index + match[0].length);
    const nextLink = rest.search(/<a\b/i);
    const after = rest.slice(0, nextLink === -1 ? 600 : Math.min(nextLink, 600));
    const trailing = stripHtml(after);
    const published = polishDate(`${title} ${trailing}`);

    // Only keep the trailing text when it adds something; on a bare link list
    // it is the next headline, which would read as this one's description.
    const lead = trailing.length > 40 ? trailing.slice(0, 240).trim() : null;

    results.push({
      id: url,
      title,
      content: lead ?? title,
      url,
      timestamp: published ?? Date.now(),
      source: pageUrl,
    });
  }

  return results;
};

/**
 * One upstream page of notices.
 *
 * Auto-detects the format: if the response parses as RSS or Atom with items it
 * is read as a feed, otherwise it is scraped as HTML. That means a site can add
 * or drop a feed without any change here.
 */
class NoticeProvider {
  constructor(url) {
    this.url = url;
    this.name = url;
  }

  async fetch() {
    const response = await fetchWithTimeout(this.url, {
      timeoutMs: config.alerts.timeoutMs,
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const body = await response.text();
    const feedItems = parseFeed(body, this.url);
    if (feedItems.length) return feedItems;

    const scraped = parsePage(body, this.url);
    if (!scraped.length) throw new Error('no notices found — page markup probably changed');
    return scraped;
  }
}

/**
 * Aggregates disruption notices from every configured page.
 *
 * Fails soft: a provider that throws keeps the previous alert list in place and
 * records why in `status`. A stale list is better than an empty one, and
 * `/health` says which it is.
 */
class AlertsService {
  constructor(getKnownLines) {
    this.getKnownLines = getKnownLines ?? (() => new Set());
    this.alerts = [];
    this.timer = null;
    this.providers = config.alerts.pages.map((url) => new NoticeProvider(url));

    this.status = {
      providers: this.providers.map((provider) => ({
        name: provider.name,
        lastSuccessAt: null,
        lastError: null,
        items: 0,
      })),
      lastRefreshAt: null,
      lastError: null,
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

    this.status.lastRefreshAt = new Date().toISOString();
    this.status.lastError =
      this.status.providers.find((provider) => provider.lastError)?.lastError ?? null;

    // Every provider failed: keep whatever we last had rather than blanking the
    // screen, and let /health explain the staleness.
    if (!collected.length) {
      if (this.alerts.length) {
        logger.warn('No alert provider responded; keeping the previous list');
      } else if (this.providers.length) {
        logger.warn('No alerts available from any provider — check ALERT_PAGE_URLS');
      }
      return this.alerts;
    }

    const byId = new Map();
    for (const item of collected) {
      const id = item.id || `${item.source}:${item.timestamp}:${item.title ?? item.content}`;
      if (byId.has(id)) continue;

      const affected = extractAffectedLines(`${item.title ?? ''} ${item.content ?? ''}`, knownLines);
      // Clients colour line badges by type; without this they would all have to
      // re-implement the categorisation rules and drift out of sync with them.
      const types = {};
      for (const line of affected) types[line] = lineToType(line);

      byId.set(id, {
        id,
        title: item.title || null,
        content: item.content,
        url: item.url,
        timestamp: item.timestamp,
        source: item.source,
        affected,
        types,
      });
    }

    this.alerts = [...byId.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, config.alerts.maxItems);
    this.status.count = this.alerts.length;

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

module.exports = {
  AlertsService,
  NoticeProvider,
  extractAffectedLines,
  parseFeed,
  parsePage,
  stripHtml,
};
