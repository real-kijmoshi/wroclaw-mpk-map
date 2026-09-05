'use strict';

const cron = require('node-cron');
const path = require('node:path');

const config = require('./src/config');
const logger = require('./src/logger');
const { createApp } = require('./src/app');
const { AlertsService } = require('./src/alerts');
const { AlertArchive } = require('./src/alert-archive');
const { GtfsStore } = require('./src/gtfs/store');
const { KlosokService } = require('./src/klosok/service');
const { RuntimeSettings } = require('./src/runtime-settings');
const { StatsTracker } = require('./src/stats');
const { VehicleTracker } = require('./src/vehicles');

// Shape and vehicle-detail caches are keyed on `gtfs.generation`, which only
// advances on a successful atomic snapshot install. A refresh therefore
// invalidates them by key change rather than by being cleared here — and a
// failed refresh must not clear anything at all.
logger.setLevel(config.logLevel);

const gtfs = new GtfsStore();
// The tracker reads the store to work out where each vehicle is headed and
// which stops it has left to serve.
const vehicles = new VehicleTracker(() => gtfs.lines, { gtfs });
// Alerts match line numbers against the lines that actually exist in the
// timetable, so the matcher reads them from the store on every refresh.
const alerts = new AlertsService(
  () => new Set([...gtfs.routesByLine.keys()].map((line) => line.toUpperCase())),
  null,
  {
    archive: config.alerts.archiveEnabled
      ? new AlertArchive({
          file: path.join(config.stats.cacheDir, 'alert-archive.json'),
          daysToKeep: config.alerts.archiveDaysToKeep,
          logger,
        })
      : null,
  },
);

// The one setting the dashboard may change while running. Loaded before the
// first refresh so an override applies to the very first batch of incidents
// rather than to the second, five minutes later.
const runtimeSettings = new RuntimeSettings({ cacheDir: config.stats.cacheDir, logger });
runtimeSettings.load();

// PT KŁOSOK is a live-position source with no timetable of its own: its buses
// are matched against the Wrocław GTFS above, and it is merged into the MPK +
// Open Data fleet by the KlosokService (dedup included). It starts
// separately and fails soft, so an outage must never hold up MPK.
const klosok = new KlosokService({
  gtfs,
  getWroclawLocations: () => vehicles.snapshot.locations,
});

// Usage stats for the admin dashboard. Null when disabled, so /admin stays off
// everywhere — not just behind the token check.
const stats = config.stats.enabled
  ? new StatsTracker({
      file: path.join(config.stats.cacheDir, 'stats.json'),
      daysToKeep: config.stats.daysToKeep,
      saveIntervalMs: config.stats.saveIntervalMs,
      timeZone: config.stats.timeZone,
      clientPollIntervalMs: config.stats.clientPollIntervalMs,
    })
  : null;

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

/** Held so tests (and the shutdown path) can stop the timers they schedule. */
let scheduledRefresh = null;

/**
 * Stop every recurring timer.
 *
 * Without this the cron task keeps the event loop alive forever, so a test that
 * boots the server never exits.
 */
const stopBackgroundWork = () => {
  scheduledRefresh?.stop();
  scheduledRefresh = null;
  vehicles.stop();
  alerts.stop();
  klosok.stop();
  stats?.stop();
};

/**
 * Load the timetable, retrying with backoff. The HTTP server is already
 * listening while this runs, so /health can report progress instead of the
 * process dying on a bad upstream — which is exactly what used to happen.
 */
const loadGtfs = async (attempt = 0) => {
  // Kłosok is independent of Wrocław's timetable: it starts on the first
  // attempt and its poll must not be held back by the download below, and its
  // failures must not stop it either.
  if (attempt === 0) {
    klosok.start();
  }
  try {
    await gtfs.refresh();
    vehicles.start();
    alerts.start();
  } catch {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    logger.warn(`Retrying GTFS load in ${delay / 1000}s`);
    setTimeout(() => loadGtfs(attempt + 1), delay).unref?.();
  }
};

const start = () => {
  const app = createApp({
    gtfs,
    vehicles,
    alerts,
    klosok,
    stats,
    runtimeSettings,
    startedAt: new Date(),
  });
  stats?.start();

  // A stored override that disagrees with .env is announced rather than
  // applied quietly. A setting that silently contradicts the environment is
  // the shape of failure this project keeps re-learning (invariant 1), so the
  // boot log says which model is really in use and where it came from.
  const storedModel = runtimeSettings.values.aiModel;
  if (storedModel) {
    const envModel = config.aiAlerts[config.aiAlerts.requestedProvider]?.model ?? null;
    const applied = alerts.setAiModel(storedModel);
    if (!applied.ok) {
      logger.warn(`Stored AI model "${storedModel}" rejected (${applied.error}); using .env`);
    } else if (storedModel !== envModel) {
      logger.warn(
        `AI model overridden from the dashboard: ${storedModel} (.env says ${envModel ?? 'nothing'}) ` +
          `— delete ${runtimeSettings.file} to go back`,
      );
    }
  }

  if (!config.admin.token) {
    logger.warn('ADMIN_TOKEN is not set — /admin is disabled. Set it to enable the stats dashboard.');
  }

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Listening on http://${config.host}:${config.port}`);
    logger.info(
      config.gtfs.overrideUrls.length
        ? `GTFS pinned to ${config.gtfs.overrideUrls.join(', ')} (discovery disabled)`
        : `GTFS catalogue: ${config.gtfs.catalogueUrl}`,
    );
    logger.info(`Vehicle sources: ${config.vehicles.sources.join(', ')}`);
    // Alerts are the one source that ships unconfigured, so this line is the
    // difference between "nothing is happening" and "nothing is happening
    // because you have not pointed it anywhere" — the boot log already names
    // every other upstream, and this one was missing from it.
    const alertSources = alerts.providers.map((provider) => provider.name);
    if (alertSources.length) {
      logger.info(`Alert sources: ${alertSources.join(', ')}`);
    } else {
      logger.warn(
        'No alerts source configured — /alerts will stay empty. Set ALERT_X_BRIDGE_URLS ' +
          'to an RSS bridge for @AlertMPK; see server/.env.example.',
      );
    }
  });

  loadGtfs();

  scheduledRefresh = cron.schedule(
    config.gtfs.refreshCron,
    () => {
      logger.info('Scheduled GTFS refresh');
      // Caches are generation-keyed (see vehicle-detail-cache.js and the
      // shape cache key in routes.js), so a successful refresh invalidates them
      // automatically — no clear() needed, and a failed refresh must not clear
      // the working caches at all.
      gtfs.refresh().catch(() => {});
    },
    { timezone: 'Europe/Warsaw' },
  );

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    stopBackgroundWork();
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));

  return server;
};

if (require.main === module) start();

module.exports = { alerts, createApp, gtfs, klosok, start, stopBackgroundWork, vehicles };
