'use strict';

/**
 * Central configuration.
 *
 * Every upstream URL is overridable through the environment and every data
 * source is a *list* of candidates rather than a single URL. Wrocław has moved
 * its open-data portal at least once (www.wroclaw.pl/open-data ->
 * opendata.cui.wroclaw.pl) and MPK has changed the vehicle-position endpoint
 * before, so the service tries each candidate in order and remembers which one
 * answered. `npm run doctor` reports the same list with live results.
 */

require('dotenv').config();

const num = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};

/** Split a comma/whitespace separated env var into a trimmed list. */
const list = (value, fallback) => {
  if (!value) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
};

const VEHICLE_SOURCES = list(process.env.VEHICLE_POSITION_URLS, [
  'https://mpk.wroc.pl/bus_position',
]);

/**
 * Pages carrying live service disruptions.
 *
 * Empty by default — @AlertMPK on X is the sole default source (see
 * `twitterScrape` below). `mpk.wroc.pl/komunikaty` was a guess and 404s, and
 * `/o-mpk/aktualnosci` exists but is corporate news — adding it produced
 * "MPK kupuje nowe tramwaje" as a service alert. `ALERT_PAGE_URLS` still works
 * for anyone who wants to add `wroclaw.pl/komunikacja/zmiany-w-komunikacji` (or
 * another page) back as an extra source; before adding one, check that it
 * carries dated disruptions rather than press releases — `npm run doctor`
 * prints the headlines each one yields so that is easy to eyeball.
 */
const ALERT_PAGES = list(process.env.ALERT_PAGE_URLS, []);

module.exports = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: bool(process.env.TRUST_PROXY, false),

  cors: {
    // Comma separated list, or "*" for anything.
    origins: list(process.env.CORS_ORIGINS, ['*']),
  },

  gtfs: {
    // The city's current data API. Dataset 6 is the public transport timetable
    // and returns the whole archive of dated snapshots, not one current file.
    catalogueUrl: process.env.GTFS_CATALOGUE_URL || 'https://api.open-data.cui.wroclaw.pl/od2/6/',
    // Legacy CKAN instance, tried after the data API.
    ckanHosts: list(process.env.GTFS_CKAN_HOSTS, [
      'https://opendata.cui.wroclaw.pl',
      'https://open-data.cui.wroclaw.pl',
    ]),
    ckanDataset: process.env.GTFS_CKAN_DATASET || 'rozkladjazdytransportupublicznegoplik_data',
    // Static mirrors, tried last.
    mirrors: list(process.env.GTFS_MIRROR_URLS, [
      'https://api.dane.gov.pl/resources/1823,rozklad-jazdy-transportu-publicznego-gtfs/file',
    ]),
    // Debugging escape hatch. Setting this in production pins the server to one
    // snapshot, which then goes stale without any error — the exact failure
    // that killed the original version of this project.
    overrideUrls: list(process.env.GTFS_URLS, []),
    // Where a file id is downloaded from when its metadata carries no URL.
    downloadBase: process.env.GTFS_DOWNLOAD_BASE || 'https://open-data.cui.wroclaw.pl/hdb/download',
    // Dataset 6 lists ~66 file ids, ordered newest first. Only the recent ones
    // can be the timetable in force, so there is no point resolving all of them.
    maxFileLookups: num(process.env.GTFS_MAX_FILE_LOOKUPS, 24),
    // Blind downloads to attempt when no metadata endpoint answers. Each is a
    // ~11 MB fetch, so this stays small; the ids are newest first.
    maxIdDownloads: num(process.env.GTFS_MAX_ID_DOWNLOADS, 4),
    // How many discovered candidates to try before giving up.
    maxCandidates: num(process.env.GTFS_MAX_CANDIDATES, 6),
    // Where the last successfully downloaded archive is kept so a restart (or a
    // city portal outage) does not leave the service with no timetable at all.
    cacheDir: process.env.GTFS_CACHE_DIR || require('node:path').join(__dirname, '..', 'data'),
    useCache: bool(process.env.GTFS_USE_CACHE, true),
    refreshCron: process.env.GTFS_REFRESH_CRON || '30 3 * * *',
    timeoutMs: num(process.env.GTFS_TIMEOUT_MS, 120_000),
    catalogueTimeoutMs: num(process.env.GTFS_CATALOGUE_TIMEOUT_MS, 20_000),
    // Building the per-stop departure index costs memory; allow turning it off
    // on small instances.
    buildStopIndex: bool(process.env.GTFS_BUILD_STOP_INDEX, true),
  },

  vehicles: {
    sources: VEHICLE_SOURCES,
    pollIntervalMs: num(process.env.VEHICLE_POLL_INTERVAL_MS, 10_000),
    timeoutMs: num(process.env.VEHICLE_TIMEOUT_MS, 10_000),
    // Positions older than this are dropped from /locations.
    staleAfterMs: num(process.env.VEHICLE_STALE_AFTER_MS, 120_000),
  },

  alerts: {
    pages: ALERT_PAGES,
    refreshIntervalMs: num(process.env.ALERTS_REFRESH_INTERVAL_MS, 5 * 60_000),
    timeoutMs: num(process.env.ALERTS_TIMEOUT_MS, 15_000),
    maxItems: num(process.env.ALERTS_MAX_ITEMS, 100),
    // The default alerts source: reads @AlertMPK's public posts instead of
    // the paid X API. See src/twitterScrape.js for the two ways this can
    // happen and why "http" is the more fragile of the two, despite being the
    // default — it needs no Chromium install, at the cost of depending on one
    // specific undocumented endpoint instead of the rendered page itself.
    // Set to false to turn this source off entirely.
    twitterScrape: {
      enabled: bool(process.env.TWITTER_SCRAPE_ENABLED, true),
      // "http": plain fetch of the syndication/embed endpoint, no browser.
      // "browser": drive a real headless Chromium instead — heavier to run,
      // but reads the rendered page rather than one specific undocumented
      // URL, so it's the fallback if TWITTER_SCRAPE_MODE=http stops working.
      mode: process.env.TWITTER_SCRAPE_MODE === 'browser' ? 'browser' : 'http',
      username: process.env.TWITTER_SCRAPE_USERNAME || 'AlertMPK',
      maxPosts: num(process.env.TWITTER_SCRAPE_MAX_POSTS, 10),
      timeoutMs: num(process.env.TWITTER_SCRAPE_TIMEOUT_MS, 30_000),
      headless: bool(process.env.TWITTER_SCRAPE_HEADLESS, true),
      // Only used in "browser" mode, and only needed if playwright-core's own
      // managed browser install (`npx playwright install chromium`) is not
      // what should be used — e.g. a distro-packaged Chromium already on the box.
      executablePath: process.env.TWITTER_SCRAPE_EXECUTABLE_PATH || undefined,
    },
  },

  cache: {
    // Number of route-shape responses kept in memory.
    shapeEntries: num(process.env.SHAPE_CACHE_ENTRIES, 200),
  },

  userAgent:
    process.env.HTTP_USER_AGENT ||
    'wroclaw-mpk-map/2.0 (+https://github.com/real-kijmoshi/wroclaw-mpk-map)',
};
