'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const logger = require('./logger');
const { fetchWithTimeout } = require('./http');

/**
 * Who wants to be told when a line they ride goes wrong.
 *
 * The copy this sends was already being written and thrown away: every AI
 * incident carries `shortNotificationTitle` and `shortNotificationBody`,
 * clamped to 60 and 120 characters in `ai-incidents.js` — lengths that are
 * only meaningful on a lock screen. Nothing consumed them. This is the
 * consumer.
 *
 * Deliberately small: an Expo push token, the lines its owner follows, and
 * nothing else. No account, no device id, no position — the token *is* the
 * identity, revoking it is uninstalling the app, and there is nothing here
 * worth breaching. Same file-and-rename persistence as the alert archive
 * next to it, and the same rule: it is a cache of intent, so an unreadable
 * file costs the subscriptions and never the boot.
 *
 * The one thing it must never do is announce the backlog. An incident that
 * was already known before a restart has been on the rider's screen for
 * hours; sending it again because the process came back is the failure mode
 * that gets an app's notifications turned off for good. `sent` is persisted
 * for exactly that reason, and a registry whose file has never carried one
 * primes itself instead of firing.
 */

/**
 * Expo's own token format. Anything else is a client bug or someone poking at
 * the endpoint, and neither belongs in the file.
 */
const TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9._%+-]{1,128}\]$/;

/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;

const isValidToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

/** Lines, normalised: a bounded list of short non-empty strings, deduped. */
const cleanLines = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const line = entry.trim();
    if (!line || line.length > 8) continue;
    seen.add(line);
    if (seen.size >= 60) break;
  }
  return [...seen];
};

class PushRegistry {
  /**
   * @param {{ file: string, enabled?: boolean, endpoint?: string, timeoutMs?: number,
   *           maxSubscriptions?: number, fetchImpl?: Function, logger?: object }} options
   */
  constructor(options = {}) {
    this.file = options.file ?? config.push.file;
    this.enabled = options.enabled ?? config.push.enabled;
    this.endpoint = options.endpoint ?? config.push.endpoint;
    this.timeoutMs = options.timeoutMs ?? config.push.timeoutMs;
    this.maxSubscriptions = options.maxSubscriptions ?? config.push.maxSubscriptions;
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.logger = options.logger ?? logger;

    /** @type {Map<string, {token: string, platform: string|null, lines: string[], updatedAt: number}>} */
    this.subscriptions = new Map();
    /** @type {Map<string, number>} incident id -> the lastUpdatedAt already sent for it */
    this.sent = new Map();
    /** True once a file with a `sent` map has been read, or one has been written. */
    this.primed = false;

    this.status = {
      enabled: this.enabled,
      subscriptions: 0,
      lastSentAt: null,
      lastError: null,
      sentCount: 0,
      droppedTokens: 0,
    };
  }

  /** Read the file. Called once at start; never throws. */
  load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // No file yet is the normal first boot, and an unreadable one is a
      // cache miss. Either way the registry starts empty and unprimed.
      return this;
    }

    for (const entry of Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []) {
      if (!isValidToken(entry?.token)) continue;
      this.subscriptions.set(entry.token, {
        token: entry.token,
        platform: typeof entry.platform === 'string' ? entry.platform : null,
        lines: cleanLines(entry.lines),
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
      });
    }

    if (parsed?.sent && typeof parsed.sent === 'object') {
      for (const [id, at] of Object.entries(parsed.sent)) {
        if (Number.isFinite(at)) this.sent.set(id, at);
      }
      // A file that carries a `sent` map has already decided what is old news,
      // so this process may send. One that does not is a fresh install.
      this.primed = true;
    }

    this.status.subscriptions = this.subscriptions.size;
    return this;
  }

  save() {
    const payload = {
      savedAt: new Date().toISOString(),
      subscriptions: [...this.subscriptions.values()],
      sent: Object.fromEntries(this.sent),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.file);
      return { ok: true };
    } catch (error) {
      this.logger?.warn(`Could not save push subscriptions: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Add or replace a subscription.
   *
   * Re-registering the same token replaces its lines rather than adding a
   * second row: a phone has one token and one set of followed lines, and the
   * app re-registers on every change.
   *
   * @returns {{ ok: true, subscription: object } | { ok: false, error: string }}
   */
  register({ token, platform = null, lines = [] } = {}) {
    if (!isValidToken(token)) return { ok: false, error: 'Invalid Expo push token' };
    if (!this.subscriptions.has(token) && this.subscriptions.size >= this.maxSubscriptions) {
      return { ok: false, error: 'Too many subscriptions' };
    }

    const subscription = {
      token,
      platform: typeof platform === 'string' ? platform.slice(0, 16) : null,
      lines: cleanLines(lines),
      updatedAt: Date.now(),
    };
    this.subscriptions.set(token, subscription);
    this.status.subscriptions = this.subscriptions.size;
    this.save();
    return { ok: true, subscription };
  }

  /** Forget a token. Unsubscribing something already gone is a success. */
  unregister(token) {
    const existed = this.subscriptions.delete(token);
    this.status.subscriptions = this.subscriptions.size;
    if (existed) this.save();
    return { ok: true, removed: existed };
  }

  /** What a token is currently following, or null. */
  get(token) {
    return this.subscriptions.get(token) ?? null;
  }

  /**
   * Record every incident as already delivered, without delivering any.
   *
   * The boot path: the archive restores incidents that are hours old, and a
   * restart is not news. Also the first-run path, which is why `load()`
   * leaves `primed` false when it finds no `sent` map.
   */
  prime(incidents) {
    for (const incident of incidents ?? []) {
      if (typeof incident?.id === 'string') {
        this.sent.set(incident.id, incident.lastUpdatedAt ?? 0);
      }
    }
    this.primed = true;
    this.save();
  }

  /**
   * Which incidents are new, or have moved on since they were last sent.
   *
   * An update to a running incident is worth a second notification — "tram 4
   * is back through Rynek" is the message people actually wait for — so the
   * comparison is on `lastUpdatedAt`, not merely on the id.
   */
  #unsent(incidents) {
    return (incidents ?? []).filter((incident) => {
      if (typeof incident?.id !== 'string') return false;
      const previous = this.sent.get(incident.id);
      return previous === undefined || (incident.lastUpdatedAt ?? 0) > previous;
    });
  }

  /**
   * The message for one incident.
   *
   * Prefers the AI's lock-screen copy and falls back to the incident's own
   * title, cut. `splitHeadline()` already guarantees title and detail do not
   * repeat each other, so there is nothing to de-duplicate here.
   */
  #message(incident) {
    const title =
      incident.shortNotificationTitle ||
      incident.title ||
      (incident.affected?.length ? `Utrudnienia: ${incident.affected.join(', ')}` : 'Utrudnienia');
    const body =
      incident.shortNotificationBody ||
      incident.summary ||
      incident.timeline?.[0]?.detail ||
      '';
    return {
      title: String(title).slice(0, 80),
      body: String(body).slice(0, 160),
    };
  }

  /** Does this subscription want to hear about this incident? */
  static #wants(subscription, incident) {
    // No lines chosen means the whole network, which is what a rider who has
    // not picked any lines yet is asking for.
    if (!subscription.lines.length) return true;
    const affected = incident.affected ?? [];
    return affected.some((line) => subscription.lines.includes(line));
  }

  /**
   * Send what is new to whoever asked for it.
   *
   * Fail-soft throughout: this runs on the tail of an alerts refresh and must
   * never be the reason /alerts did not update.
   *
   * @returns {Promise<{sent: number, skipped: string|null}>}
   */
  async notifyIncidents(incidents) {
    if (!this.enabled) return { sent: 0, skipped: 'disabled' };

    if (!this.primed) {
      // First run against a registry that has never sent anything: adopt the
      // current state as the baseline rather than announcing all of it.
      this.prime(incidents);
      return { sent: 0, skipped: 'primed' };
    }

    const fresh = this.#unsent(incidents);
    if (!fresh.length) return { sent: 0, skipped: null };

    // Mark before sending. A crash mid-send costs one notification; not
    // marking costs the whole backlog again on the next refresh.
    for (const incident of fresh) this.sent.set(incident.id, incident.lastUpdatedAt ?? 0);

    const messages = [];
    for (const incident of fresh) {
      const { title, body } = this.#message(incident);
      for (const subscription of this.subscriptions.values()) {
        if (!PushRegistry.#wants(subscription, incident)) continue;
        messages.push({
          to: subscription.token,
          title,
          body,
          sound: 'default',
          priority: 'high',
          // Android needs a channel to show anything at all; the app creates
          // one with this id at startup.
          channelId: 'alerts',
          data: { type: 'incident', incidentId: incident.id, lines: incident.affected ?? [] },
        });
      }
    }

    this.#forget(incidents);
    this.save();

    if (!messages.length) return { sent: 0, skipped: null };

    let delivered = 0;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      // Sequential on purpose: Expo rate-limits per request, and firing every
      // batch at once is what gets a project throttled.
      delivered += await this.#send(messages.slice(i, i + BATCH_SIZE));
    }

    this.status.sentCount += delivered;
    if (delivered) this.status.lastSentAt = new Date().toISOString();
    return { sent: delivered, skipped: null };
  }

  /** One batch. Returns how many Expo accepted. */
  async #send(batch) {
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        timeoutMs: this.timeoutMs,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
    } catch (error) {
      this.status.lastError = error.message;
      this.logger?.warn(`Push delivery failed: ${error.message}`);
      return 0;
    }

    if (!response.ok) {
      this.status.lastError = `Expo answered ${response.status}`;
      this.logger?.warn(`Push delivery failed: Expo answered ${response.status}`);
      return 0;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      this.status.lastError = `Unreadable Expo response: ${error.message}`;
      return 0;
    }

    const tickets = Array.isArray(payload?.data) ? payload.data : [];
    let accepted = 0;
    let dropped = false;

    tickets.forEach((ticket, index) => {
      if (ticket?.status === 'ok') {
        accepted += 1;
        return;
      }
      // The one error worth acting on: the app is gone from that phone, and
      // keeping the token means paying for a failed send on every incident
      // from here to the heat death of the file.
      if (ticket?.details?.error === 'DeviceNotRegistered') {
        this.subscriptions.delete(batch[index]?.to);
        this.status.droppedTokens += 1;
        dropped = true;
      }
    });

    if (dropped) {
      this.status.subscriptions = this.subscriptions.size;
      this.save();
    }
    this.status.lastError = accepted === tickets.length ? null : 'Some pushes were rejected';
    return accepted;
  }

  /**
   * Drop `sent` entries for incidents nobody will hear about again.
   *
   * Without this the map is the only thing here that grows forever. An
   * incident id that has not come back in a month is closed — but an id still
   * in the current list is *not*, however old its last update. Wrocław has
   * roadworks that run all summer, and ageing one of those out of `sent`
   * re-announces a closure the rider has known about since June.
   */
  #forget(incidents) {
    const live = new Set((incidents ?? []).map((incident) => incident?.id));
    const cutoff = Date.now() - 31 * 86_400_000;
    for (const [id, at] of this.sent) {
      if (live.has(id)) continue;
      if (at && at < cutoff) this.sent.delete(id);
    }
  }
}

module.exports = { PushRegistry, TOKEN_PATTERN };
