'use strict';

const { entryBuffer } = require('./archive');
const { parseTable } = require('./parse');

/**
 * The table naming a vehicle type, under the names publishers have used for it.
 *
 * `vehicle_types.txt` is not in the GTFS spec — it is one of the extra tables
 * this feed carries alongside `trips.vehicle_id` and `trips.brigade_id`, which
 * are not in the spec either. Every name is tried through `findEntry()`
 * (invariant 5), so a nested layout is found the same way `shapes.txt` is.
 */
const FILE_NAMES = ['vehicle_types.txt', 'vehicle_type.txt', 'vehicles.txt'];

/**
 * Column aliases.
 *
 * Read the way `parseFileListing()` reads the catalogue: the payload's exact
 * shape is not documented anywhere verifiable, so the reader looks for a
 * column that plausibly carries each field instead of pinning one spelling and
 * silently returning nothing when the publisher picks another. Polish spellings
 * sit beside English ones because this feed mixes them already (`Nr_Boczny`,
 * `brigade_id`).
 */
const ID_KEYS = ['vehicle_type_id', 'vehicle_id', 'type_id', 'id'];
const NAME_KEYS = [
  'vehicle_type_name',
  'vehicle_name',
  'type_name',
  'model',
  'nazwa',
  'name',
];
const DESCRIPTION_KEYS = [
  'vehicle_type_description',
  'vehicle_description',
  'description',
  'opis',
  'uwagi',
];
const LOW_FLOOR_KEYS = ['low_floor', 'lowfloor', 'niskopodlogowy', 'niskopodlogowa', 'niska_podloga'];
const AIR_KEYS = ['air_conditioning', 'air_conditioned', 'airconditioning', 'klimatyzacja', 'ac'];
const WHEELCHAIR_KEYS = ['wheelchair_accessible', 'wheelchair', 'wheelchair_boarding', 'wozek'];

/** Header lookup that ignores case, spaces and the odd BOM. */
const normaliseKey = (key) => String(key).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const pick = (row, keys) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
};

/**
 * A flag column as a tri-state.
 *
 * Same rule as `wheelchair_accessible`: a column that is present but empty
 * states nothing, and so does a value this does not recognise. Only an explicit
 * yes or no becomes a boolean — including GTFS's own `2 = not accessible`,
 * which is why a bare `2` is false rather than truthy.
 */
const parseFlag = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (text === '') return null;
  if (['1', 'true', 'yes', 't', 'y', 'tak'].includes(text)) return true;
  if (['0', '2', 'false', 'no', 'n', 'nie', 'brak'].includes(text)) return false;
  return null;
};

// Polish, because the descriptions in this feed are. Accents are stripped
// before matching so "niskopodłogowy" and a de-accented export both hit.
// `ł` has to be replaced by hand: it is a distinct letter, not an `l` with a
// combining mark, so NFD leaves it alone and every "niskopodłogowy" the feed
// carries would sail straight past a pattern written in ASCII.
const deaccent = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l')
    .replace(/\u0141/g, 'L')
    .toLowerCase();

const NEGATED_AIR = /(bez|brak)\s+klimatyzacj/;
const AIR_WORD = /klimatyz/;
const PARTIAL_LOW_FLOOR = /(czesciow|niskopodlogow[a-z]*\s+czesciow)/;
const LOW_FLOOR_WORD = /niskopodlogow/;
const HIGH_FLOOR_WORD = /wysokopodlogow/;

/**
 * What the type's own words say about it, for a feed that describes its stock
 * in prose rather than in columns.
 *
 * Only an explicit statement counts. A description that never mentions air
 * conditioning leaves it null — silence is not a "no", which is the same rule
 * the columns above follow and the reason this file can be trusted to feed a
 * screen that tells a rider whether to wait for the next one.
 */
const readPhrases = (text) => {
  const found = { lowFloor: null, airConditioning: null };
  if (!text) return found;
  const words = deaccent(text);

  if (HIGH_FLOOR_WORD.test(words)) found.lowFloor = 'none';
  else if (LOW_FLOOR_WORD.test(words)) found.lowFloor = PARTIAL_LOW_FLOOR.test(words) ? 'partial' : 'full';

  if (NEGATED_AIR.test(words)) found.airConditioning = false;
  else if (AIR_WORD.test(words)) found.airConditioning = true;

  return found;
};

/** A percentage or a level column ("100", "27%", "partial") as a low-floor grade. */
const parseLowFloor = (value) => {
  if (value === null || value === undefined) return null;
  const text = deaccent(String(value).trim());
  if (!text) return null;
  if (['full', 'pelna', 'pelno'].includes(text)) return 'full';
  if (['partial', 'czesciowa', 'czesciowo', 'part'].includes(text)) return 'partial';
  if (['none', 'brak', 'wysoka'].includes(text)) return 'none';

  const percent = /^(\d{1,3})\s*%?$/.exec(text);
  if (percent) {
    const share = Number(percent[1]);
    // 0 and 1 are the flag encoding, not a percentage — a "low_floor" column
    // holding 1 means yes, not one percent.
    if (share === 0) return 'none';
    if (share === 1) return 'full';
    if (share >= 100) return 'full';
    return 'partial';
  }

  const flag = parseFlag(value);
  if (flag === true) return 'full';
  if (flag === false) return 'none';
  return null;
};

/**
 * Read `vehicle_types.txt` out of a feed that carries one.
 *
 * This is the answer the roster in `src/fleet.js` exists to substitute for: a
 * feed that states its own stock is the authority on it, and needs no file
 * anybody maintains by hand. Most feeds do not carry the table, so an absent
 * one is the normal case and returns an empty map rather than an error.
 *
 * @param {import('adm-zip')} zip
 * @returns {Map<string, Readonly<object>>} type id -> attributes, `{}` when the
 *   feed has no such table.
 */
const readVehicleTypes = (zip) => {
  const types = new Map();

  let buffer = null;
  for (const name of FILE_NAMES) {
    buffer = entryBuffer(zip, name);
    if (buffer) break;
  }
  if (!buffer) return types;

  for (const raw of parseTable(buffer)) {
    /** @type {Record<string, string>} */
    const row = {};
    for (const [key, value] of Object.entries(raw)) row[normaliseKey(key)] = value;

    const id = pick(row, ID_KEYS);
    if (!id) continue;

    const name = pick(row, NAME_KEYS);
    const description = pick(row, DESCRIPTION_KEYS);
    // Columns are the stated answer; the prose is only consulted for what no
    // column covered, so a publisher that says both never has its own column
    // overruled by a word in a sentence.
    const phrases = readPhrases([name, description].filter(Boolean).join(' '));

    const lowFloorColumn = parseLowFloor(pick(row, LOW_FLOOR_KEYS));
    const airColumn = parseFlag(pick(row, AIR_KEYS));
    const wheelchairColumn = parseFlag(pick(row, WHEELCHAIR_KEYS));

    const lowFloor = lowFloorColumn ?? phrases.lowFloor;

    types.set(id, {
      // Frozen and shared for the life of the feed, exactly like a roster
      // entry: every vehicle of this type is handed the same object.
      model: name ?? description ?? null,
      lowFloor,
      // A low floor is how a wheelchair gets on, so a type that states one and
      // says nothing about wheelchairs still answers the question a rider is
      // actually asking. Never the other way round: a stated `false` stands.
      wheelchair: wheelchairColumn ?? (lowFloor === null ? null : lowFloor !== 'none'),
      airConditioning: airColumn ?? phrases.airConditioning,
      description: description ?? null,
    });
  }

  // Freeze after the loop so the objects handed out can never be edited by a
  // caller that got one from `getVehicleType`.
  for (const [id, value] of types) types.set(id, Object.freeze(value));
  return types;
};

module.exports = {
  FILE_NAMES,
  parseFlag,
  parseLowFloor,
  readPhrases,
  readVehicleTypes,
};
