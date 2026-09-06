'use strict';

const path = require('node:path');

require('dotenv').config();

// The single source of truth for every default. `.env` only carries real
// overrides and secrets; .env.example documents every variable.
const DEFAULTS = require('./config.defaults.json');

const num = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const decimal = (value, fallback) => {
  const parsed = Number(value);
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

/** Defaults that live under this repository's `server/` directory. */
const cachePath = (segment) => path.join(__dirname, '..', segment);

const VEHICLE_SOURCES = list(process.env.VEHICLE_POSITION_URLS, DEFAULTS.vehicleSources);

/**
 * Pages carrying live service disruptions.
 *
 * Empty by default, and deliberately so: the city's notice pages publish
 * *planned* changes — stop relocations, roadworks, event closures, each with
 * its own `linie:` and `obowiązuje:` — and those are not disruptions. Serving
 * them as `/alerts` is the "a fake disruption is worse than a missing one"
 * rule applied to a whole source: it fills the screen with things that are
 * not going wrong, and buries the one that is. `@AlertMPK` is the account
 * that carries actual incidents; see `xBridge` below for how it is reached.
 *
 * A page is still worth configuring as a *second* source when you want the
 * planned changes too. Only add one that carries dated notices:
 * `mpk.wroc.pl/komunikaty` was a guess and 404s, and `/o-mpk/aktualnosci`
 * exists but is corporate news — adding it produced "MPK kupuje nowe
 * tramwaje" as a service alert. `npm run doctor` prints what each configured
 * page yields so that is easy to eyeball before trusting it. A page that
 * states its lines and window is read by `parseStructuredNotices()`, one that
 * does not is scraped by `parsePage()`; both fail soft into
 * `alerts.providers[].lastError`.
 */
const ALERT_PAGES = list(process.env.ALERT_PAGE_URLS, DEFAULTS.alertPages);

const requestedAiProvider = String(
  process.env.AI_ALERTS_PROVIDER || DEFAULTS.aiAlerts.provider,
).toLowerCase();
const requestedAiEnabled = bool(process.env.AI_ALERTS_ENABLED, DEFAULTS.aiAlerts.enabled);
const openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
const openrouterModel = process.env.OPENROUTER_MODEL || DEFAULTS.aiAlerts.openrouter.model;
const cmdcApiKey = process.env.CMD_API_KEY || process.env.CMDC_API_KEY || '';
const cmdcModel = process.env.CMDC_MODEL || DEFAULTS.aiAlerts.cmdc.model;
const ollamaModel = process.env.OLLAMA_MODEL || DEFAULTS.aiAlerts.ollama.model;

const resolveAiAlerts = () => {
  if (!requestedAiEnabled) {
    return { enabled: false, provider: 'off', reason: 'AI alerts are disabled' };
  }

  if (requestedAiProvider === 'openrouter') {
    if (!openrouterApiKey) {
      return { enabled: false, provider: 'off', reason: 'OPENROUTER_API_KEY is required' };
    }
    if (!openrouterModel) {
      return { enabled: false, provider: 'off', reason: 'OPENROUTER_MODEL is required' };
    }
  } else if (requestedAiProvider === 'cmdc') {
    if (!cmdcApiKey) {
      return { enabled: false, provider: 'off', reason: 'CMD_API_KEY is required' };
    }
    if (!cmdcModel) {
      return { enabled: false, provider: 'off', reason: 'CMDC_MODEL is required' };
    }
  } else if (requestedAiProvider === 'ollama') {
    if (!ollamaModel) {
      return { enabled: false, provider: 'off', reason: 'OLLAMA_MODEL is required' };
    }
  } else {
    return {
      enabled: false,
      provider: 'off',
      reason: `Unsupported AI alerts provider: ${requestedAiProvider || '(empty)'}`,
    };
  }

  return { enabled: true, provider: requestedAiProvider, reason: null };
};

const aiAlertsSelection = resolveAiAlerts();

module.exports = {
  port: num(process.env.PORT, DEFAULTS.port),
  host: process.env.HOST || DEFAULTS.host,
  logLevel: process.env.LOG_LEVEL || DEFAULTS.logLevel,
  trustProxy: bool(process.env.TRUST_PROXY, DEFAULTS.trustProxy),

  cors: {
    // Comma separated list, or "*" for anything.
    origins: list(process.env.CORS_ORIGINS, DEFAULTS.cors.origins),
  },

  gtfs: {
    // The city's current data API. Dataset 6 is the public transport timetable
    // and returns the whole archive of dated snapshots, not one current file.
    catalogueUrl: process.env.GTFS_CATALOGUE_URL || DEFAULTS.gtfs.catalogueUrl,
    // Legacy CKAN instance, tried after the data API.
    ckanHosts: list(process.env.GTFS_CKAN_HOSTS, DEFAULTS.gtfs.ckanHosts),
    ckanDataset: process.env.GTFS_CKAN_DATASET || DEFAULTS.gtfs.ckanDataset,
    // Static mirrors, tried last.
    mirrors: list(process.env.GTFS_MIRROR_URLS, DEFAULTS.gtfs.mirrors),
    // Debugging escape hatch. Setting this in production pins the server to one
    // snapshot, which then goes stale without any error — the exact failure
    // that killed the original version of this project.
    overrideUrls: list(process.env.GTFS_URLS, DEFAULTS.gtfs.overrideUrls),
    // Where a file id is downloaded from when its metadata carries no URL.
    downloadBase: process.env.GTFS_DOWNLOAD_BASE || DEFAULTS.gtfs.downloadBase,
    // Dataset 6 lists ~66 file ids, ordered newest first. Only the recent ones
    // can be the timetable in force, so there is no point resolving all of them.
    maxFileLookups: num(process.env.GTFS_MAX_FILE_LOOKUPS, DEFAULTS.gtfs.maxFileLookups),
    // Blind downloads to attempt when no metadata endpoint answers. Each is a
    // ~11 MB fetch, so this stays small; the ids are newest first.
    maxIdDownloads: num(process.env.GTFS_MAX_ID_DOWNLOADS, DEFAULTS.gtfs.maxIdDownloads),
    // How many discovered candidates to try before giving up.
    maxCandidates: num(process.env.GTFS_MAX_CANDIDATES, DEFAULTS.gtfs.maxCandidates),
    // Where the last successfully downloaded archive is kept so a restart (or a
    // city portal outage) does not leave the service with no timetable at all.
    cacheDir: process.env.GTFS_CACHE_DIR || cachePath(DEFAULTS.gtfs.cacheDir),
    useCache: bool(process.env.GTFS_USE_CACHE, DEFAULTS.gtfs.useCache),
    refreshCron: process.env.GTFS_REFRESH_CRON || DEFAULTS.gtfs.refreshCron,
    timeoutMs: num(process.env.GTFS_TIMEOUT_MS, DEFAULTS.gtfs.timeoutMs),
    catalogueTimeoutMs: num(process.env.GTFS_CATALOGUE_TIMEOUT_MS, DEFAULTS.gtfs.catalogueTimeoutMs),
    // Building the per-stop departure index costs memory; allow turning it off
    // on small instances.
    buildStopIndex: bool(process.env.GTFS_BUILD_STOP_INDEX, DEFAULTS.gtfs.buildStopIndex),
  },

  vehicles: {
    sources: VEHICLE_SOURCES,
    pollIntervalMs: num(process.env.VEHICLE_POLL_INTERVAL_MS, DEFAULTS.vehicles.pollIntervalMs),
    timeoutMs: num(process.env.VEHICLE_TIMEOUT_MS, DEFAULTS.vehicles.timeoutMs),
    // Positions older than this are dropped from /locations.
    staleAfterMs: num(process.env.VEHICLE_STALE_AFTER_MS, DEFAULTS.vehicles.staleAfterMs),

    // Supplementary live positions from the city's Open Data portal. The MPK
    // endpoint stays the primary source; this one is merged in (see
    // src/open-data.js) so a bus number and brigade can ride along with the
    // position, and so the fleet is not empty when only one source answers.
    openDataUrl: process.env.OPEN_DATA_VEHICLE_URL || DEFAULTS.vehicles.openDataUrl,
    openDataPollIntervalMs: num(
      process.env.OPEN_DATA_POLL_INTERVAL_MS,
      DEFAULTS.vehicles.openDataPollIntervalMs,
    ),
    openDataTimeoutMs: num(process.env.OPEN_DATA_TIMEOUT_MS, DEFAULTS.vehicles.openDataTimeoutMs),
    // Records whose position timestamp is older than this are dropped.
    openDataMaxAgeMs: num(process.env.OPEN_DATA_MAX_AGE_MS, DEFAULTS.vehicles.openDataMaxAgeMs),

    // Merge thresholds for pairing Open Data records with MPK vehicles:
    // closest same-line, same-type MPK vehicle within matchMaxMeters wins, a
    // record closer than dedupeMeters to *any* same-line MPK vehicle is a
    // duplicate rather than a vehicle of its own, and two candidates closer
    // together than ambiguityMeters cannot be told apart.
    matchMaxMeters: num(process.env.VEHICLE_MATCH_MAX_METERS, DEFAULTS.vehicles.matchMaxMeters),
    dedupeMeters: num(process.env.VEHICLE_DEDUPE_MAX_METERS, DEFAULTS.vehicles.dedupeMeters),
    ambiguityMeters: num(process.env.VEHICLE_MATCH_AMBIGUITY_METERS, DEFAULTS.vehicles.ambiguityMeters),
  },

  // PT KŁOSOK: a subcontractor running suburban bus lines (911, 921, 931, …)
  // in Wrocław and the surrounding gminas. It publishes a public GTFS-RT feed
  // of live positions but no timetable of its own — buses are matched against
  // the Wrocław GTFS above (trip id, route id, then vehicle/brigade), so
  // this is a live-position source only. Independent of MPK; an
  // outage must never touch it.
  klosok: {
    enabled: bool(process.env.KLOSOK_ENABLED, DEFAULTS.klosok.enabled),
    gtfsRtUrl: process.env.KLOSOK_GTFS_RT_URL || DEFAULTS.klosok.gtfsRtUrl,
    // How often the whole feed is re-fetched (backend-side, never per-client).
    pollIntervalMs: num(process.env.KLOSOK_POLL_INTERVAL_MS, DEFAULTS.klosok.pollIntervalMs),
    timeoutMs: num(process.env.KLOSOK_TIMEOUT_MS, DEFAULTS.klosok.timeoutMs),
    // Positions older than this are dropped from /locations.
    maxAgeMs: num(process.env.KLOSOK_MAX_AGE_MS, DEFAULTS.klosok.maxAgeMs),
    // A Kłosok bus this close to a same-line Wrocław bus at a similar time is
    // the same vehicle — show Kłosok's position, drop the other.
    dedupeMeters: num(process.env.KLOSOK_DEDUPE_METERS, DEFAULTS.klosok.dedupeMeters),
    // Kłosok's certificate chains to Let's Encrypt's new "Root YE", which not
    // every host's CA store carries yet — Node then rejects the leaf while
    // every other upstream works. TLS verification is relaxed for THIS ONE
    // endpoint only (a dedicated undici Agent in src/klosok/fetch.js) by
    // default; set KLOSOK_TLS_ALLOW_INVALID_CERT=false to enforce strict
    // verification once Kłosok serves a chain the hosts trust.
    tlsAllowInvalidCert: bool(process.env.KLOSOK_TLS_ALLOW_INVALID_CERT, DEFAULTS.klosok.tlsAllowInvalidCert),
  },

  alerts: {
    pages: ALERT_PAGES,
    refreshIntervalMs: num(process.env.ALERTS_REFRESH_INTERVAL_MS, DEFAULTS.alerts.refreshIntervalMs),
    timeoutMs: num(process.env.ALERTS_TIMEOUT_MS, DEFAULTS.alerts.timeoutMs),
    maxItems: num(process.env.ALERTS_MAX_ITEMS, DEFAULTS.alerts.maxItems),

    // Alerts and the AI incident cache survive a restart in a JSON file beside
    // the stats snapshot. Without it `/alerts` is empty until the first
    // refresh, anything older than the bridge's window is lost for good, and
    // every incident narrative is regenerated — and paid for — on each boot.
    // `maxItems` still bounds the list, so it bounds the history too.
    archiveEnabled: bool(process.env.ALERTS_ARCHIVE_ENABLED, DEFAULTS.alerts.archiveEnabled),
    archiveDaysToKeep: num(process.env.ALERTS_ARCHIVE_DAYS, DEFAULTS.alerts.archiveDaysToKeep),
    // Optional extra source: @AlertMPK's public posts, read through whatever
    // RSS bridge the operator has — see XBridgeProvider in src/alerts.js.
    // Empty by default, so the provider is not created at all: this used to
    // be hardwired to Nitter, and when Nitter was discontinued the default
    // deploy was left with no alerts source that answers. Shipping another
    // public bridge as the default would only repeat that, so a bridge is
    // something you point at deliberately. Each entry is a URL template
    // carrying {username} (e.g. https://rsshub.example.com/twitter/user/{username});
    // entries are tried in order, same pattern as every other multi-source
    // config here. Configuring ALERT_X_BRIDGE_URLS is what turns this on —
    // ALERT_X_BRIDGE_ENABLED=false keeps it off without deleting the URLs.
    xBridge: {
      enabled: bool(process.env.ALERT_X_BRIDGE_ENABLED, DEFAULTS.alerts.xBridge.enabled),
      bridges: list(process.env.ALERT_X_BRIDGE_URLS, DEFAULTS.alerts.xBridge.bridges),
      username: process.env.ALERT_X_USERNAME || DEFAULTS.alerts.xBridge.username,
      maxPosts: num(process.env.ALERT_X_MAX_POSTS, DEFAULTS.alerts.xBridge.maxPosts),
      timeoutMs: num(process.env.ALERT_X_TIMEOUT_MS, DEFAULTS.alerts.xBridge.timeoutMs),
    },
  },

  aiAlerts: {
    enabled: aiAlertsSelection.enabled,
    provider: aiAlertsSelection.provider,
    requestedProvider: requestedAiProvider,
    cacheTtlMs: num(process.env.AI_ALERTS_CACHE_TTL_MS, DEFAULTS.aiAlerts.cacheTtlMs),
    timeoutMs: num(process.env.AI_ALERTS_TIMEOUT_MS, DEFAULTS.aiAlerts.timeoutMs),
    maxInputAlerts: num(
      process.env.AI_ALERTS_MAX_INPUT_ALERTS,
      DEFAULTS.aiAlerts.maxInputAlerts,
    ),
    temperature: decimal(
      process.env.AI_ALERTS_TEMPERATURE,
      DEFAULTS.aiAlerts.temperature,
    ),
    status: aiAlertsSelection,
    openrouter: {
      apiKey: openrouterApiKey,
      baseUrl: process.env.OPENROUTER_BASE_URL || DEFAULTS.aiAlerts.openrouter.baseUrl,
      model: openrouterModel,
    },
    cmdc: {
      apiKey: cmdcApiKey,
      baseUrl: process.env.CMDC_BASE_URL || DEFAULTS.aiAlerts.cmdc.baseUrl,
      model: cmdcModel,
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || DEFAULTS.aiAlerts.ollama.baseUrl,
      model: ollamaModel,
    },
  },

  fleet: {
    // What a side number is attached to — model, low floor, wheelchair space,
    // air conditioning. No live feed carries any of it (see src/fleet.js), so
    // it comes from a roster file and is null for anything the roster does not
    // name. Turn it off to serve no vehicle attributes at all.
    enabled: bool(process.env.FLEET_ENABLED, DEFAULTS.fleet.enabled),
    // Replaces the bundled Wrocław roster rather than adding to it: an operator
    // running a different fleet must not have this one's models stated for
    // their vehicles.
    rosterPath: process.env.FLEET_ROSTER_PATH || DEFAULTS.fleet.rosterPath,
  },

  cache: {
    // Number of route-shape responses kept in memory.
    shapeEntries: num(process.env.SHAPE_CACHE_ENTRIES, DEFAULTS.cache.shapeEntries),
    // Number of /vehicle/:id detail responses kept in memory. One entry is one
    // (vehicle, limit, history) combination; a position change invalidates it.
    vehicleDetailEntries: num(
      process.env.VEHICLE_DETAIL_CACHE_ENTRIES,
      DEFAULTS.cache.vehicleDetailEntries,
    ),
    // Hard time cap on a cached detail, even for a stationary vehicle. The
    // timetable keeps progressing (delays, ETAs) while a position stays put, so
    // a detail must not be served verbatim forever on a changed schedule.
    // Generation + poll-revision keys carry the coarse invalidation; this is the
    // backstop that bounds staleness when the tracker is not polling.
    vehicleDetailTtlMs: num(
      process.env.VEHICLE_DETAIL_CACHE_TTL_MS,
      DEFAULTS.cache.vehicleDetailTtlMs,
    ),
  },

  // Admin dashboard (/admin). Bearer-token protected; without ADMIN_TOKEN the
  // routes are disabled entirely rather than served open.
  admin: {
    token: process.env.ADMIN_TOKEN || DEFAULTS.admin.token,
  },

  stats: {
    // Usage counting is cheap and independent of the admin page; turn it off
    // only on a host that must not write to disk.
    enabled: bool(process.env.STATS_ENABLED, DEFAULTS.stats.enabled),
    // Where the daily snapshot lives; same directory as the GTFS cache.
    cacheDir: process.env.STATS_CACHE_DIR || cachePath(DEFAULTS.stats.cacheDir),
    // How often the in-memory counts are persisted to disk.
    saveIntervalMs: num(process.env.STATS_SAVE_INTERVAL_MS, DEFAULTS.stats.saveIntervalMs),
    // Calendar days kept for rolling activity totals and daily history.
    daysToKeep: num(process.env.STATS_DAYS_TO_KEEP, DEFAULTS.stats.daysToKeep),
    // One map poll represents this much foreground client time in the
    // identifier-free active-hours estimate.
    clientPollIntervalMs: num(
      process.env.STATS_CLIENT_POLL_INTERVAL_MS,
      DEFAULTS.stats.clientPollIntervalMs,
    ),
    // Days and hours are bucketed in this time zone (Wrocław, matching the
    // GTFS refresh cron).
    timeZone: process.env.STATS_TIMEZONE || DEFAULTS.stats.timeZone,
  },

  userAgent: process.env.HTTP_USER_AGENT || DEFAULTS.userAgent,
};
