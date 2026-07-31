'use strict';

const cron = require('node-cron');

const config = require('./src/config');
const logger = require('./src/logger');
const { createApp } = require('./src/app');
const { AlertsService } = require('./src/alerts');
const { GtfsStore } = require('./src/gtfs/store');
const { VehicleTracker } = require('./src/vehicles');
const { shapeCache } = require('./src/routes');

logger.setLevel(config.logLevel);

const gtfs = new GtfsStore();
const vehicles = new VehicleTracker(() => gtfs.lines);
// Alerts match line numbers against the lines that actually exist in the
// timetable, so the matcher reads them from the store on every refresh.
const alerts = new AlertsService(
  () => new Set([...gtfs.routesByLine.keys()].map((line) => line.toUpperCase())),
);

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
};

/**
 * Load the timetable, retrying with backoff. The HTTP server is already
 * listening while this runs, so /health can report progress instead of the
 * process dying on a bad upstream — which is exactly what used to happen.
 */
const loadGtfs = async (attempt = 0) => {
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
  const app = createApp({ gtfs, vehicles, alerts, startedAt: new Date() });

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

module.exports = { alerts, createApp, gtfs, start, stopBackgroundWork, vehicles };
