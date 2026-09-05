'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * What the alerts service knew, kept across restarts.
 *
 * Everything about alerts used to live in memory only, which cost three
 * different things at once:
 *
 *   - `/alerts` was empty on every boot until the first refresh landed.
 *   - The bridge only ever hands over the last `ALERT_X_MAX_POSTS` posts, so
 *     anything that scrolled off X had no copy anywhere. `?since=` had almost
 *     nothing to answer with.
 *   - Every incident narrative was regenerated from scratch, so a restart
 *     re-paid the AI provider for work it had already done. Three restarts in
 *     five minutes is a normal afternoon on a box being configured, and that
 *     is 24 generations of the same 8 incidents.
 *
 * Same shape as the stats snapshot next to it: one JSON file, written through
 * a temp file and renamed, and treated as a cache rather than a database — a
 * missing or corrupt file costs the history, never the boot.
 */
class AlertArchive {
  /**
   * @param {{ file: string, daysToKeep?: number, logger?: object }} options
   */
  constructor({ file, daysToKeep = 31, logger = null }) {
    this.file = file;
    this.daysToKeep = Math.max(1, daysToKeep);
    this.logger = logger;
  }

  /** Alerts older than this are dropped on both read and write. */
  #cutoff(now = Date.now()) {
    return now - this.daysToKeep * 24 * 60 * 60 * 1000;
  }

  /**
   * @param {number} [now]
   * @returns {{ alerts: object[], aiCache: [string, { incidents: object[], expiresAt: number }][] }}
   */
  load(now = Date.now()) {
    const empty = { alerts: [], aiCache: [] };

    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return empty;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger?.warn(`Ignoring unreadable alert archive at ${this.file}`);
      return empty;
    }

    const cutoff = this.#cutoff(now);
    const alerts = (Array.isArray(parsed?.alerts) ? parsed.alerts : []).filter(
      (alert) =>
        alert &&
        typeof alert.id === 'string' &&
        Number.isFinite(alert.timestamp) &&
        alert.timestamp >= cutoff,
    );

    // An expired cache entry is worse than a missing one: it would serve a
    // narrative the operator has already waited out the TTL on.
    const aiCache = (Array.isArray(parsed?.aiCache) ? parsed.aiCache : []).filter(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        Array.isArray(entry[1]?.incidents) &&
        Number.isFinite(entry[1]?.expiresAt) &&
        entry[1].expiresAt > now,
    );

    return { alerts, aiCache };
  }

  /**
   * @param {{ alerts: object[], aiCache: Map<string, object> }} state
   * @param {number} [now]
   */
  save({ alerts, aiCache }, now = Date.now()) {
    const cutoff = this.#cutoff(now);
    const payload = {
      savedAt: new Date(now).toISOString(),
      alerts: (alerts ?? []).filter((alert) => (alert?.timestamp ?? 0) >= cutoff),
      aiCache: [...(aiCache ?? new Map())].filter(([, entry]) => (entry?.expiresAt ?? 0) > now),
    };

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (error) {
      // Losing the archive must never take the refresh down with it: the
      // service works without one, just colder.
      this.logger?.warn(`Could not save the alert archive: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { AlertArchive };
