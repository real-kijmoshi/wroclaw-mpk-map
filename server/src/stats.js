'use strict';

const fs = require('node:fs');
const path = require('node:path');

const logger = require('./logger');

const DEFAULT_TIMEZONE = 'Europe/Warsaw';
const SCHEMA_VERSION = 2;
const HOUR_MS = 60 * 60 * 1000;

// Browser and admin traffic must not count as app activity: /health is polled
// every 10 s by the status page, /map is a second client, and an admin
// refreshing their own dashboard should not register as a rider.
const EXCLUDED_PATTERNS = new Set(['/', '/health', '/status', '/map', '/admin']);

const makeFormatters = (timeZone) => ({
  // en-CA formats dates as YYYY-MM-DD, which sorts and keys cleanly.
  day: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
  hour: new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false, hourCycle: 'h23' }),
});

const dayKey = (date, formatters) => formatters.day.format(date);

const hourOf = (date, formatters) => Number.parseInt(formatters.hour.format(date), 10);

/**
 * Identifier-free usage stats for the admin dashboard.
 *
 * The tracker deliberately never reads an IP address, cookie, user agent or
 * other client identifier. App activity is approximated from completed
 * `/locations?format=map` polls: each poll represents one configured polling
 * interval of foreground use. This produces active client-hours, not a count
 * of people or devices. Counting is per calendar day in the configured time
 * zone (Europe/Warsaw by default, matching the GTFS refresh cron). The last
 * `daysToKeep` days are held in memory and snapshotted to a JSON file.
 *
 * Persistence is deliberately synchronous: `stop()` saves during shutdown and
 * the process may exit right after, so a queued async write could be lost.
 */
class StatsTracker {
  constructor({
    file = null,
    daysToKeep = 31,
    saveIntervalMs = 300_000,
    timeZone = DEFAULT_TIMEZONE,
    clientPollIntervalMs = 10_000,
    now = () => new Date(),
  } = {}) {
    this.file = file;
    this.daysToKeep = Math.max(1, daysToKeep);
    this.saveIntervalMs = saveIntervalMs;
    this.clientPollIntervalMs = Math.max(1, clientPollIntervalMs);
    this.now = now;
    this.formatters = makeFormatters(timeZone);
    this.days = new Map();
    this.timer = null;
    this.load();
  }

  emptyDay() {
    return { requests: 0, mapPolls: 0, endpoints: new Map(), hours: new Map() };
  }

  prune() {
    // Keys are YYYY-MM-DD, so lexical sort is chronological.
    const keys = [...this.days.keys()].sort();
    while (this.days.size > this.daysToKeep) {
      this.days.delete(keys.shift());
    }
  }

  today() {
    const key = dayKey(this.now(), this.formatters);
    let day = this.days.get(key);
    if (!day) {
      day = this.emptyDay();
      this.days.set(key, day);
      this.prune();
    }
    return day;
  }

  isExcluded(pattern) {
    if (EXCLUDED_PATTERNS.has(pattern)) return true;
    return pattern.startsWith('/admin/');
  }

  /**
   * Count one finished request.
   *
   * The middleware registers a `finish` listener, so `req.route` is already set
   * by the time this runs — patterns like `/vehicle/:id` group every vehicle
   * into one bucket instead of one per id.
   */
  record(req) {
    const route = req.route;
    if (!route) return;
    const pattern = typeof route.path === 'string' ? route.path : String(route.path);
    if (this.isExcluded(pattern)) return;

    const day = this.today();
    day.requests += 1;
    day.endpoints.set(pattern, (day.endpoints.get(pattern) ?? 0) + 1);
    const hour = hourOf(this.now(), this.formatters);
    day.hours.set(hour, (day.hours.get(hour) ?? 0) + 1);
    if (pattern === '/locations' && req.query?.format === 'map') day.mapPolls += 1;
  }

  snapshot() {
    const recent = [...this.days.keys()].sort().slice(-this.daysToKeep);
    const todayKey = dayKey(this.now(), this.formatters);
    const todayDay = this.days.get(todayKey);

    const requestsIn = (keys) => keys.reduce((sum, key) => sum + this.days.get(key).requests, 0);
    const mapPollsIn = (keys) => keys.reduce((sum, key) => sum + this.days.get(key).mapPolls, 0);
    const activeClientHours = (polls) => (polls * this.clientPollIntervalMs) / HOUR_MS;
    const lastDays = (n) => recent.slice(-n);

    const topEndpointsToday = [...(todayDay?.endpoints ?? [])]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([endpoint, count]) => ({ endpoint, count }));

    return {
      today: todayKey,
      generatedAt: this.now().toISOString(),
      activeClientHoursToday: activeClientHours(todayDay?.mapPolls ?? 0),
      activeClientHours7d: activeClientHours(mapPollsIn(lastDays(7))),
      activeClientHours30d: activeClientHours(mapPollsIn(lastDays(30))),
      requestsToday: todayDay?.requests ?? 0,
      requests7d: requestsIn(lastDays(7)),
      requests30d: requestsIn(lastDays(30)),
      daysTracked: this.days.size,
      topEndpointsToday,
      daily: recent.slice(-14).map((key) => ({
        date: key,
        requests: this.days.get(key).requests,
        mapPolls: this.days.get(key).mapPolls,
        activeClientHours: activeClientHours(this.days.get(key).mapPolls),
      })),
      hourly: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        requests: todayDay?.hours.get(hour) ?? 0,
      })),
    };
  }

  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      logger.warn(`Stats cache is invalid and will be discarded: ${error.message}`);
      this.purgeLegacySnapshot();
      return;
    }
    if (data?.schemaVersion !== SCHEMA_VERSION) {
      this.purgeLegacySnapshot();
      return;
    }
    try {
      for (const [key, value] of Object.entries(data.days ?? {})) {
        const day = this.emptyDay();
        day.requests = value.requests ?? 0;
        day.mapPolls = value.mapPolls ?? 0;
        for (const [endpoint, count] of Object.entries(value.endpoints ?? {})) {
          day.endpoints.set(endpoint, count);
        }
        for (const [hour, count] of Object.entries(value.hours ?? {})) {
          day.hours.set(Number(hour), count);
        }
        this.days.set(key, day);
      }
      this.prune();
    } catch (error) {
      logger.warn(`Stats cache is invalid and will be discarded: ${error.message}`);
      this.purgeLegacySnapshot();
    }
  }

  /** Remove an old snapshot in full so no previously stored IP set survives. */
  purgeLegacySnapshot() {
    this.days.clear();
    logger.warn('Discarding legacy stats history to remove stored client identifiers');
    try {
      fs.unlinkSync(this.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.save({ throwOnError: true });
  }

  save({ throwOnError = false } = {}) {
    if (!this.file) return;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: this.now().toISOString(),
      days: Object.fromEntries(
        [...this.days].map(([key, day]) => [
          key,
          {
            requests: day.requests,
            mapPolls: day.mapPolls,
            endpoints: Object.fromEntries(day.endpoints),
            hours: Object.fromEntries([...day.hours].sort((a, b) => a[0] - b[0])),
          },
        ]),
      ),
    };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Atomic: rename over the real file so a crash mid-write cannot leave a
      // truncated snapshot that reads as "no activity at all".
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      if (throwOnError) throw error;
      logger.warn(`Stats cache save failed: ${error.message}`);
    }
  }

  start() {
    if (this.timer || !this.file || this.saveIntervalMs <= 0) return;
    this.timer = setInterval(() => this.save(), this.saveIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

module.exports = { StatsTracker, dayKey, hourOf };
