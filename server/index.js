'use strict';

const cron = require('node-cron');
const path = require('node:path');

const config = require('./src/config');
const logger = require('./src/logger');
const { createApp } = require('./src/app');
const { AlertsService } = require('./src/alerts');
const { GtfsStore } = require('./src/gtfs/store');
const { KdService } = require('./src/kd/service');
const { KlosokService } = require('./src/klosok/service');
const { StatsTracker } = require('./src/stats');
const { VehicleTracker } = require('./src/vehicles');
const { shapeCache } = require('./src/routes');

logger.setLevel(config.logLevel);

const gtfs = new GtfsStore();
// The tracker reads the store to work out where each vehicle is headed and
// which stops it has left to serve.
const vehicles = new VehicleTracker(() => gtfs.lines, { gtfs });
// Alerts match line numbers against the lines that actually exist in the
// timetable, so the matcher reads them from the store on every refresh.
const alerts = new AlertsService(
  () => new Set([...gtfs.routesByLine.keys()].map((line) => line.toUpperCase())),
);

// Koleje Dolnośląskie is a standalone provider. Its GTFS-RT poll and static
// refresh are independent of Wrocław's, so a KD outage must never hold up the
// MPK tracker below — hence it starts separately and fails soft.
const kd = new KdService();

// PT KŁOSOK is a live-position source with no timetable of its own: its buses
// are matched against the Wrocław GTFS above, and it is merged into the MPK +
// Open Data fleet by the KlosokService (dedup included). Like KD it starts
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
  kd.stop();
  klosok.stop();
  stats?.stop();
};

/**
 * Load the timetable, retrying with backoff. The HTTP server is already
 * listening while this runs, so /health can report progress instead of the
 * process dying on a bad upstream — which is exactly what used to happen.
 */
const loadGtfs = async (attempt = 0) => {
  // KD is independent of Wrocław's timetable: it must boot (and be retried)
  // even when the Wrocław feed is down, and its own failures must never delay
  // or crash the Wrocław half. Kłosok is the same deal: its positions cannot
  // be named until the timetable is here, but its poll must not be held back
  // by the download below, and its failures must not stop it either.
  if (attempt === 0) {
    kd.start().catch((error) => logger.error(`KD start failed: ${error.message}`));
    klosok.start().catch((error) => logger.error(`Kłosok start failed: ${error.message}`));
  }
  try {
    await gtfs.refresh();
    shapeCache.clear();
    vehicles.start();
    alerts.start();
  } catch {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    logger.warn(`Retrying GTFS load in ${delay / 1000}s`);
    setTimeout(() => loadGtfs(attempt + 1), delay).unref?.();
  }
};

const start = () => {
  const app = createApp({ gtfs, vehicles, alerts, kd, klosok, stats, startedAt: new Date() });
  stats?.start();

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
  });

  loadGtfs();

  scheduledRefresh = cron.schedule(
    config.gtfs.refreshCron,
    () => {
      logger.info('Scheduled GTFS refresh');
      gtfs
        .refresh()
        .then(() => shapeCache.clear())
        .catch(() => {});
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

module.exports = { alerts, createApp, gtfs, kd, klosok, start, stopBackgroundWork, vehicles };
