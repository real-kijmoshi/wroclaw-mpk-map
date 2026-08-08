'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');

const config = require('../src/config');
const { createApp } = require('../src/app');
const { distanceMeters } = require('../src/gtfs/geo');
const {
  MAX_FUTURE_SKEW_MS,
  mergeFleet,
  normalizeOpenDataRecord,
  parseWarsawDate,
  warsawOffsetMinutesAt,
} = require('../src/open-data');
const { VehicleTracker } = require('../src/vehicles');

/** The wall clock in Wrocław as a naive "YYYY-MM-DD HH:mm:ss" string. */
const warsawWallClock = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

/** A fixed "now" so the freshness window does not drift while the test runs. */
const NOW = 1_752_900_000_000;

const freshAt = (secondsAgo) => warsawWallClock(new Date(NOW - secondsAgo * 1000));

const baseRow = (overrides = {}) => ({
  Nazwa_Linii: '4',
  Nr_Boczny: 8123,
  Brygada: '1',
  Data_Aktualizacji: freshAt(30),
  Ostatnia_Pozycja_Szerokosc: 51.107,
  Ostatnia_Pozycja_Dlugosc: 17.038,
  ...overrides,
});

const mpkVehicle = (id, lat, lon) => ({
  id,
  line: '4',
  type: 'tram',
  lat,
  lon,
  heading: null,
  updatedAt: NOW,
});

const odVehicle = (id, lat, lon) => ({
  id,
  line: '4',
  type: 'tram',
  lat,
  lon,
  vehicleNumber: 8123,
  brigade: '1',
  positionUpdatedAt: new Date(NOW - 30_000).toISOString(),
  updatedAt: NOW,
});

const MERGE_OPTIONS = { matchMaxMeters: 250, dedupeMeters: 350, ambiguityMeters: 75 };

// ---------------------------------------------------------------------------
// Reference implementations, frozen in time.
//
// These are verbatim copies of the production code as it was written before
// the perf work (inline per-call formatter; candidate-array + sort merge
// matching). The differential tests below assert the production code and
// these references never diverge, so a rewrite that changes observable
// behaviour fails the suite. Deliberately duplicated, not imported, so the
// references stay frozen even if the production module is later refactored.
// ---------------------------------------------------------------------------

const warsawOffsetReference = (utcMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(utcMs));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

const HAS_OFFSET_REFERENCE = /(?:[zZ])|(?:[+-]\d{2}:?\d{2})/;

const parseWarsawDateReference = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  if (HAS_OFFSET_REFERENCE.test(trimmed)) return parsed;

  const naiveUtc = Date.UTC(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
  );
  return new Date(naiveUtc - warsawOffsetReference(naiveUtc) * 60_000);
};

const mergeFleetReference = (
  mpkFleet,
  openDataFleet,
  { matchMaxMeters, dedupeMeters, ambiguityMeters },
) => {
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
    const candidates = (byLine.get(od.line) ?? [])
      .filter((mpk) => mpk.type === od.type)
      .map((mpk) => ({ mpk, meters: distanceMeters(mpk.lat, mpk.lon, od.lat, od.lon) }))
      .sort((a, b) => a.meters - b.meters);

    const nearest = candidates[0];
    let matched = null;

    if (nearest && nearest.meters <= matchMaxMeters && !used.has(nearest.mpk.id)) {
      const second = candidates[1];
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

    const nearMpk = (byLine.get(od.line) ?? []).some(
      (mpk) => distanceMeters(mpk.lat, mpk.lon, od.lat, od.lon) <= dedupeMeters,
    );
    if (nearMpk) continue;

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

/** Deterministic PRNG (mulberry32) so any failing seed can be re-run. */
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const DIFF_LINE_NAMES = ['1', '4', '6', '11', '21', 'A', 'N', 'K'];
const DIFF_TYPES = ['tram', 'bus', 'busExpress', 'unknown'];

const randBetween = (rng, lo, hi) => lo + rng() * (hi - lo);

const randomFleetPair = (rng, options = MERGE_OPTIONS) => {
  const lineCount = 1 + Math.floor(rng() * 5);
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(DIFF_LINE_NAMES[Math.floor(rng() * DIFF_LINE_NAMES.length)]);
  }

  const cluster = new Map();
  for (const line of lines) {
    cluster.set(line, { lat: randBetween(rng, 50.9, 51.3), lon: randBetween(rng, 16.8, 17.35) });
  }

  const mpkFleet = new Map();
  for (const line of lines) {
    const count = Math.floor(rng() * 9);
    for (let j = 0; j < count; j += 1) {
      const c = cluster.get(line);
      const id = `${line}-${j}`;
      mpkFleet.set(id, {
        id,
        line,
        type: DIFF_TYPES[Math.floor(rng() * DIFF_TYPES.length)],
        lat: c.lat + randBetween(rng, -0.004, 0.004),
        lon: c.lon + randBetween(rng, -0.004, 0.004),
        heading: null,
        updatedAt: 0,
      });
    }
  }

  const offsets = [
    0.5 * options.matchMaxMeters,
    options.matchMaxMeters,
    options.matchMaxMeters + 1,
    options.dedupeMeters - 1,
    options.dedupeMeters,
    options.dedupeMeters + 1,
    0.5 * options.ambiguityMeters,
    1,
    500,
    800,
  ];

  const openDataFleet = new Map();
  const odCount = Math.floor(rng() * 12);
  for (let j = 0; j < odCount; j += 1) {
    const line = lines[Math.floor(rng() * lines.length)];
    const sameLine = [...mpkFleet.values()].filter((vehicle) => vehicle.line === line);
    const r = rng();
    let lat;
    let lon;
    if (sameLine.length && r < 0.4) {
      const vehicle = sameLine[Math.floor(rng() * sameLine.length)];
      lat = vehicle.lat;
      lon = vehicle.lon;
    } else if (sameLine.length && r < 0.7) {
      const vehicle = sameLine[Math.floor(rng() * sameLine.length)];
      const meters = offsets[Math.floor(rng() * offsets.length)];
      lat = vehicle.lat + meters / 111_320;
      lon = vehicle.lon;
    } else {
      const c = cluster.get(line);
      lat = c.lat + randBetween(rng, -0.008, 0.008);
      lon = c.lon + randBetween(rng, -0.008, 0.008);
    }
    const id = `open-data:${j}`;
    openDataFleet.set(id, {
      id,
      line,
      type: DIFF_TYPES[Math.floor(rng() * DIFF_TYPES.length)],
      lat,
      lon,
      vehicleNumber: 1000 + Math.floor(rng() * 9000),
      brigade: '1',
      positionUpdatedAt: new Date(0).toISOString(),
      updatedAt: 0,
    });
  }

  return { mpkFleet, openDataFleet };
};

const assertSameFleet = (actual, expected, message) => {
  assert.equal(actual.size, expected.size, `${message}: size`);
  const actualKeys = [...actual.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  assert.deepEqual(actualKeys, expectedKeys, `${message}: ids`);
  for (const key of actualKeys) {
    assert.deepEqual(actual.get(key), expected.get(key), `${message}: vehicle ${key}`);
  }
};

const asUtcMs = (iso) => new Date(iso).getTime();

describe('parseWarsawDate', () => {
  it('reads a bare wall clock as Europe/Warsaw summer time (UTC+2)', () => {
    const parsed = parseWarsawDate('2026-08-06 12:34:56');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('reads a bare wall clock as Europe/Warsaw winter time (UTC+1)', () => {
    const parsed = parseWarsawDate('2026-01-15 12:00:00');
    assert.equal(parsed.toISOString(), '2026-01-15T11:00:00.000Z');
  });

  it('honours an explicit timezone offset', () => {
    const parsed = parseWarsawDate('2026-08-06 12:34:56+02:00');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('treats a trailing Z as an absolute instant', () => {
    const parsed = parseWarsawDate('2026-08-06T10:34:56Z');
    assert.equal(parsed.toISOString(), '2026-08-06T10:34:56.000Z');
  });

  it('accepts a numeric epoch', () => {
    const parsed = parseWarsawDate(NOW);
    assert.equal(parsed.getTime(), NOW);
  });

  it('rejects junk', () => {
    assert.equal(parseWarsawDate(''), null);
    assert.equal(parseWarsawDate('not a date'), null);
    assert.equal(parseWarsawDate(null), null);
    assert.equal(parseWarsawDate(undefined), null);
  });
});

describe('warsawOffsetMinutesAt — DST behaviour is preserved by the hoisted formatter', () => {
  it('returns UTC+2 in summer and UTC+1 in winter', () => {
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-08-06T12:00:00Z')), 120);
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-01-15T12:00:00Z')), 60);
  });

  it('flips to UTC+2 exactly at the spring-forward instant (2026-03-29 01:00 UTC)', () => {
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-03-29T00:59:59Z')), 60);
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-03-29T01:00:00Z')), 120);
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-03-29T23:59:59Z')), 120);
  });

  it('flips back to UTC+1 exactly at the fall-back instant (2026-10-25 01:00 UTC)', () => {
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-10-25T00:59:59Z')), 120);
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-10-25T01:00:00Z')), 60);
    assert.equal(warsawOffsetMinutesAt(asUtcMs('2026-10-25T02:30:00Z')), 60);
  });

  it('matches the old per-call inline formatter across every 2026 transition', () => {
    const sweep = (startIso, endIso, stepMs) => {
      for (let ts = asUtcMs(startIso); ts <= asUtcMs(endIso); ts += stepMs) {
        assert.equal(
          warsawOffsetMinutesAt(ts),
          warsawOffsetReference(ts),
          `offset at ${new Date(ts).toISOString()}`,
        );
      }
    };
    sweep('2026-03-27T00:00:00Z', '2026-03-31T23:45:00Z', 15 * 60_000);
    sweep('2026-10-23T00:00:00Z', '2026-10-27T23:45:00Z', 15 * 60_000);
    sweep('2026-01-01T00:00:00Z', '2026-12-31T18:00:00Z', 6 * 60 * 60_000);
  });

  it('matches the old per-call inline formatter across 2025 and 2027 transitions too', () => {
    for (const start of ['2025-03-28T00:00:00Z', '2025-10-24T00:00:00Z', '2027-03-26T00:00:00Z', '2027-10-29T00:00:00Z']) {
      const day = new Date(asUtcMs(start));
      const endIso = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate() + 2).padStart(2, '0')}T23:45:00Z`;
      for (let ts = asUtcMs(start); ts <= asUtcMs(endIso); ts += 15 * 60_000) {
        assert.equal(
          warsawOffsetMinutesAt(ts),
          warsawOffsetReference(ts),
          `offset at ${new Date(ts).toISOString()}`,
        );
      }
    }
  });
});

describe('parseWarsawDate — transition-adjacent wall clocks', () => {
  it('maps a spring-forward morning wall clock through the pre-transition offset', () => {
    assert.equal(parseWarsawDate('2026-03-29 01:00:00').toISOString(), '2026-03-28T23:00:00.000Z');
  });

  it('maps fall-back wall clocks that exist before and after the flip', () => {
    assert.equal(parseWarsawDate('2026-10-25 01:30:00').toISOString(), '2026-10-25T00:30:00.000Z');
    assert.equal(parseWarsawDate('2026-10-25 03:30:00').toISOString(), '2026-10-25T02:30:00.000Z');
  });

  it('preserves the existing semantics through the gap and repeated hour, whatever the process timezone', () => {
    for (const wall of [
      '2026-03-28 22:00:00', '2026-03-28 23:30:00', '2026-03-29 00:00:00',
      '2026-03-29 01:00:00', '2026-03-29 01:30:00', '2026-03-29 02:00:00',
      '2026-03-29 02:30:00', '2026-03-29 03:00:00', '2026-03-29 03:30:00',
      '2026-03-29 04:00:00', '2026-10-24 22:00:00', '2026-10-25 00:00:00',
      '2026-10-25 01:00:00', '2026-10-25 01:30:00', '2026-10-25 02:00:00',
      '2026-10-25 02:30:00', '2026-10-25 03:00:00', '2026-10-25 03:30:00',
      '2026-10-25 04:00:00',
    ]) {
      const expected = parseWarsawDateReference(wall);
      const actual = parseWarsawDate(wall);
      assert.ok(expected, `reference parsed ${wall}`);
      assert.ok(actual, `production parsed ${wall}`);
      assert.equal(actual.getTime(), expected.getTime(), `wall clock ${wall}`);
    }
  });
});

describe('normalizeOpenDataRecord', () => {
  it('normalises a valid record', () => {
    const vehicle = normalizeOpenDataRecord(baseRow(), { now: NOW });
    assert.equal(vehicle.id, 'open-data:8123');
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.equal(vehicle.positionUpdatedAt, new Date(NOW - 30_000).toISOString());
  });

  it('rejects records with an empty line', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Nazwa_Linii: '' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nazwa_Linii: '  ' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord({}, { now: NOW }), null);
  });

  it('uppercases letter lines so they match the timetable', () => {
    // Mirrors normalizeVehicle: the line must equal the GTFS route_short_name
    // exactly, or the filter, the route matcher and the merge all miss it.
    const vehicle = normalizeOpenDataRecord(
      baseRow({ Nazwa_Linii: 'n' }),
      { now: NOW },
    );
    assert.equal(vehicle.line, 'N');
    assert.equal(vehicle.type, 'busExpress');
  });

  it('rejects records without a positive vehicle number', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: 0 }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: -3 }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: 'n/a' }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Nr_Boczny: null }), { now: NOW }), null);
  });

  it('rejects missing or invalid coordinates', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Szerokosc: undefined }), { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Dlugosc: 'x' }), { now: NOW }), null);
    // 0,0 is the portal's "no fix" sentinel.
    assert.equal(
      normalizeOpenDataRecord(
        baseRow({ Ostatnia_Pozycja_Szerokosc: 0, Ostatnia_Pozycja_Dlugosc: 0 }),
        { now: NOW },
      ),
      null,
    );
    // Warsaw, not Wrocław.
    assert.equal(
      normalizeOpenDataRecord(baseRow({ Ostatnia_Pozycja_Szerokosc: 52.23, Ostatnia_Pozycja_Dlugosc: 21.0 }), { now: NOW }),
      null,
    );
  });

  it('drops positions older than 90 seconds', () => {
    assert.equal(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: freshAt(91) }), { now: NOW }), null);
    assert.ok(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: freshAt(89) }), { now: NOW }));
  });

  it('drops timestamps from the distant future', () => {
    const tooFar = new Date(NOW + MAX_FUTURE_SKEW_MS + 1_000);
    assert.equal(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: warsawWallClock(tooFar) }), { now: NOW }), null);
    assert.ok(normalizeOpenDataRecord(baseRow({ Data_Aktualizacji: warsawWallClock(new Date(NOW + 5_000)) }), { now: NOW }));
  });

  it('never throws on junk', () => {
    assert.equal(normalizeOpenDataRecord(null, { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord('nope', { now: NOW }), null);
    assert.equal(normalizeOpenDataRecord(undefined, { now: NOW }), null);
  });
});

describe('mergeFleet', () => {
  it('merges an Open Data record onto the nearest same-line, same-type MPK vehicle', () => {
    // ~20 m apart.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', 51.10718, 17.03818)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    assert.equal(fleet.size, 1, 'one vehicle, not a duplicate');
    const merged = fleet.get('4-100');
    assert.equal(merged.id, '4-100', 'keeps the MPK id');
    assert.equal(merged.lat, 51.107, 'keeps the MPK position');
    assert.equal(merged.source, 'merged');
    assert.equal(merged.vehicleNumber, 8123);
    assert.equal(merged.brigade, '1');
    assert.ok(merged.positionUpdatedAt);
    assert.equal(fleet.has('open-data:8123'), false, 'no separate open-data entry');
    assert.deepEqual(stats, { mpk: 0, merged: 1, openData: 0, total: 1, activeLines: 1 });
  });

  it('leaves MPK vehicles with no matching record as source "mpk"', () => {
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const { fleet, stats } = mergeFleet(mpk, new Map(), MERGE_OPTIONS);

    assert.equal(fleet.get('4-100').source, 'mpk');
    assert.equal(fleet.get('4-100').vehicleNumber, undefined);
    assert.equal(stats.mpk, 1);
  });

  it('does not merge an Open Data record farther than 250 metres away', () => {
    // ~260 m apart — the same line, but not the same vehicle.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 260 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);
    assert.ok(distanceMeters(51.107, 17.038, odLat, 17.038) > 250);

    const mpkEntry = fleet.get('4-100');
    assert.equal(mpkEntry.source, 'mpk');
    assert.equal(mpkEntry.vehicleNumber, undefined);
    assert.equal(stats.merged, 0);
  });

  it('suppresses an unmatched record near any same-line MPK vehicle (no duplicate)', () => {
    // ~300 m away: too far to merge, near enough to be the same vehicle.
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 300 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    assert.equal(fleet.size, 1, 'the record is dropped, not duplicated');
    assert.equal(fleet.has('open-data:8123'), false);
    assert.equal(stats.openData, 0);
  });

  it('adds a fresh unmatched record beyond 350 metres as an open-data vehicle', () => {
    const mpk = new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]);
    const odLat = 51.107 + 400 / 111_320;
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', odLat, 17.038)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    const vehicle = fleet.get('open-data:8123');
    assert.equal(vehicle.source, 'open-data');
    assert.equal(vehicle.id, 'open-data:8123');
    assert.equal(vehicle.lat, odLat);
    assert.equal(stats.openData, 1);
    assert.equal(stats.total, 2);
  });

  it('does not guess when two same-line vehicles are both plausible matches', () => {
    // Two trams of line 4 ~30 m apart; the record sits between them.
    const mpk = new Map([
      ['4-100', mpkVehicle('4-100', 51.107, 17.038)],
      ['4-101', mpkVehicle('4-101', 51.1071, 17.0381)],
    ]);
    const od = new Map([['open-data:8123', odVehicle('open-data:8123', 51.10705, 17.03805)]]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);

    for (const id of ['4-100', '4-101']) {
      assert.equal(fleet.get(id).source, 'mpk', 'no guess, so no merge');
      assert.equal(fleet.get(id).vehicleNumber, undefined);
    }
    assert.equal(fleet.has('open-data:8123'), false, 'and it is not surfaced as a duplicate either');
    assert.equal(stats.merged, 0);
  });

  it('requires the same type before merging', () => {
    const mpk = new Map([['x-1', { ...mpkVehicle('x-1', 51.107, 17.038), line: 'X', type: 'tram' }]]);
    const od = new Map([
      [
        'open-data:8123',
        { ...odVehicle('open-data:8123', 51.1071, 17.0381), line: 'X', type: 'unknown' },
      ],
    ]);

    const { fleet, stats } = mergeFleet(mpk, od, MERGE_OPTIONS);
    assert.equal(fleet.get('x-1').source, 'mpk');
    assert.equal(stats.merged, 0);
  });
});

describe('mergeFleet — differential: single-pass implementation vs frozen reference', () => {
  it('produces identical fleets and stats to the reference across many random seeds', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const rng = mulberry32(seed);
      const { mpkFleet, openDataFleet } = randomFleetPair(rng);
      const label = `seed ${seed} (${mpkFleet.size} mpk, ${openDataFleet.size} od)`;

      const reference = mergeFleetReference(mpkFleet, openDataFleet, MERGE_OPTIONS);
      const actual = mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);

      assertSameFleet(actual.fleet, reference.fleet, label);
      assert.deepEqual(actual.stats, reference.stats, `${label}: stats`);
    }
  });

  it('stays in step for deliberately pathological boundary seeds', () => {
    for (const seed of [1, 2, 3, 7, 11, 13, 17, 42, 99, 123, 271, 65535]) {
      const rng = mulberry32(seed);
      const { mpkFleet, openDataFleet } = randomFleetPair(rng, MERGE_OPTIONS);
      const reference = mergeFleetReference(mpkFleet, openDataFleet, MERGE_OPTIONS);
      const actual = mergeFleet(mpkFleet, openDataFleet, MERGE_OPTIONS);
      assertSameFleet(actual.fleet, reference.fleet, `boundary seed ${seed}`);
      assert.deepEqual(actual.stats, reference.stats, `boundary seed ${seed}: stats`);
    }
  });

  it('agrees on empty fleets and single-vehicle fleets', () => {
    const cases = [
      [new Map(), new Map()],
      [new Map([['4-100', mpkVehicle('4-100', 51.107, 17.038)]]), new Map()],
      [new Map(), new Map([['open-data:8123', odVehicle('open-data:8123', 51.107, 17.038)]])],
    ];
    for (const [mpk, od] of cases) {
      const reference = mergeFleetReference(mpk, od, MERGE_OPTIONS);
      const actual = mergeFleet(mpk, od, MERGE_OPTIONS);
      assertSameFleet(actual.fleet, reference.fleet);
      assert.deepEqual(actual.stats, reference.stats);
    }
  });
});

describe('VehicleTracker with two sources', () => {
  const lines = { allTrams: ['4'], allBuses: ['128'] };

  /** Serves MPK-style POST /bus_position. */
  const startMpkEndpoint = (handler) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handler(body) ?? []));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  };

  /** Serves the city-style GET endpoint with a `dane` list. */
  const startOpenDataEndpoint = (handler) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dane: handler() }));
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  };

  const originalSources = config.vehicles.sources;
  const originalOpenDataUrl = config.vehicles.openDataUrl;
  const servers = [];
  let mpkUrl;
  let openDataUrl;

  const freshRow = (overrides = {}) => ({
    Nazwa_Linii: '4',
    Nr_Boczny: 8123,
    Brygada: '1',
    Data_Aktualizacji: warsawWallClock(new Date(Date.now() - 30_000)),
    Ostatnia_Pozycja_Szerokosc: 51.107,
    Ostatnia_Pozycja_Dlugosc: 17.038,
    ...overrides,
  });

  before(async () => {
    const mpkServer = await startMpkEndpoint(() => [
      { name: '4', type: 'tram', x: 51.107, y: 17.038, k: 100 },
    ]);
    const odServer = await startOpenDataEndpoint(() => [freshRow()]);
    servers.push(mpkServer, odServer);
    mpkUrl = `http://127.0.0.1:${mpkServer.address().port}/bus_position`;
    openDataUrl = `http://127.0.0.1:${odServer.address().port}/hdb/db/14`;
    process.env.NO_PROXY = '127.0.0.1,localhost';
  });

  after(() => {
    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    servers.forEach((server) => server.close());
  });

  it('merges both sources and reports the stats', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.snapshot.count, 1, 'the two positions belong to the same vehicle');
    const vehicle = tracker.snapshot.locations[0];
    assert.equal(vehicle.id, '4-100');
    assert.equal(vehicle.source, 'merged');
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.ok(vehicle.positionUpdatedAt);
    assert.deepEqual(tracker.stats, { mpk: 0, merged: 1, openData: 0, total: 1, activeLines: 1 });
  });

  it('keeps serving MPK vehicles when the Open Data source fails', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = 'http://127.0.0.1:1/dead-od';

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.openDataStatus.consecutiveFailures, 1);
    assert.equal(tracker.snapshot.locations[0].source, 'mpk');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('keeps serving Open Data vehicles when the MPK source fails', async () => {
    config.vehicles.sources = ['http://127.0.0.1:1/dead-mpk'];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    assert.equal(tracker.status.consecutiveFailures, 1);
    assert.equal(tracker.snapshot.locations[0].id, 'open-data:8123');
    assert.equal(tracker.snapshot.locations[0].source, 'open-data');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('serves a merged fleet over /locations with the payload intact', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    await tracker.pollOpenData();

    const app = createApp({
      gtfs: { isReady: false, status: { state: 'loading' }, lines: {} },
      vehicles: tracker,
      alerts: { status: { providers: [] }, getAlerts: () => [] },
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const response = await fetch(`${base}/locations`);
    const body = await response.json();

    assert.equal(body.count, 1);
    const vehicle = body.locations[0];
    // The original fields are all still there…
    assert.equal(vehicle.id, '4-100');
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.ok('heading' in vehicle);
    assert.ok('trip' in vehicle);
    assert.ok('updatedAt' in vehicle);
    // …and the new ones ride along.
    assert.equal(vehicle.source, 'merged');
    assert.equal(vehicle.vehicleNumber, 8123);
    assert.equal(vehicle.brigade, '1');
    assert.ok(vehicle.positionUpdatedAt);
  });

  it('stops both poll timers', async () => {
    let mpkPolls = 0;
    let odPolls = 0;
    const tracker = new VehicleTracker(() => lines);
    tracker.poll = async () => {
      mpkPolls += 1;
      return tracker.status;
    };
    tracker.pollOpenData = async () => {
      odPolls += 1;
      return tracker.openDataStatus;
    };

    tracker.start();
    assert.ok(tracker.timer, 'MPK timer is running');
    assert.ok(tracker.openDataTimer, 'Open Data timer is running');

    tracker.stop();
    assert.equal(tracker.timer, null);
    assert.equal(tracker.openDataTimer, null);

    const pollsAtStop = mpkPolls + odPolls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(mpkPolls + odPolls, pollsAtStop, 'no poll runs after stop()');
  });

  it('records Open Data poll timings on success', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.pollOpenData();

    const snap = tracker.openDataPerformanceSnapshot();
    for (const name of [
      'totalPollMs',
      'fetchMs',
      'normalizationMs',
      'mergeMs',
      'descriptionMs',
      'snapshotBuildMs',
      'incomingVehicleCount',
      'acceptedVehicleCount',
      'descriptionsReused',
      'descriptionsRecomputed',
    ]) {
      assert.ok(snap[name], `metric ${name} exists`);
      assert.equal(snap[name].count, 1, `${name} recorded once`);
      assert.ok(Number.isFinite(snap[name].latest), `${name}.latest is a number`);
    }
    assert.equal(snap.incomingVehicleCount.latest, 1);
    assert.equal(snap.acceptedVehicleCount.latest, 1);
  });

  it('failed Open Data fetch records totalPollMs but not stage timings', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = 'http://127.0.0.1:1/dead-od';

    const tracker = new VehicleTracker(() => lines);
    await tracker.pollOpenData();

    const snap = tracker.openDataPerformanceSnapshot();
    // Total duration is always recorded, even on failure.
    assert.equal(snap.totalPollMs.count, 1);
    assert.ok(Number.isFinite(snap.totalPollMs.latest));
    // Fetch failed — its ms was never recorded, so count stays 0.
    assert.equal(snap.fetchMs.count, 0);
    assert.equal(snap.normalizationMs.count, 0);
    assert.equal(snap.mergeMs.count, 0);
    assert.equal(snap.descriptionMs.count, 0);
    assert.equal(snap.snapshotBuildMs.count, 0);
  });

  it('preserves successful stage timings after a failed fetch', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    await tracker.pollOpenData();

    const before = tracker.openDataPerformanceSnapshot();
    assert.equal(before.fetchMs.count, 1);
    assert.ok(Number.isFinite(before.fetchMs.latest));

    // Now fail: switch to a dead URL.
    config.vehicles.openDataUrl = 'http://127.0.0.1:1/dead-od';
    await tracker.pollOpenData();

    const after = tracker.openDataPerformanceSnapshot();
    // totalPollMs got a second recording from the failed poll.
    assert.equal(after.totalPollMs.count, 2);
    // Fetch failed: its ms was NOT re-recorded, so it keeps the successful value.
    assert.equal(after.fetchMs.count, 1, 'failed fetch does not add a bogus stage timing');
  });

  it('updates EWMA and max across repeated Open Data polls', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    for (let i = 0; i < 5; i += 1) {
      await tracker.pollOpenData();
    }

    const snap = tracker.openDataPerformanceSnapshot();
    assert.equal(snap.totalPollMs.count, 5, 'accumulates across polls');
    assert.ok(Number.isFinite(snap.totalPollMs.ewma), 'EWMA is computed');
    assert.ok(snap.totalPollMs.max >= snap.totalPollMs.latest, 'max >= latest');
    // Counters also accumulate.
    assert.equal(snap.incomingVehicleCount.count, 5);
    assert.equal(snap.acceptedVehicleCount.count, 5);
  });

  it('keeps Open Data metrics bounded (no history arrays)', async () => {
    config.vehicles.sources = [mpkUrl];
    config.vehicles.openDataUrl = openDataUrl;

    const tracker = new VehicleTracker(() => lines);
    for (let i = 0; i < 50; i += 1) {
      await tracker.pollOpenData();
    }

    const snap = tracker.openDataPerformanceSnapshot();
    assert.equal(snap.totalPollMs.count, 50, 'count grows but state is O(1)');
    // Each snapshot metric has exactly the four bounded fields.
    for (const metric of Object.values(snap)) {
      assert.deepEqual(Object.keys(metric), ['latest', 'ewma', 'max', 'count']);
    }
  });
});
