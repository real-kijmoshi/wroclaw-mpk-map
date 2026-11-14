'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Disruption notifications pushed over APNs, so they arrive with the app closed.
 *
 * The app's own disruption notifications are local: it announces what its
 * incidents poll just fetched. With the app closed that poll only runs when
 * iOS wakes it for a background task, which is rare, and an AlertMPK incident
 * is often active for a quarter of an hour — so a rider with the setting on
 * heard about almost nothing. This service is the timely half: the app
 * registers its device token with the scope it chose, and every pass over the
 * incidents pushes the new ones to the phones that asked for them. When it
 * answers 503 (no APNs key), the app goes on announcing locally as before.
 *
 * The rules are the app's (`wroclive/src/lib/incident-alert-plan.ts`), with
 * one difference in what "new" means. An incident's id is a hash of its
 * source posts, so it changes whenever another post joins the cluster; keyed
 * on the id, the same closure would be announced again with every update. It
 * is new here only when none of its source posts has been seen before.
 *
 * What is kept: the token, the scope ("mine" and its lines, or "all") and when
 * it was switched on — nothing else about the phone or the rider. It is kept
 * on disk beside the alert archive, because a deploy that forgot every token
 * would silence every subscriber until each one happened to open the app.
 */

const MAX_AGE_MS = 3 * 60 * 60 * 1_000;
const MAX_SEPARATE = 3;
/** How long a source post is remembered — longer than any incident lasts. */
const SEEN_TTL_MS = 3 * 24 * 60 * 60 * 1_000;
const TOKEN_PATTERN = /^[0-9a-f]{32,256}$/i;
const LINE_PATTERN = /^[0-9A-Z]{1,6}$/i;
const MODES = new Set(['mine', 'all']);
/**
 * A registration nobody has refreshed in this long is dropped. The app
 * registers again on every launch, so only a phone that has not opened the
 * app in a month — or a token that never belonged to one — reaches it.
 */
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** APNs answers that mean the token will never work again. */
const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const clean = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Validate a registration body. Returns the record or an error string. */
function parseDevice(body) {
  if (!body || typeof body !== 'object') return 'expected a JSON body';
  const token = clean(body.token, 256);
  if (!TOKEN_PATTERN.test(token)) return 'token must be a hex push token';
  const mode = clean(body.mode, 8);
  if (!MODES.has(mode)) return 'mode must be mine or all';
  const lines = Array.isArray(body.lines)
    ? [...new Set(body.lines.map((line) => clean(line, 6).toUpperCase()).filter((line) => LINE_PATTERN.test(line)))].slice(0, 300)
    : [];
  return { token, mode, lines };
}

/**
 * Which incidents are new this pass: active, recent, and made only of posts
 * not seen before. Returns them newest first, and the seen-set to keep.
 */
function freshIncidents(incidents, seen, now) {
  const next = {};
  for (const [id, at] of Object.entries(seen)) {
    if (Number.isFinite(at) && now - at < SEEN_TTL_MS) next[id] = at;
  }
  const fresh = [];
  for (const incident of incidents) {
    const sources = (incident.sourceAlertIds ?? []).map(String);
    if (sources.length === 0) continue;
    const known = sources.some((id) => id in next);
    // Remembered whatever its status: a post that arrived as a "ruch
    // normalny" must not turn into news when the cluster is re-read.
    for (const id of sources) next[id] ??= now;
    if (known || incident.status !== 'active') continue;
    if (!Number.isFinite(incident.firstSeenAt) || now - incident.firstSeenAt > MAX_AGE_MS) continue;
    fresh.push(incident);
  }
  fresh.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  return { fresh, seen: next };
}

/** What one device is sent from this pass's fresh incidents. */
function planForDevice(device, fresh) {
  // An empty "mine" is the map showing every line, so it is every line here too.
  const wanted = device.mode === 'mine' && device.lines.length > 0 ? new Set(device.lines) : null;
  const matching = fresh.filter(
    (incident) =>
      incident.firstSeenAt >= device.enabledAt &&
      (!wanted || (incident.affected ?? []).some((line) => wanted.has(String(line).toUpperCase()))),
  );
  if (matching.length <= MAX_SEPARATE) return { separate: matching, summarised: 0 };
  return { separate: matching.slice(0, MAX_SEPARATE - 1), summarised: matching.length - (MAX_SEPARATE - 1) };
}

/** Polish plural, as `plural()` in the app's format.ts. */
function plural(count, [one, few, many]) {
  if (count === 1) return one;
  const tens = count % 100;
  const units = count % 10;
  if (units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14)) return few;
  return many;
}

/** The same wording the app's local notification uses (`announce()` in incident-alerts.ts). */
function incidentAlert(incident) {
  const affected = incident.affected ?? [];
  const lines = affected.slice(0, 4).join(', ');
  const title =
    clean(incident.shortNotificationTitle, 120) ||
    (lines ? `Utrudnienia: ${affected.length > 1 ? 'linie' : 'linia'} ${lines}` : 'Utrudnienia w komunikacji');
  const body = clean(incident.shortNotificationBody, 240) || clean(incident.title, 240);
  return { title, body };
}

class IncidentPushService {
  /**
   * @param {{ apns: import('./apns').ApnsClient | null, alerts: { getIncidents: Function },
   *   bundleId: string, file?: string | null, maxDevices?: number, logger?: object }} options
   */
  constructor({ apns, alerts, bundleId, file = null, maxDevices = 20_000, deviceTtlMs = DEVICE_TTL_MS, logger = null }) {
    this.apns = apns;
    this.alerts = alerts;
    this.topic = bundleId;
    this.file = file;
    this.maxDevices = maxDevices;
    this.deviceTtlMs = deviceTtlMs;
    this.logger = logger;
    /** token → { token, mode, lines, enabledAt, updatedAt } */
    this.devices = new Map();
    /** source alert id → when first seen */
    this.seen = {};
    /**
     * Whether `seen` reflects what has already been announced. Without a file
     * the first pass only learns what is there: announcing every active
     * incident on a fresh deploy would buzz every subscriber with old news.
     */
    this.primed = false;
    this.timer = null;
    this.saveTimer = null;
    this.stats = { pushed: 0, failed: 0, removed: 0, lastError: null, lastPassAt: null };
  }

  get enabled() {
    return Boolean(this.apns?.configured);
  }

  load(now = Date.now()) {
    if (!this.file) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    for (const entry of Array.isArray(parsed?.devices) ? parsed.devices : []) {
      const device = parseDevice(entry);
      if (typeof device === 'string' || !Number.isFinite(entry.enabledAt)) continue;
      if (Number.isFinite(entry.updatedAt) && now - entry.updatedAt > this.deviceTtlMs) continue;
      this.devices.set(device.token, { ...device, enabledAt: entry.enabledAt, updatedAt: entry.updatedAt ?? now });
    }
    if (parsed?.seen && typeof parsed.seen === 'object') {
      this.seen = freshIncidents([], parsed.seen, now).seen;
      this.primed = true;
    }
  }

  #save() {
    if (!this.file || this.saveTimer) return;
    // Coalesced: a burst of registrations is one write.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1_000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ devices: [...this.devices.values()], seen: this.seen }));
      fs.renameSync(temp, this.file);
    } catch (error) {
      // A cache, not a database: a failed write costs the tokens on the next
      // restart, never this one.
      this.logger?.warn?.(`Could not save push registrations: ${error.message}`);
    }
  }

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  register(body, now = Date.now()) {
    if (!this.enabled) return { ok: false, status: 503, error: 'Incident push is not configured' };
    const device = parseDevice(body);
    if (typeof device === 'string') return { ok: false, status: 400, error: device };
    const existing = this.devices.get(device.token);
    if (!existing && this.devices.size >= this.maxDevices) this.#makeRoom(now);
    // Re-registering keeps the opt-in date: it is when the rider started
    // listening, not when they last opened the app or changed the scope.
    this.devices.set(device.token, { ...device, enabledAt: existing?.enabledAt ?? now, updatedAt: now });
    this.#save();
    return { ok: true };
  }

  /**
   * The registry is public and unauthenticated: anyone can register tokens
   * that belong to no phone. Refusing new devices once it was full let a
   * script lock every real rider out for good, so a full registry first drops
   * what has expired and then the registration refreshed longest ago — a
   * phone that opens the app re-registers and is always the freshest.
   */
  #makeRoom(now) {
    this.#expire(now);
    if (this.devices.size < this.maxDevices) return;
    let oldest = null;
    for (const device of this.devices.values()) {
      if (!oldest || device.updatedAt < oldest.updatedAt) oldest = device;
    }
    if (oldest) this.devices.delete(oldest.token);
  }

  #expire(now) {
    let removed = false;
    for (const device of [...this.devices.values()]) {
      if (now - device.updatedAt > this.deviceTtlMs) {
        this.devices.delete(device.token);
        removed = true;
      }
    }
    if (removed) this.#save();
  }

  unregister(token) {
    const removed = this.devices.delete(clean(token, 256));
    if (removed) this.#save();
    return removed;
  }

  async #send(device, payload, collapseId) {
    const result = await this.apns.send(device.token, payload, {
      topic: this.topic,
      pushType: 'alert',
      priority: 10,
      collapseId,
    });
    if (result.status === 200) {
      this.stats.pushed += 1;
      return;
    }
    this.stats.failed += 1;
    this.stats.lastError = `${result.status} ${result.reason ?? ''}`.trim();
    if (result.status === 410 || DEAD_REASONS.has(result.reason)) {
      this.devices.delete(device.token);
      this.stats.removed += 1;
      this.#save();
    }
  }

  /** One pass over the current incidents. Exposed for tests. */
  async tick(now = Date.now()) {
    // Learning from an alerts service that has not refreshed yet would learn
    // an empty list, and the first real refresh would then all be "new".
    if (!this.primed && this.alerts.status?.lastRefreshAt === null) return;
    this.#expire(now);
    const { fresh, seen } = freshIncidents(this.alerts.getIncidents({ now }), this.seen, now);
    this.seen = seen;
    this.stats.lastPassAt = new Date(now).toISOString();
    const primed = this.primed;
    this.primed = true;
    if (fresh.length > 0 || !primed) this.#save();
    if (!primed || !this.enabled || fresh.length === 0) return;

    const work = [];
    for (const device of [...this.devices.values()]) {
      const plan = planForDevice(device, fresh);
      for (const incident of plan.separate) {
        const { title, body } = incidentAlert(incident);
        work.push(
          this.#send(
            device,
            {
              aps: { alert: { title, body }, sound: 'default', 'thread-id': 'incidents' },
              // expo-notifications hands a remote push's `body` to the app as
              // `content.data`; the tap opens the disruptions screen from it.
              body: { kind: 'incident', incidentId: incident.id },
            },
            // Becomes the notification's identifier on iOS — the one the app's
            // own local notification uses — so the two never stack.
            `incident:${incident.id}`.slice(0, 64),
          ),
        );
      }
      if (plan.summarised > 0) {
        const noun = plural(plan.summarised, ['nowe utrudnienie', 'nowe utrudnienia', 'nowych utrudnień']);
        work.push(
          this.#send(
            device,
            {
              aps: {
                alert: {
                  title: `${plan.summarised} ${noun}`,
                  body: device.mode === 'mine' ? 'Na wybranych liniach. Szczegóły w aplikacji.' : 'Szczegóły w aplikacji.',
                },
                sound: 'default',
                'thread-id': 'incidents',
              },
              body: { kind: 'incident' },
            },
            'incident:summary',
          ),
        );
      }
    }
    await Promise.allSettled(work);
  }

  start({ intervalMs = 20_000 } = {}) {
    if (this.timer) return;
    this.load();
    // Runs without an APNs key too: it keeps `seen` current, so a key added
    // later does not start by announcing everything that is active.
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.logger?.warn?.(`Incident push pass failed: ${error.message}`);
      }
      if (this.timer) {
        this.timer = setTimeout(loop, intervalMs);
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(loop, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow();
    }
  }

  get status() {
    return {
      enabled: this.enabled,
      reason: this.enabled ? null : this.apns?.error ?? 'APNS_KEY_ID, APNS_TEAM_ID and a key are not set',
      devices: this.devices.size,
      ...this.stats,
    };
  }
}

module.exports = { IncidentPushService, freshIncidents, incidentAlert, parseDevice, planForDevice };
