'use strict';

const { XMLParser } = require('fast-xml-parser');

const config = require('./config');
const { buildIncidentsFromAlerts, createFallbackIncidents } = require('./ai-incidents');
const { createAiProvider } = require('./ai-provider');
const logger = require('./logger');
const { fetchWithTimeout, requestText } = require('./http');
const { lineToType } = require('./lines');
const { stripHtml } = require('./html');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const toTimestamp = (value, fallback = Date.now()) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Polish date expressions to strip before hunting for line numbers.
 *
 * Matches numeric dates (25.07.2026), "D <month>" phrases (6 lipca,
 * 1 sierpnia), and "D1 - D2 <month>" ranges (11 - 16 lipca). All three forms
 * put a bare day-of-month number next to the surrounding text, and Wrocław
 * has real lines numbered 1, 6, 11 and 21 — "Od 6 lipca", "21.07.2026" and
 * "(11 - 16 lipca)" all produced a phantom line badge on an otherwise
 * correctly filtered notice, because the day happened to collide with a real
 * line. The range form has to come first in the alternation: at the start of
 * "11 - 16 lipca" the single-day pattern would match just "11" and stop,
 * leaving the range's opening number unstripped. Matching against known
 * lines alone cannot catch any of this: the number really is a valid line
 * number, just not the one in this sentence.
 */
const POLISH_DATE =
  /\b\d{1,2}\s*(?:[-–—]|do)\s*\d{1,2}\s+(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze[śs]nia|pa[źz]dziernika|listopada|grudnia)\b|\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\b\d{1,2}\s+(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrze[śs]nia|pa[źz]dziernika|listopada|grudnia)\b/gi;

/**
 * Pull line numbers out of a disruption message.
 *
 * Matching against the set of lines that actually exist in the timetable is
 * what keeps dates, times and street numbers from being reported as affected
 * lines — the naive "every number in the text" version reported "22" and "00"
 * from "od godz. 22:00". Dates are stripped first (see POLISH_DATE) because a
 * day-of-month can itself be a real line number.
 *
 * @param {string} text
 * @param {Set<string>} knownLines
 * @returns {string[]}
 */
const extractAffectedLines = (text, knownLines) => {
  if (!text || !knownLines?.size) return [];

  const found = new Set();
  const withoutDates = String(text).replace(POLISH_DATE, ' ');
  const tokens = withoutDates.split(/[^0-9A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+/);

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

/**
 * Normalize alert text for cross-source fingerprinting.
 *
 * Same incident, different source/URL/ID must still match — so this lowercases,
 * drops URLs, trims a leading mechanical hashtag/mention (e.g. `#AlertMPK`),
 * maps smart punctuation to ASCII, and collapses whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
const normalizeText = (text) => {
  let result = String(text ?? '').toLowerCase();
  result = result.replace(/https?:\/\/\S+/g, ' ');
  result = result.replace(/^[@#]\w+\s+/, '');
  result = result
    .replace(/[‘’]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[…]/g, '...');
  result = result.replace(/[^\p{L}\p{N}\s\-']/gu, ' ');
  result = result.replace(/\s+/g, ' ').trim();
  return result;
};

/**
 * Build a dedup fingerprint from an alert's title and content.
 *
 * Only returns non-null when the normalized text is >= 30 characters — short
 * alerts must stay separate unless their IDs are identical, because a two-word
 * headline is likely to recur across unrelated incidents.
 *
 * @param {string|null} title
 * @param {string} content
 * @returns {string|null}
 */
const fingerprint = (title, content) => {
  const text = normalizeText(`${title ?? ''} ${content ?? ''}`);
  return text.length >= 30 ? text : null;
};

/**
 * Merge two alert records describing the same incident.
 *
 * Mutates `existing` in place: newest timestamp wins, the more useful
 * non-empty title and longer content are preferred, the first real URL is
 * kept, and affected lines are unioned. The source/URL that arrived first is
 * treated as the original; nothing is invented.
 *
 * @param {object} existing
 * @param {object} incoming  must carry pre-extracted `affected` and `types`
 */
const mergeAlert = (existing, incoming) => {
  if ((incoming.timestamp ?? 0) > (existing.timestamp ?? 0)) {
    existing.timestamp = incoming.timestamp;
  }
  if (incoming.title && !existing.title) {
    existing.title = incoming.title;
  }
  if (incoming.content && (!existing.content || incoming.content.length > existing.content.length)) {
    existing.content = incoming.content;
  }
  if (incoming.url && !existing.url) {
    existing.url = incoming.url;
  }
  for (const line of incoming.affected) {
    if (!existing.affected.includes(line)) {
      existing.affected.push(line);
      existing.types[line] = lineToType(line);
    }
  }
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

/**
 * Something has to be *disrupted* for a headline to be an alert.
 *
 * The earlier list also accepted bare `tramwaj`, `autobus`, `linia` and
 * `komunikat`, which every corporate press release contains — point this at a
 * news page and "MPK kupuje nowe tramwaje" becomes a service alert. A fake
 * disruption is worse than a missing one: it sends people looking for a
 * replacement bus that does not exist.
 */
const DISRUPTION_WORDS =
  /(objazd|utrudnien|awari|zmian[ay]|zmiany w|remont|wyłącz|zamknię|nie kursu|nie jeźdz|nie pojad|zastępcz|wstrzyman|skrócon|opóźnien|przeniesion|zawiesz)/i;

/** …and it has to be about transport, not roadworks in general. */
const TRANSPORT_WORDS = /(lini[aei]|tramwaj|autobus|kurs|przystan|komunikacj|trasa|tras[yie])/i;

/** Nav and footer links that would otherwise pass the keyword test. */
const CHROME_WORDS = /^(menu|nawigacja|strona główna|kontakt|polityka|cookies|zobacz wszystkie)$/i;

const DATE_PATTERN = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/;

const stripTrailingSlash = (url) => url.replace(/\/$/, '');

const polishDate = (text) => {
  const match = DATE_PATTERN.exec(text ?? '');
  if (!match) return null;
  const [, day, month, year] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Number.isFinite(ms) ? ms : null;
};

const MAX_NOTICE_TITLE = 200;

const NOTICE_DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;

/**
 * The `linie:` / `obowiązuje:` / dated-headline preamble of one notice.
 *
 * `[^:]{0,120}?` keeps the line list from running past a missing field into
 * the next notice: it cannot cross the `:` of the following label.
 */
const STRUCTURED_NOTICE = new RegExp(
  String.raw`linie:\s*(?<lines>[^:]{0,120}?)\s*` +
    String.raw`obowi[ąa]zuje:\s*(?<from>${NOTICE_DATE})\s*[-–—]\s*(?<to>${NOTICE_DATE})\s+` +
    String.raw`(?<published>${NOTICE_DATE})\s*r\.\s*[-–—]\s*`,
  'giu',
);

/** A line as these pages write them: 128, 6, N, A, S7, 15A. */
const LINE_TOKEN = /^(?:\d{1,3}[A-Z]?|[A-Z]\d{0,2}|[A-Z]{2})$/i;

/** `DD.MM.YYYY` -> `YYYY-MM-DD`, so windows compare as plain strings. */
const toIsoDate = (date) => {
  const [day, month, year] = date.split('.');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

/**
 * Today in Wrocław, as `YYYY-MM-DD`.
 *
 * The window is day-granular, so comparing it against a UTC instant would
 * expire a notice up to two hours early on its last evening — the one moment
 * a rider is most likely to be reading it. Ask Intl for the local date and
 * compare dates to dates.
 */
const warsawDate = (now) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/**
 * A notice list that states each notice's lines and validity window.
 *
 * Some of the city's notice pages publish, per notice, the affected lines and
 * the dates the change is in force, not just a headline:
 *
 *   linie: N 128 130 242 251
 *   obowiązuje: 03.09.2026 - 08.09.2026
 *   05.09.2026r. - przywrócenie do ruchu zatoki autobusowej Kromera (24146)
 *
 * That is strictly better than what `parsePage()` below can recover, and it
 * retires two guesses rather than improving them. The line list is *stated*,
 * so `extractAffectedLines()` never runs for these notices — which is the real
 * fix for the phantom-line class of bug (a day-of-month that happens to be a
 * real line number), because there is nothing left to infer. And the validity
 * window is stated, so a notice whose last day has passed is dropped instead
 * of sitting at the top of `/alerts` describing a closure that ended.
 *
 * Parsed out of the page's *text* rather than its markup, deliberately, for
 * the same reason `parseFileListing()` walks the GTFS payload shape-agnostic:
 * these three fields are a publishing convention that survives a redesign,
 * whereas the class names carrying them do not. `stripHtml()` collapses the
 * document to a single line, so this reads a flat string.
 *
 * Known soft spot: a notice's text runs until the next `linie:`, so the last
 * notice on the page has nothing to stop at and is capped at
 * MAX_NOTICE_TITLE characters. If a page's footer starts leaking into the
 * final alert, that cap is why.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ now?: number }} options
 */
const parseStructuredNotices = (html, pageUrl, { now = Date.now() } = {}) => {
  if (typeof html !== 'string' || !html) return [];

  const text = stripHtml(html);
  const today = warsawDate(now);
  const matches = [...text.matchAll(STRUCTURED_NOTICE)];
  const results = [];

  for (const [index, match] of matches.entries()) {
    const { lines, from, to, published } = match.groups;

    // The notice's own text runs from the end of its preamble to the start of
    // the next notice — the same rule parsePage() uses for a lead paragraph,
    // and for the same reason: a fixed window runs into the following notice
    // and appends its text to this one.
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? text.length;
    const title = text.slice(bodyStart, bodyEnd).trim().slice(0, MAX_NOTICE_TITLE).trim();
    if (title.length < 3) continue;

    // Past its last day: the change is over. Publishing it anyway is the same
    // failure as a fake disruption — it sends people around a closure that
    // has been lifted.
    if (toIsoDate(to) < today) continue;

    const affected = lines
      .split(/[\s,;]+/)
      .filter(Boolean)
      .filter((token) => LINE_TOKEN.test(token))
      .map((token) => token.toUpperCase());

    results.push({
      id: `${pageUrl}#${toIsoDate(published)}-${title.slice(0, 60)}`,
      title,
      // The window is what a rider actually asks next ("do kiedy?"), and it
      // is stated on the page, so it belongs in the text rather than only in
      // a field no client reads yet.
      content: `${title} Obowiązuje ${from} – ${to}.`,
      url: pageUrl,
      timestamp: polishDate(published) ?? now,
      source: pageUrl,
      // Stated by the page, so AlertsService.refresh() must not re-guess it.
      affected,
    });
  }

  return results;
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
    if (/^(#|javascript:|mailto:)/i.test(href)) continue;
    // The headline has to describe something going wrong. This is the test
    // that keeps a company news page from producing alerts.
    if (!DISRUPTION_WORDS.test(title)) continue;

    let url;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    // A link back to the notice-list page itself is its own header or
    // breadcrumb, not a notice — its title reads like one ("Zmiany w
    // komunikacji" is both the section name and a disruption-shaped phrase).
    if (stripTrailingSlash(url) === stripTrailingSlash(pageUrl)) continue;
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

    // Transport can be named in the headline or in the lead — real notices
    // often say "Zmiana organizacji ruchu na ulicy X" and only list the
    // affected lines in the body. Without it anywhere, this is roadworks.
    if (!TRANSPORT_WORDS.test(`${title} ${lead ?? ''}`)) continue;

    // These pages print the notice's own publish date right after its title
    // ("...zmiana tras tramwajów 30.07.2026"). It is already surfaced as a
    // relative age, so trailing it a second time on the title is just noise.
    const displayTitle =
      title.replace(/\s*(?:od|z dnia)?\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}\s*$/i, '').trim() || title;

    results.push({
      id: url,
      title: displayTitle,
      content: lead ?? displayTitle,
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
 * Auto-detects the format, cheapest and most trustworthy first: RSS/Atom if
 * the response parses as a feed, then the stated `linie:` / `obowiązuje:`
 * notice list, then headlines scraped out of anchors. That means a site can
 * add or drop a feed, or start stating its lines, without any change here.
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

    // Before falling back to reading headlines out of anchors, check whether
    // this page states its lines and validity windows — that form carries
    // strictly more than parsePage() can recover, so it wins where it parses.
    const structured = parseStructuredNotices(body, this.url);
    if (structured.length) return structured;

    const scraped = parsePage(body, this.url);
    if (!scraped.length) throw new Error('no notices found — page markup probably changed');
    return scraped;
  }
}

/**
 * Rewrites an RSS-bridge permalink to the equivalent x.com one.
 *
 * The alert itself should keep working after the bridge that served it goes
 * away — Nitter, the bridge this project used to depend on, is exactly that
 * story — so the link an alert carries points at the source of truth, not at
 * whichever front end happened to answer this refresh.
 *
 * @param {string|null} bridgeUrl
 * @returns {string|null}
 */
const toXPostUrl = (bridgeUrl) => {
  if (!bridgeUrl) return null;
  try {
    return `https://x.com${new URL(bridgeUrl).pathname}`;
  } catch {
    return bridgeUrl;
  }
};

/**
 * Turn one configured bridge entry into the feed URL for `username`.
 *
 * An entry is a URL template carrying `{username}`, because bridges do not
 * agree on a path shape — RSSHub publishes `/twitter/user/<name>`, a Nitter
 * mirror published `/<name>/rss`, and a self-hosted bridge can be anything.
 * Hardcoding one of those shapes is what tied this source to a single piece
 * of software; a template ties it to none. An entry with no placeholder is
 * treated as a Nitter-shaped base URL so an existing private mirror keeps
 * working without a rewrite.
 *
 * @param {string} template
 * @param {string} username
 * @returns {string}
 */
const buildBridgeUrl = (template, username) => {
  const base = String(template).trim();
  if (base.includes('{username}')) {
    return base.replaceAll('{username}', encodeURIComponent(username));
  }
  return `${stripTrailingSlash(base)}/${encodeURIComponent(username)}/rss`;
};

/**
 * Reads @AlertMPK's public posts through an RSS bridge.
 *
 * There is no free API path to a user's timeline — that has needed a paid
 * tier since 2023, which is what silently emptied `/alerts` for a year (see
 * CLAUDE.md). A bridge is any service that republishes a public profile as
 * plain RSS, which `parseFeed()` above already parses — no browser, no
 * reverse-engineered endpoint, no markup to keep up with.
 *
 * This used to be hardwired to Nitter, which has since been discontinued;
 * its public mirrors are gone and the ones still answering serve empty
 * feeds. That is why nothing is configured by default and why the notice
 * page (`config.alerts.pages`) is now the source that ships working: this
 * provider only exists when `ALERT_X_BRIDGE_URLS` names a bridge the
 * operator actually has, and `buildBridgeUrl()` above makes no assumption
 * about which software is behind it. Entries are tried in order, same
 * pattern as every other multi-source config in this project (see CLAUDE.md
 * invariant 1).
 *
 * The account is dedicated entirely to service alerts, unlike the corporate
 * news page rejected earlier — so unlike `parsePage()`, a post here does not
 * have to pass the disruption/transport keyword gate to count. Line numbers
 * are still extracted centrally by `AlertsService.refresh()`, same as every
 * other provider.
 */
class XBridgeProvider {
  /**
   * @param {object} options
   * @param {(url: string, init: object) => Promise<{ ok: boolean, status: number, statusText: string, text: string }>} [options.request]
   *   the HTTP reader, injectable so the suite can exercise bridge failover
   *   without a network.
   */
  constructor({ username, bridges, maxPosts, timeoutMs, request = requestText }) {
    this.username = username;
    this.bridges = bridges;
    this.maxPosts = maxPosts;
    this.timeoutMs = timeoutMs;
    this.request = request;
    this.name = `x-bridge:@${username}`;
  }

  async fetch() {
    let lastError = new Error(`no RSS bridge configured for @${this.username}`);

    for (const bridge of this.bridges) {
      const url = buildBridgeUrl(bridge, this.username);
      try {
        // requestText(), not fetchWithTimeout() — see its doc comment in
        // src/http.js: a bridge fronting X is usually hardened against
        // scrapers, and at least one answered the global fetch() with a
        // genuine 200 and an empty body while a raw http(s) request got the
        // actual feed.
        const response = await this.request(url, {
          timeoutMs: this.timeoutMs,
          headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

        const items = parseFeed(response.text, url);
        if (!items.length) throw new Error('no items in feed — the bridge may be serving an empty page');

        return items.slice(0, this.maxPosts).map((item) => ({
          id: item.id,
          title: null,
          content: item.content,
          url: toXPostUrl(item.url),
          timestamp: item.timestamp,
          source: url,
        }));
      } catch (error) {
        lastError = new Error(`${bridge}: ${error.message}`);
      }
    }

    throw lastError;
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
  constructor(getKnownLines, providers = null, options = {}) {
    this.getKnownLines = getKnownLines ?? (() => new Set());
    this.alerts = [];
    this.incidents = [];
    this.timer = null;
    this.started = false;
    /** True after stop() so an in-flight refresh never re-arms its timer. */
    this._stopped = false;
    this.providers = providers ?? this.#defaultProviders();
    this.aiProvider = options.aiProvider ?? createAiProvider(config.aiAlerts, logger);
    this.aiModel = options.aiModel ?? config.aiAlerts[config.aiAlerts.requestedProvider]?.model ?? null;
    this.aiCacheTtlMs = options.aiCacheTtlMs ?? config.aiAlerts.cacheTtlMs;
    this.aiIncidentCache = new Map();

    this.incidentStatus = {
      enabled: Boolean(this.aiProvider.enabled),
      provider: this.aiProvider.name ?? null,
      model: this.aiModel,
      lastSuccessAt: null,
      lastError: this.aiProvider.enabled ? null : (this.aiProvider.status?.reason ?? 'AI disabled'),
      incidentCount: 0,
    };

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
      aiIncidents: this.incidentStatus,
    };
  }

  #defaultProviders() {
    const result = config.alerts.pages.map((url) => new NoticeProvider(url));
    // No bridge configured is the normal case, not a misconfiguration: the
    // notice page is the source that ships working. Adding a provider with an
    // empty candidate list would only manufacture a permanent lastError in
    // /health for a source the operator never asked for.
    const { enabled, bridges } = config.alerts.xBridge;
    if (enabled && bridges.length) {
      result.push(new XBridgeProvider(config.alerts.xBridge));
    }
    return result;
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
        logger.warn(
          'No alerts available from any provider — check ALERT_PAGE_URLS and, if one is ' +
            'configured, ALERT_X_BRIDGE_URLS (see npm run scrape:alerts)',
        );
      }
      return this.alerts;
    }

    const byId = new Map();
    const byFingerprint = new Map();
    const deduped = [];

    // Pre-compute fingerprint and affected lines for each collected item so the
    // merge step below has everything it needs.
    const enriched = collected.map((item) => {
      const id = item.id || `${item.source}:${item.timestamp}:${item.title ?? item.content}`;
      const fp = fingerprint(item.title, item.content);
      // A source that states its affected lines is believed. Re-deriving them
      // from prose could only lose: extractAffectedLines() has to guess which
      // numbers are line numbers, and this page has already answered that.
      const affected = item.affected?.length
        ? item.affected
        : extractAffectedLines(`${item.title ?? ''} ${item.content ?? ''}`, knownLines);
      // Clients colour line badges by type; without this they would all have to
      // re-implement the categorisation rules and drift out of sync with them.
      const types = {};
      for (const line of affected) types[line] = lineToType(line);
      return { ...item, id, fp, affected, types };
    });

    for (const item of enriched) {
      // Primary dedup: same ID from the same source — exact duplicate.
      const existingById = byId.get(item.id);
      if (existingById) {
        mergeAlert(existingById, item);
        continue;
      }

      // Secondary dedup: same incident published by a different source with a
      // different ID. Only long enough content qualifies; short alerts stay
      // separate unless their IDs match.
      if (item.fp && byFingerprint.has(item.fp)) {
        const existing = byFingerprint.get(item.fp);
        mergeAlert(existing, item);
        byId.set(item.id, existing);
        continue;
      }

      deduped.push(item);
      byId.set(item.id, item);
      if (item.fp) byFingerprint.set(item.fp, item);
    }

    this.alerts = deduped
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, config.alerts.maxItems)
      .map(({ fp: _fp, ...alert }) => ({
        id: alert.id,
        title: alert.title || null,
        content: alert.content,
        url: alert.url,
        timestamp: alert.timestamp,
        source: alert.source,
        affected: alert.affected,
        types: alert.types,
      }));
    this.status.count = this.alerts.length;

    // Publish deterministic incidents immediately. Raw /alerts has already
    // been updated at this point, so a slow provider cannot hold it hostage;
    // these fallback timelines also remain usable while AI is in flight.
    this.incidents = createFallbackIncidents(this.alerts);
    this.incidentStatus.incidentCount = this.incidents.length;

    try {
      // Caching is per incident cluster (inside buildIncidentsFromAlerts), not
      // per refresh: an unrelated new alert elsewhere in the city must not
      // force every already-settled incident's narrative to regenerate.
      const incidents = await buildIncidentsFromAlerts(this.alerts, {
        provider: this.aiProvider,
        model: this.aiModel,
        maxInputAlerts: config.aiAlerts.maxInputAlerts,
        cache: this.aiIncidentCache,
        cacheTtlMs: this.aiCacheTtlMs,
      });
      this.incidents = incidents;
      this.incidentStatus.incidentCount = incidents.length;
      const generated = incidents.some((incident) => incident.ai.generated);
      const failed = incidents.find((incident) => !incident.ai.generated && incident.ai.error);
      if (generated) this.incidentStatus.lastSuccessAt = new Date().toISOString();
      this.incidentStatus.lastError = failed?.ai.error ?? null;
    } catch (error) {
      // buildIncidentsFromAlerts is fail-soft itself. This final guard keeps a
      // future regression there from escaping the public refresh/route path.
      this.incidentStatus.lastError = error?.message || 'AI incident generation failed';
      logger.debug(`AI incident generation failed: ${this.incidentStatus.lastError}`);
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

  /**
   * @param {{ since?: number, line?: string, status?: string|null }} options
   */
  getIncidents({ since = 0, line = null, status = null } = {}) {
    const wantedLine = line ? String(line).toUpperCase() : null;
    return this.incidents.filter(
      (incident) =>
        incident.lastUpdatedAt >= since &&
        (!wantedLine || incident.affected.includes(wantedLine)) &&
        (!status || incident.status === status),
    );
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._stopped = false;

    // First refresh immediately. A placeholder handle keeps `timer` non-null from
    // the first instant — stop() and callers that inspect the timer rely on it —
    // and is replaced by the real arm the moment the first refresh settles. The
    // next arm is queued from the *end* of #runRefreshLoop, which is the only
    // code that schedules an alert timer.
    this.timer = setTimeout(() => {}, 0);
    this.timer.unref?.();
    void this.#runRefreshLoop();
  }

  #scheduleNextRefresh() {
    if (this._stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#runRefreshLoop(), config.alerts.refreshIntervalMs);
    this.timer.unref?.();
  }

  /** One iteration: refresh, then arm the next from completion. Non-overlapping. */
  async #runRefreshLoop() {
    try {
      await this.refresh();
    } catch (error) {
      logger.error(`Alert refresh threw, rescheduling: ${error.message}`);
    } finally {
      this.#scheduleNextRefresh();
    }
  }

  stop() {
    this._stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }
}

module.exports = {
  AlertsService,
  NoticeProvider,
  XBridgeProvider,
  buildBridgeUrl,
  toXPostUrl,
  extractAffectedLines,
  fingerprint,
  parseFeed,
  parsePage,
  parseStructuredNotices,
  normalizeText,
  stripHtml,
};
