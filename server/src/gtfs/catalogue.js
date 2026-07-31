'use strict';

/**
 * Working out which GTFS archive to download.
 *
 * Wrocław retired the `wroclaw.pl/open-data` portal in April 2026, which is
 * what broke this project: a hardcoded resource UUID on a portal that no longer
 * exists. Nothing here hardcodes a download URL — the current archive is
 * resolved at runtime from the city's data API.
 *
 * Dataset 6 is the public transport timetable, and it does not expose "the
 * current file". It returns the whole archive of dated snapshots, which brings
 * two traps that `orderByEffectiveDate` and per-candidate validation exist to
 * handle. Both are documented on the functions below.
 */

const config = require('../config');
const logger = require('../logger');
const { fetchWithTimeout } = require('../http');

/** CKAN has shipped both of these API prefixes; neither is safe to assume. */
const CKAN_API_PATHS = ['/api/3/action/', '/api/action/'];

/** A feed without these is not usable, whatever the listing claims. */
const REQUIRED_TABLES = ['routes', 'trips', 'stops', 'stop_times', 'shapes'];

/**
 * Pull the effective date out of a snapshot filename.
 *
 * Names look like `OtwartyWroclaw_rozklad_jazdy_GTFS_25072026` — DDMMYYYY, not
 * the ISO order the digits suggest at a glance.
 *
 * @returns {number|null} UTC epoch ms, or null when there is no valid date
 */
const effectiveDateFromName = (name) => {
  const match = /(\d{2})(\d{2})(\d{4})(?!\d)/.exec(String(name ?? ''));
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  return Date.UTC(year, month - 1, day);
};

const URL_KEYS = ['url', 'link', 'href', 'download', 'downloadurl', 'file', 'path'];
const NAME_KEYS = ['name', 'filename', 'nazwa', 'title', 'label'];

const pickKey = (node, keys) => {
  for (const key of Object.keys(node)) {
    if (!keys.includes(key.toLowerCase().replace(/[_\s-]/g, ''))) continue;
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

/**
 * Walk an arbitrary JSON payload and pull out downloadable archive entries.
 *
 * Deliberately shape-agnostic. The portal is new and its response schema is not
 * documented anywhere verifiable, so rather than hardcoding key names this
 * looks for any object carrying a URL-ish string next to a name-ish string. If
 * the payload shape changes, this keeps working; if it returns nothing, the
 * startup log says so and that is the first thing to check.
 *
 * @param {unknown} payload
 * @returns {{name: string, url: string, effectiveDate: number|null}[]}
 */
const parseFileListing = (payload) => {
  const entries = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || depth > 8) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const url = pickKey(node, URL_KEYS);
    const name = pickKey(node, NAME_KEYS) ?? url;

    if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
      const haystack = `${name} ${url} ${node.extension ?? node.rozszerzenie ?? ''}`;
      const looksLikeFeed =
        /gtfs/i.test(haystack) || /\.zip($|\?)/i.test(url) || /\bzip\b/i.test(haystack);
      // The dataset also publishes an XML timetable, which is not GTFS.
      if (looksLikeFeed && !/\bxml\b/i.test(haystack)) {
        seen.add(url);
        entries.push({ name, url, effectiveDate: effectiveDateFromName(name) });
      }
    }

    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(payload, 0);
  return entries;
};

/**
 * Order snapshots so the timetable actually in force today comes first.
 *
 * The archive carries future-dated timetables: on 2026-07-30 the listing
 * already contained `GTFS_01082026`, effective two days later. Taking the
 * newest entry serves a schedule that is not in force and shows wrong
 * departure times with no error anywhere — the worst kind of failure, because
 * everything looks healthy.
 *
 * So: the latest effective date that has already arrived, then older ones, and
 * only then future ones as a last resort.
 */
const orderByEffectiveDate = (entries, now = Date.now()) => {
  const dated = entries.filter((entry) => entry.effectiveDate != null);
  const undated = entries.filter((entry) => entry.effectiveDate == null);

  const inForce = dated
    .filter((entry) => entry.effectiveDate <= now)
    .sort((a, b) => b.effectiveDate - a.effectiveDate);

  const future = dated
    .filter((entry) => entry.effectiveDate > now)
    .sort((a, b) => a.effectiveDate - b.effectiveDate);

  return [...inForce, ...undated, ...future];
};

/**
 * Pick GTFS archives out of a CKAN resource list.
 *
 * Does NOT require a `.zip` extension: portals increasingly serve archives from
 * extensionless endpoints such as `/hdb/ft/6/`, and an extension check silently
 * drops those. The declared format is the signal here; the magic-byte check at
 * download time is the actual guarantee.
 */
const pickZipResources = (resources) => {
  if (!Array.isArray(resources)) return [];

  const scored = [];
  for (const resource of resources) {
    const url = resource?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;

    const fields = [resource.format, resource.mimetype, resource.name, resource.description, url]
      .filter((value) => typeof value === 'string')
      .join(' ');

    const isZip = /\bzip\b/i.test(fields) || /\.zip($|\?)/i.test(url);
    const isXml = /\bxml\b/i.test(`${resource.format ?? ''} ${resource.name ?? ''}`);
    if (!isZip || isXml) continue;

    scored.push({ url, score: /gtfs/i.test(fields) ? 0 : 1 });
  }

  scored.sort((a, b) => a.score - b.score);
  return [...new Set(scored.map((entry) => entry.url))];
};

const fetchJson = async (url) => {
  const response = await fetchWithTimeout(url, {
    timeoutMs: config.gtfs.catalogueTimeoutMs,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    // A portal that has been retired or moved serves its own HTML error page
    // with a 200. Saying so beats a raw "Unexpected token '<'".
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);
    throw new Error(
      looksLikeHtml
        ? 'responded with an HTML page, not JSON — the API path is probably wrong'
        : `responded with something that is not JSON: ${body.slice(0, 80).replace(/\s+/g, ' ')}…`,
    );
  }
};

/** A short, safe description of a payload, for when the parser finds nothing. */
const describePayload = (payload) => {
  if (payload === null || payload === undefined) return String(payload);
  if (Array.isArray(payload)) return `array of ${payload.length}`;
  if (typeof payload !== 'object') return typeof payload;

  const keys = Object.keys(payload);
  const sample = JSON.stringify(payload).slice(0, 400);
  return `object with keys [${keys.slice(0, 12).join(', ')}] — ${sample}`;
};

/**
 * Resolve the ordered list of archive URLs to try.
 *
 * `GTFS_URLS` short-circuits this for debugging. Setting it in production
 * re-creates the original failure — it pins the server to one snapshot, which
 * then silently goes stale.
 *
 * @returns {Promise<{url: string, name: string|null}[]>}
 */
const resolveFeedCandidates = async ({ now = Date.now() } = {}) => {
  if (config.gtfs.overrideUrls.length) {
    logger.warn(
      `GTFS_URLS is set — feed discovery is disabled and this snapshot will go stale`,
    );
    return config.gtfs.overrideUrls.map((url) => ({ url, name: null }));
  }

  const candidates = [];

  // 1. The city's current data API, which returns the whole dated archive.
  try {
    const payload = await fetchJson(config.gtfs.catalogueUrl);
    const ordered = orderByEffectiveDate(parseFileListing(payload), now);

    if (ordered.length) {
      logger.info(
        `catalogue lists ${ordered.length} snapshot(s); using ${ordered[0].name}`,
      );
      candidates.push(...ordered.map((entry) => ({ url: entry.url, name: entry.name })));
    } else {
      // Print what actually came back. Without this the only way to find out is
      // to curl the endpoint by hand from a machine that can reach it.
      logger.warn(
        `catalogue at ${config.gtfs.catalogueUrl} returned no usable entries — ` +
          'parseFileListing needs adjusting to this payload:',
      );
      logger.warn(`  ${describePayload(payload)}`);
    }
  } catch (error) {
    logger.warn(`catalogue lookup failed: ${error.message}`);
  }

  // 2. CKAN instances. Both the API path and the hostname have moved before —
  // opendata. and open-data. are different portals, not aliases — so try each
  // combination rather than betting on one.
  for (const host of config.gtfs.ckanHosts) {
    let found = false;

    for (const apiPath of CKAN_API_PATHS) {
      if (found) break;
      const url = `${host}${apiPath}package_show?id=${config.gtfs.ckanDataset}`;
      try {
        const json = await fetchJson(url);
        const urls = pickZipResources(json?.result?.resources ?? json?.resources);
        if (!urls.length) continue;
        for (const resourceUrl of urls) candidates.push({ url: resourceUrl, name: null });
        logger.info(`CKAN at ${url} offered ${urls.length} archive(s)`);
        found = true;
      } catch (error) {
        logger.debug(`CKAN lookup failed for ${url}: ${error.message}`);
      }
    }

    if (!found) logger.warn(`no CKAN archives found at ${host}`);
  }

  // 3. Static mirrors, last.
  for (const url of config.gtfs.mirrors) candidates.push({ url, name: null });

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  return deduped;
};

module.exports = {
  REQUIRED_TABLES,
  describePayload,
  effectiveDateFromName,
  orderByEffectiveDate,
  parseFileListing,
  pickZipResources,
  resolveFeedCandidates,
};
