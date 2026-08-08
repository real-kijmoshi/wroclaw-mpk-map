'use strict';

const { fetchWithTimeout } = require('./http');
const { distanceMeters } = require('./gtfs/geo');
const { lineToType } = require('./lines');

// Anything outside this box is a bad fix, not a vehicle in Wrocław. Mirrors
// the bounds in vehicles.js — kept here so this module has no dependency back
// on the tracker (which imports this module).
const BOUNDS = { minLat: 50.8, maxLat: 51.4, minLon: 16.6, maxLon: 17.5 };

const inBounds = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= BOUNDS.minLat &&
  lat <= BOUNDS.maxLat &&
  lon >= BOUNDS.minLon &&
  lon <= BOUNDS.maxLon;

/**
 * The city's `hdb/db/14` payload uses Polish column names. Field names have
 * drifted in the past on every upstream, so aliases are accepted rather than
 * assuming one exact spelling.
 */
const FIELD_ALIASES = {
  line: ['Nazwa_Linii', 'nazwa_linii', 'line', 'route_short_name', 'linia'],
  vehicleNumber: ['Nr_Boczny', 'nr_boczny', 'vehicle_number', 'vehicleId'],
  brigade: ['Brygada', 'brygada', 'brigade'],
  lat: ['Ostatnia_Pozycja_Szerokosc', 'szerokosc', 'lat', 'latitude'],
  lon: ['Ostatnia_Pozycja_Dlugosc', 'dlugosc', 'lon', 'lng', 'longitude'],
  time: ['Data_Aktualizacji', 'data_aktualizacji', 'timestamp', 'positionUpdatedAt'],
};

const pick = (row, aliases) => {
  for (const key of aliases) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
};

// A clock reading older than this is not a live vehicle.
const MAX_POSITION_AGE_MS = 90_000;
// Generous, but a timestamp a month in the future would otherwise read as
// fresh forever. Real clock skew is seconds, not days.
const MAX_FUTURE_SKEW_MS = 10_000;

const WARSAW_TZ = 'Europe/Warsaw';

// One formatter for the whole process. Instantiating an Intl.DateTimeFormat
// per call allocates on every Open Data record on every poll; the formatter
// itself is stateless, so a single module-scope instance yields identical
// output for the same instant. The DST differential tests in
// test/open-data.test.js pin the hoisted instance against a per-call copy.
const WARSAW_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: WARSAW_TZ,
  timeZoneName: 'longOffset',
});

/**
 * UTC offset in minutes of the Europe/Warsaw timezone at a given instant.
 * Poland switches between +1 (winter) and +2 (summer), so the offset has to
 * be looked up rather than assumed.
 */
const warsawOffsetMinutesAt = (utcMs) => {
  const parts = WARSAW_OFFSET_FORMATTER.formatToParts(new Date(utcMs));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

// A trailing Z or an explicit numeric offset marks an absolute instant.
const HAS_OFFSET = /(?:[zZ])|(?:[+-]\d{2}:?\d{2})/;

/**
 * Parse a timestamp and read it as Europe/Warsaw.
 *
 * `Data_Aktualizacji` comes from the city API with no timezone marker — it is
 * the wall clock in Wrocław. An explicit zone (a trailing `Z` or a `+02:00`
 * offset) is honoured as-is; a bare wall clock is reinterpreted as Warsaw
 * local time no matter what timezone this process happens to run in.
 *
 * @param {string | number} value
 * @returns {Date | null}
 */
const parseWarsawDate = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  if (HAS_OFFSET.test(trimmed)) return parsed;

  // The bare wall clock was parsed in the process's own timezone; its getters
  // therefore read exactly what the string said. Take those fields as Warsaw
  // time and subtract the offset to reach the absolute instant.
  const naiveUtc = Date.UTC(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
  );
  return new Date(naiveUtc - warsawOffsetMinutesAt(naiveUtc) * 60_000);
};

/**
 * Normalise one Open Data record.
 *
 * The `hdb/db/14` payload lists every vehicle as a row of Polish columns, with
 * `Data_Aktualizacji` as the last time the position was refreshed. Records
 * that cannot be a live vehicle in Wrocław right now are rejected.
 *
 * @param {object} row
 * @param {{ now?: number, maxAgeMs?: number }} options
 * @returns {object | null} `{ id, line, type, lat, lon, vehicleNumber, brigade,
 *   positionUpdatedAt }` or null when the record is unusable
 */
const normalizeOpenDataRecord = (row, { now = Date.now(), maxAgeMs = MAX_POSITION_AGE_MS } = {}) => {
  if (!row || typeof row !== 'object') return null;

  // Same canonical casing as the MPK feed normaliser (src/vehicles.js): the
  // line must match the timetable's `route_short_name` exactly, so the two
  // live sources and the GTFS always agree.
  const line = String(pick(row, FIELD_ALIASES.line) ?? '').trim().toUpperCase();
  if (!line) return null;

  const rawVehicleNumber = Number.parseFloat(pick(row, FIELD_ALIASES.vehicleNumber));
  if (!Number.isFinite(rawVehicleNumber) || rawVehicleNumber <= 0) return null;
  const vehicleNumber = Math.trunc(rawVehicleNumber);

  const lat = Number.parseFloat(pick(row, FIELD_ALIASES.lat));
  const lon = Number.parseFloat(pick(row, FIELD_ALIASES.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (!inBounds(lat, lon)) return null;

  const positionUpdatedAt = parseWarsawDate(pick(row, FIELD_ALIASES.time));
  if (!positionUpdatedAt) return null;
  const ageMs = now - positionUpdatedAt.getTime();
  if (ageMs > maxAgeMs) return null;
  if (ageMs < -MAX_FUTURE_SKEW_MS) return null;

  const brigade = pick(row, FIELD_ALIASES.brigade);

  return {
    id: `open-data:${vehicleNumber}`,
    line,
    type: lineToType(line),
    lat,
    lon,
    vehicleNumber,
    brigade: brigade === undefined || brigade === null ? null : String(brigade),
    positionUpdatedAt: positionUpdatedAt.toISOString(),
  };
};

/**
 * Fetch the city's live vehicle table.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<object[]>} the raw records in the payload's `dane` field
 */
const fetchOpenDataVehicles = async (url, { timeoutMs = 15_000 } = {}) => {
  const response = await fetchWithTimeout(url, { timeoutMs });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('expected JSON from the Open Data endpoint');
  }

  const rows = payload?.dane;
  if (!Array.isArray(rows)) throw new Error('response did not contain a "dane" list of vehicles');
  return rows;
};

/**
 * Combine the primary (MPK) fleet with the supplementary (Open Data) fleet.
 *
 * Rules, from the merge spec:
 *
 *   1. MPK positions are authoritative — a matched vehicle keeps the MPK id
 *      and position and only gains the Open Data number/brigade/time.
 *   2. An Open Data record matches the nearest MPK vehicle with the same line
 *      and type, but only within `matchMaxMeters`; anything farther is not the
 *      same vehicle, and a second candidate nearly as close is ambiguous —
 *      guessing which of two trams a stale fix belongs to would put the wrong
 *      number on the wrong tram, so neither is matched.
 *   3. A fresh record with no match becomes a vehicle of its own
 *      (`source: "open-data"`) unless an MPK vehicle of the same line sits
 *      within `dedupeMeters` — then it is almost certainly the same vehicle
 *      reported twice, and showing both would be a duplicate.
 *
 * @param {Map<string, object>} mpkFleet live MPK vehicles
 * @param {Map<string, object>} openDataFleet normalised Open Data records
 * @param {{ matchMaxMeters: number, dedupeMeters: number, ambiguityMeters: number }} options
 * @returns {{ fleet: Map<string, object>, stats: object }}
 */
const mergeFleet = (mpkFleet, openDataFleet, { matchMaxMeters, dedupeMeters, ambiguityMeters }) => {
  const fleet = new Map();
  for (const [id, vehicle] of mpkFleet) {
    fleet.set(id, { ...vehicle, source: 'mpk' });
  }

  const byLine = new Map();
  for (const vehicle of mpkFleet.values()) {
    if (!byLine.has(vehicle.line)) byLine.set(vehicle.line, []);
    byLine.get(vehicle.line).push(vehicle);
  }

  const used = new Set();

  for (const od of openDataFleet.values()) {
    // One pass over the same-line MPK vehicles — no candidate array, no sort.
    // Per record we only need:
    //   nearest/second same-line, same-type candidates (and their distances),
    //   whether ANY same-line vehicle (regardless of type) is within
    //   dedupeMeters.
    // Each of those is a constant, so a running best-of-two keeps the same
    // semantics the array+sort version had, with no per-record allocations
    // beyond the two result objects (and those only when a same-type
    // candidate exists).
    const lineVehicles = byLine.get(od.line);
    let nearest = null;
    let second = null;
    let withinDedupe = false;

    if (lineVehicles) {
      for (const mpk of lineVehicles) {
        const sameType = mpk.type === od.type;
        // A different-type vehicle's distance is only needed for the dedupe
        // check, and only until some same-line vehicle has already satisfied
        // it — after that the trig can be skipped entirely.
        if (!sameType && withinDedupe) continue;
        const meters = distanceMeters(mpk.lat, mpk.lon, od.lat, od.lon);
        if (meters <= dedupeMeters) withinDedupe = true;
        if (!sameType) continue;
        if (nearest === null || meters < nearest.meters) {
          second = nearest;
          nearest = { mpk, meters };
        } else if (second === null || meters < second.meters) {
          second = { mpk, meters };
        }
      }
    }

    let matched = null;

    if (nearest && nearest.meters <= matchMaxMeters && !used.has(nearest.mpk.id)) {
      const ambiguous =
        second &&
        second.meters <= matchMaxMeters &&
        second.meters - nearest.meters < ambiguityMeters;
      if (!ambiguous) matched = nearest.mpk;
    }

    if (matched) {
      used.add(matched.id);
      const entry = fleet.get(matched.id);
      entry.source = 'merged';
      entry.vehicleNumber = od.vehicleNumber;
      entry.brigade = od.brigade;
      entry.positionUpdatedAt = od.positionUpdatedAt;
      continue;
    }

    // No merge: only surface the record when no MPK vehicle of the same line
    // is near enough that it would just be that vehicle twice. The dedupe
    // check is deliberately type-agnostic, exactly like the reference.
    if (withinDedupe) continue;

    fleet.set(od.id, {
      id: od.id,
      line: od.line,
      type: od.type,
      lat: od.lat,
      lon: od.lon,
      heading: null,
      vehicleNumber: od.vehicleNumber,
      brigade: od.brigade,
      positionUpdatedAt: od.positionUpdatedAt,
      source: 'open-data',
      updatedAt: od.updatedAt,
    });
  }

  const stats = { mpk: 0, merged: 0, openData: 0, total: fleet.size, activeLines: 0 };
  const lines = new Set();
  for (const vehicle of fleet.values()) {
    lines.add(vehicle.line);
    if (vehicle.source === 'merged') stats.merged += 1;
    else if (vehicle.source === 'open-data') stats.openData += 1;
    else stats.mpk += 1;
  }
  stats.activeLines = lines.size;

  return { fleet, stats };
};

module.exports = {
  MAX_FUTURE_SKEW_MS,
  MAX_POSITION_AGE_MS,
  fetchOpenDataVehicles,
  mergeFleet,
  normalizeOpenDataRecord,
  parseWarsawDate,
  warsawOffsetMinutesAt,
};
