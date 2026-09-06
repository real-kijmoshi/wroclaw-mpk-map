'use strict';

const fs = require('node:fs');
const path = require('node:path');

const logger = require('./logger');

const BUNDLED_ROSTER = path.join(__dirname, 'fleet-roster.json');

const KINDS = new Set(['tram', 'bus']);
const LOW_FLOOR = new Set(['full', 'partial', 'none']);

/**
 * Every attribute a lookup can answer, all unknown.
 *
 * A miss is served as this rather than as `null`, so a client never has to tell
 * "no roster entry" apart from "roster entry that knows nothing" — both mean
 * the same thing to a rider, and one shape means one rendering path.
 */
const UNKNOWN = Object.freeze({
  model: null,
  kind: null,
  lowFloor: null,
  wheelchair: null,
  airConditioning: null,
  years: null,
  source: null,
});

/** A side number as the roster keys it: digits only, or null when it is not one. */
const normaliseNumber = (value) => {
  if (value === null || value === undefined) return null;
  // Open Data hands `Nr_Boczny` over as a number, Kłosok as a slice of its
  // vehicle label. Both end up here as text, and only a plain integer can be
  // compared against a range.
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** true / false / null — anything else in the file is a typo, not a value. */
const triState = (value) => (value === true || value === false ? value : null);

/**
 * One roster entry, or null when the file says something that cannot be meant.
 *
 * A malformed entry is dropped rather than thrown on: this file is data, and
 * an operator's typo in one line must not cost the other 40 lines — or the
 * boot. `loadRoster` counts what it dropped so /health can say so.
 */
const validateEntry = (raw, index) => {
  if (!raw || typeof raw !== 'object') return { error: `entry ${index} is not an object` };

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return { error: `entry ${index} has no model` };

  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!KINDS.has(kind)) return { error: `entry ${index} (${model}) has no kind of tram/bus` };

  const numbers = [];
  let from = null;
  let to = null;

  if (Array.isArray(raw.numbers)) {
    for (const value of raw.numbers) {
      const number = normaliseNumber(value);
      if (number !== null) numbers.push(number);
    }
  }
  if (raw.from !== undefined || raw.to !== undefined) {
    from = normaliseNumber(raw.from);
    to = normaliseNumber(raw.to);
    if (from === null || to === null || from > to) {
      return { error: `entry ${index} (${model}) has an unusable from/to range` };
    }
  }
  if (!numbers.length && from === null) {
    return { error: `entry ${index} (${model}) matches no side numbers` };
  }

  const lowFloor =
    typeof raw.lowFloor === 'string' && LOW_FLOOR.has(raw.lowFloor) ? raw.lowFloor : null;

  return {
    entry: {
      kind,
      from,
      to,
      numbers,
      // Frozen and shared: the same object is handed to every vehicle of this
      // model on every poll, so a fleet-wide lookup allocates nothing. Freezing
      // is what makes that safe to serialise straight onto the wire.
      attributes: Object.freeze({
        model,
        kind,
        lowFloor,
        wheelchair: triState(raw.wheelchair),
        airConditioning: triState(raw.airConditioning),
        years: typeof raw.years === 'string' && raw.years.trim() ? raw.years.trim() : null,
        source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null,
      }),
    },
  };
};

/**
 * What a side number is attached to: the model, whether it is low floor, whether
 * a wheelchair gets on, whether the saloon is air conditioned.
 *
 * None of that is in any live feed. `bus_position`, the city's Open Data table
 * and Kłosok's GTFS-RT publish a side number and stop there, so the only way to
 * answer "does this one have air conditioning" is a roster keyed on that number
 * — which means this class is the one place where the server states something
 * the feeds never told it. Two rules follow from that and are the whole design:
 *
 *   1. An attribute the roster does not know is `null`, and stays `null` all
 *      the way to the screen. Assuming a model's other units share its
 *      equipment is how a rider ends up waiting for a ramp that is not there.
 *   2. A vehicle with no side number at all (MPK's own feed carries none until
 *      an Open Data record is merged in) resolves to `UNKNOWN`, never to a
 *      neighbouring range.
 *
 * `kind` is matched too, because tram and bus numbering are separate series
 * and nothing stops them from colliding.
 */
class FleetRoster {
  /** @param {{ entries?: object[], path?: string|null, warnings?: string[] }} options */
  constructor({ entries = [], path: sourcePath = null, warnings = [] } = {}) {
    this.path = sourcePath;
    this.warnings = warnings;

    /** @type {Map<string, Readonly<object>>} `${kind}:${number}` -> attributes */
    this.exact = new Map();
    /** @type {object[]} entries carrying a range, scanned when no exact hit */
    this.ranges = [];
    /** Memo of resolved lookups, so a fleet-wide pass is one Map hit per vehicle. */
    this.cache = new Map();

    for (const entry of entries) {
      for (const number of entry.numbers) this.exact.set(`${entry.kind}:${number}`, entry.attributes);
      if (entry.from !== null) this.ranges.push(entry);
    }

    this.size = entries.length;
  }

  /** True when the roster has nothing to say about anything. */
  get isEmpty() {
    return this.exact.size === 0 && this.ranges.length === 0;
  }

  /**
   * @param {string|number|null|undefined} vehicleNumber the side number
   * @param {string|null|undefined} type the line category (`tram`, `bus`,
   *   `night-bus`, …) as the rest of the server spells it
   * @returns {Readonly<object>} always an attribute object; `UNKNOWN` on a miss.
   */
  describe(vehicleNumber, type) {
    const number = normaliseNumber(vehicleNumber);
    if (number === null) return UNKNOWN;

    // Line categories are finer than the roster's two families ("night-bus",
    // "express-bus" and "suburban-bus" are all buses); anything that is not a
    // tram is looked up as a bus. An unknown category matches either.
    const kind = typeof type === 'string' && type.startsWith('tram') ? 'tram' : 'bus';

    const key = `${kind}:${number}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let found = this.exact.get(key);
    if (!found) {
      for (const entry of this.ranges) {
        if (entry.kind !== kind) continue;
        if (number < entry.from || number > entry.to) continue;
        found = entry.attributes;
        break;
      }
    }

    const result = found ?? UNKNOWN;
    this.cache.set(key, result);
    return result;
  }
}

/**
 * Read a roster file.
 *
 * Fails soft in every direction an operator can get this wrong — a missing
 * file, unreadable JSON, a mistyped entry — because a roster is a nicety
 * layered on top of a working map, and none of those is worth refusing to
 * serve positions over. What it does not do is fall back to the bundled file
 * when an operator named their own: silently serving Wrocław's tram roster to
 * someone who pointed at their own fleet would state the wrong models as fact,
 * which is the one failure this module exists to avoid.
 *
 * @param {string|null} rosterPath path to read, or null for the bundled roster
 * @returns {FleetRoster}
 */
const loadRoster = (rosterPath = null) => {
  const file = rosterPath || BUNDLED_ROSTER;
  const warnings = [];

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // The bundled roster is ours and is pinned by a test, so a failure to read
    // it is a packaging bug and says so; an operator's file is theirs.
    logger.warn(`fleet roster ${file} could not be read: ${error.message}`);
    return new FleetRoster({ path: file, warnings: [error.message] });
  }

  const rows = Array.isArray(payload) ? payload : payload?.entries;
  if (!Array.isArray(rows)) {
    const message = `fleet roster ${file} has no entries array`;
    logger.warn(message);
    return new FleetRoster({ path: file, warnings: [message] });
  }

  const entries = [];
  for (const [index, raw] of rows.entries()) {
    const { entry, error } = validateEntry(raw, index);
    if (error) {
      warnings.push(error);
      continue;
    }
    entries.push(entry);
  }

  if (warnings.length) {
    logger.warn(`fleet roster ${file}: ignored ${warnings.length} entry(ies) — ${warnings[0]}`);
  }

  return new FleetRoster({ entries, path: file, warnings });
};

/**
 * Memo for `combine`, keyed on the identity of its two inputs.
 *
 * Both sides are interned — one frozen object per roster entry, one per feed
 * vehicle type — so identity is a complete key, and after the first vehicle of
 * each pairing the merge is two Map hits and no allocation. That matters
 * because this runs for every vehicle on every poll.
 *
 * @type {Map<object, Map<object, Readonly<object>>>}
 */
const combineCache = new Map();

/**
 * The roster's answer and the feed's, merged field by field.
 *
 * The roster is keyed on the side number, so it describes the vehicle that is
 * physically on the street; `vehicle_types.txt` describes the type the
 * timetable rosters onto the run, which is a plan and can be swapped on the
 * day. Where both speak the physical answer wins; everywhere else the feed
 * fills the gap, which is what makes a feed that ships the table cover the
 * whole fleet without anybody maintaining a file.
 *
 * @param {Readonly<object>} roster from `FleetRoster.describe`, possibly UNKNOWN
 * @param {Readonly<object>|null} feed from `GtfsStore.getVehicleType`
 * @returns {Readonly<object>} `UNKNOWN` when neither says anything.
 */
const combine = (roster, feed) => {
  if (!feed) return roster;
  if (roster === UNKNOWN && feed.model === null && feed.lowFloor === null &&
      feed.wheelchair === null && feed.airConditioning === null) {
    return UNKNOWN;
  }

  let byFeed = combineCache.get(roster);
  if (!byFeed) {
    byFeed = new Map();
    combineCache.set(roster, byFeed);
  }
  const cached = byFeed.get(feed);
  if (cached) return cached;

  const merged = Object.freeze({
    model: roster.model ?? feed.model,
    kind: roster.kind,
    lowFloor: roster.lowFloor ?? feed.lowFloor,
    wheelchair: roster.wheelchair ?? feed.wheelchair,
    airConditioning: roster.airConditioning ?? feed.airConditioning,
    years: roster.years,
    source: roster.source,
  });
  byFeed.set(feed, merged);
  return merged;
};

/** @type {FleetRoster|null} */
let shared = null;

/**
 * The process-wide roster, read once on first use.
 *
 * Both live providers look a vehicle up on every poll, so this is deliberately
 * a singleton rather than a per-service instance: one file read, and one memo
 * of resolved side numbers shared by the whole fleet. Tests build their own
 * `FleetRoster` instead of going through here.
 */
const sharedRoster = () => {
  if (!shared) {
    const config = require('./config');
    shared = config.fleet.enabled
      ? loadRoster(config.fleet.rosterPath || null)
      : new FleetRoster({ path: null });
  }
  return shared;
};

module.exports = {
  FleetRoster,
  UNKNOWN,
  combine,
  loadRoster,
  normaliseNumber,
  sharedRoster,
  validateEntry,
};
