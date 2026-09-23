'use strict';

const { describeVehicle } = require('./progress');

/**
 * Keeps arrival Live Activities right while the app is suspended.
 *
 * The app starts an activity when a rider arms an arrival alert and, once iOS
 * hands it a push token, registers it here: which vehicle, which stop, and the
 * few static fields the layout draws. On every vehicle poll this re-reads that
 * vehicle's ETA for that stop — the same `describeVehicle()` the app's own
 * sheet reads — and pushes the new countdown to the lock screen. When the stop
 * is passed, the vehicle leaves the feed, or the activity is simply old, it
 * sends the end event and forgets the token.
 *
 * The token is the only thing held, it is held in memory only, and it goes as
 * soon as the activity ends. Nothing is written to disk and nothing identifies
 * a person: the token names one activity on one phone, and iOS rotates it.
 *
 * Push budget: Apple throttles high-priority Live Activity pushes, so a push
 * is sent only when the arrival moved by more than `MIN_SHIFT_SECONDS`, or
 * when the activity has had no push for `HEARTBEAT_MS` (so its stale date
 * keeps moving). Priority 10 is kept for the last two minutes, where a late
 * update is the one the rider notices; before that 5 is enough.
 */

const MIN_SHIFT_SECONDS = 20;
const HEARTBEAT_MS = 3 * 60_000;
const URGENT_SECONDS = 120;
/** An un-refreshed countdown is greyed out this long after its arrival time. */
const STALE_AFTER_MS = 60_000;
/** A registration the rider never ends — the app was deleted mid-ride — is dropped. */
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60_000;
/** APNs answers that mean the token will never work again. */
const DEAD_TOKEN_STATUS = new Set([400, 410]);
const TOKEN_PATTERN = /^[0-9a-f]{32,256}$/i;

const clean = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Validate a registration body. Returns the record or an error string —
 * everything in it is echoed onto a lock screen, so nothing is taken on trust.
 */
function parseRegistration(body) {
  if (!body || typeof body !== 'object') return 'expected a JSON body';
  const token = clean(body.token, 256);
  if (!TOKEN_PATTERN.test(token)) return 'token must be a hex push token';
  const vehicleId = clean(body.vehicleId);
  const stopId = clean(body.stopId);
  if (!vehicleId || !stopId) return 'vehicleId and stopId are required';
  const view = body.view && typeof body.view === 'object' ? body.view : {};
  const colour = (value) => (/^#[0-9a-f]{6}$/i.test(clean(value, 7)) ? clean(value, 7) : null);
  const record = {
    token,
    vehicleId,
    stopId,
    view: {
      line: clean(view.line, 8),
      color: colour(view.color) ?? '#475569',
      towards: clean(view.towards) || null,
      stopName: clean(view.stopName),
      amberLight: colour(view.amberLight) ?? '#9A5B00',
      amberDark: colour(view.amberDark) ?? '#FFB020',
    },
  };
  if (!record.view.line || !record.view.stopName) return 'view.line and view.stopName are required';
  return record;
}

class LiveActivityService {
  /**
   * @param {{ apns: import('./apns').ApnsClient | null, gtfs: object, vehicles: object,
   *   bundleId: string, maxActivities?: number, maxAgeMs?: number, logger?: object,
   *   describe?: typeof describeVehicle }} options — `describe` is replaceable for tests.
   */
  constructor({
    apns,
    gtfs,
    vehicles,
    bundleId,
    maxActivities = 2000,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    logger = null,
    describe = describeVehicle,
  }) {
    this.apns = apns;
    this.describe = describe;
    this.gtfs = gtfs;
    this.vehicles = vehicles;
    this.topic = `${bundleId}.push-type.liveactivity`;
    this.maxActivities = maxActivities;
    this.maxAgeMs = maxAgeMs;
    this.logger = logger;
    /** token → { token, vehicleId, stopId, view, registeredAt, lastPushAt, lastArrivesAt } */
    this.activities = new Map();
    this.lastRevision = -1;
    this.timer = null;
    this.stats = { pushed: 0, ended: 0, failed: 0, lastError: null };
  }

  get enabled() {
    return Boolean(this.apns?.configured);
  }

  /** @returns {{ ok: true } | { ok: false, status: number, error: string }} */
  register(body, now = Date.now()) {
    if (!this.enabled) return { ok: false, status: 503, error: 'Live Activity push is not configured' };
    const record = parseRegistration(body);
    if (typeof record === 'string') return { ok: false, status: 400, error: record };
    if (!this.activities.has(record.token) && this.activities.size >= this.maxActivities) {
      return { ok: false, status: 503, error: 'Too many Live Activities' };
    }
    this.activities.set(record.token, {
      ...record,
      registeredAt: now,
      lastPushAt: 0,
      lastArrivesAt: null,
    });
    return { ok: true };
  }

  unregister(token) {
    return this.activities.delete(clean(token, 256));
  }

  /** The content state `expo-widgets`' Live Activity decodes: `{ name, props }`, props a JSON string. */
  #contentState(record, arrivesAt, since, atStop) {
    return {
      name: 'Arrival',
      props: JSON.stringify({ ...record.view, arrivesAt, since, atStop }),
    };
  }

  async #push(record, payload, priority) {
    const result = await this.apns.send(record.token, payload, { topic: this.topic, priority });
    if (result.status === 200) {
      this.stats.pushed += 1;
      return true;
    }
    this.stats.failed += 1;
    this.stats.lastError = `${result.status} ${result.reason ?? ''}`.trim();
    if (DEAD_TOKEN_STATUS.has(result.status)) this.activities.delete(record.token);
    return false;
  }

  async #end(record, now) {
    this.activities.delete(record.token);
    this.stats.ended += 1;
    await this.#push(
      record,
      {
        aps: {
          timestamp: Math.floor(now / 1000),
          event: 'end',
          'dismissal-date': Math.floor(now / 1000) + 60,
        },
      },
      5,
    );
  }

  /** One pass over every registered activity. Exposed for tests. */
  async tick(now = Date.now()) {
    if (!this.enabled || this.activities.size === 0) return;
    const work = [];
    for (const record of [...this.activities.values()]) {
      if (now - record.registeredAt > this.maxAgeMs) {
        work.push(this.#end(record, now));
        continue;
      }
      const vehicle = this.vehicles.getVehicle(record.vehicleId);
      if (!vehicle) {
        work.push(this.#end(record, now));
        continue;
      }
      let trip = null;
      try {
        trip = this.describe(this.gtfs, vehicle, { now: new Date(now), limit: 60, history: 1 });
      } catch {
        continue;
      }
      const stop = trip?.nextStops?.find((entry) => entry.id === record.stopId);
      if (!trip || !stop || !Number.isFinite(stop.etaSeconds)) {
        // Passed (or the vehicle turned onto another route): the ride is over.
        work.push(this.#end(record, now));
        continue;
      }
      const arrivesAt = now + stop.etaSeconds * 1000;
      const shifted =
        record.lastArrivesAt === null || Math.abs(arrivesAt - record.lastArrivesAt) > MIN_SHIFT_SECONDS * 1000;
      if (!shifted && now - record.lastPushAt < HEARTBEAT_MS) continue;

      record.lastArrivesAt = arrivesAt;
      record.lastPushAt = now;
      const atStop = trip.atStop?.id === record.stopId;
      work.push(
        this.#push(
          record,
          {
            aps: {
              timestamp: Math.floor(now / 1000),
              event: 'update',
              'content-state': this.#contentState(record, arrivesAt, now, atStop),
              'stale-date': Math.floor((arrivesAt + STALE_AFTER_MS) / 1000),
            },
          },
          stop.etaSeconds <= URGENT_SECONDS ? 10 : 5,
        ),
      );
    }
    await Promise.allSettled(work);
  }

  /** Follow the vehicle tracker: one pass per new poll, checked every couple of seconds. */
  start({ intervalMs = 2_000 } = {}) {
    if (this.timer || !this.enabled) return;
    const loop = async () => {
      const revision = this.vehicles.pollRevision ?? 0;
      if (revision !== this.lastRevision) {
        this.lastRevision = revision;
        try {
          await this.tick();
        } catch (error) {
          this.logger?.warn?.(`Live Activity pass failed: ${error.message}`);
        }
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
    this.apns?.close();
  }

  get status() {
    return {
      enabled: this.enabled,
      reason: this.enabled ? null : this.apns?.error ?? 'APNS_KEY_ID, APNS_TEAM_ID and a key are not set',
      active: this.activities.size,
      ...this.stats,
    };
  }
}

/**
 * One lookup over both fleets, the way `/vehicle/:id` resolves them. An alert
 * armed on a Kłosok bus (`klosok:` ids) must not read as "vehicle gone" and
 * have its activity ended on the first pass. Polls follow the MPK tracker.
 */
const bothFleets = (vehicles, klosok) => ({
  getVehicle: (id) => (id.startsWith('klosok:') ? (klosok?.getVehicle(id) ?? null) : vehicles.getVehicle(id)),
  get pollRevision() {
    return vehicles.pollRevision;
  },
});

module.exports = { LiveActivityService, bothFleets, parseRegistration };
