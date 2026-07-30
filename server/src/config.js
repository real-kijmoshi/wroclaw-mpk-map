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

const GTFS_SOURCES = list(process.env.GTFS_URLS, [
  // Historic (and still advertised) direct download on the old portal.
  'https://www.wroclaw.pl/open-data/87b09b32-f076-4475-8ec9-6020ed1f9ac0/OtwartyWroclaw_rozklad_jazdy_GTFS.zip',
  // Same file on the CKAN portal the city migrated to.
  'https://opendata.cui.wroclaw.pl/dataset/rozkladjazdytransportupublicznegoplik_data/resource/download/OtwartyWroclaw_rozklad_jazdy_GTFS.zip',
  // Mirror maintained by the transit community, useful when the city portal is down.
  'https://mkuran.pl/gtfs/wroclaw.zip',
]);

const VEHICLE_SOURCES = list(process.env.VEHICLE_POSITION_URLS, [
  'https://mpk.wroc.pl/bus_position',
]);

const ALERT_FEEDS = list(process.env.ALERT_FEED_URLS, [
  'https://www.wroclaw.pl/komunikacja/rss',
  'https://www.mpk.wroc.pl/feed',
]);

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
    sources: GTFS_SOURCES,
    // Where the last successfully downloaded archive is kept so a restart (or a
    // city portal outage) does not leave the service with no timetable at all.
    cacheDir: process.env.GTFS_CACHE_DIR || require('node:path').join(__dirname, '..', 'data'),
    useCache: bool(process.env.GTFS_USE_CACHE, true),
    refreshCron: process.env.GTFS_REFRESH_CRON || '30 3 * * *',
    timeoutMs: num(process.env.GTFS_TIMEOUT_MS, 120_000),
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
    feeds: ALERT_FEEDS,
    refreshIntervalMs: num(process.env.ALERTS_REFRESH_INTERVAL_MS, 5 * 60_000),
    timeoutMs: num(process.env.ALERTS_TIMEOUT_MS, 15_000),
    maxItems: num(process.env.ALERTS_MAX_ITEMS, 100),
    // Optional: X/Twitter is only used when a bearer token is supplied, because
    // reading a user timeline is no longer possible on the free API tier.
    twitter: {
      bearerToken: process.env.TWITTER_BEARER_TOKEN || null,
      userId: process.env.TWITTER_USER_ID || '296212741', // @mpkwroclaw
      username: process.env.TWITTER_USERNAME || 'mpkwroclaw',
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
