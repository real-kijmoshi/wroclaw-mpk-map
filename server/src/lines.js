'use strict';

/**
 * Line naming rules for Wrocław public transport.
 *
 * MPK does not publish a machine readable line taxonomy, so the category is
 * derived from the line number/letter. Keeping this pure makes it testable and
 * keeps the parsing rules in one place.
 */

const CATEGORIES = [
  'tram',
  'tramSpecial',
  'tramTemporary',
  'bus',
  'busNight',
  'busSuburban',
  'busTemporary',
  'busZone',
  'busExpress',
  'busSpecial',
  'unknown',
];

const TRAM_CATEGORIES = new Set(['tram', 'tramSpecial', 'tramTemporary']);

const EXPRESS_LINES = new Set(['A', 'C', 'D', 'K', 'N']);

/** Sightseeing / historic tram lines run under letter suffixes on line 0. */
const SPECIAL_TRAM_LINES = new Set(['0L', '0P', '23', '74']);

const emptyCategories = () => {
  const categories = {};
  for (const category of CATEGORIES) categories[category] = [];
  categories.allTrams = [];
  categories.allBuses = [];
  return categories;
};

/**
 * Classify a single line label.
 *
 * @param {string} line line short name as published in GTFS (e.g. "4", "A", "N")
 * @returns {string} one of CATEGORIES
 */
const lineToType = (line) => {
  if (typeof line !== 'string') return 'unknown';

  const name = line.trim().toUpperCase();
  if (!name) return 'unknown';

  if (SPECIAL_TRAM_LINES.has(name)) return 'tramSpecial';
  if (EXPRESS_LINES.has(name)) return 'busExpress';

  // "T" prefixed lines are replacement trams announced during track works.
  if (name.startsWith('T') && /^T\d+$/.test(name)) return 'tramTemporary';

  if (/^\d+$/.test(name)) {
    const value = Number.parseInt(name, 10);
    if (value < 40) return 'tram';
    if (value >= 70 && value < 100) return 'tramTemporary';
    if (value >= 200 && value < 300) return 'busNight';
    if (value >= 600 && value < 700) return 'busSuburban';
    if (value >= 700 && value < 800) return 'busTemporary';
    if (value >= 900 && value < 1000) return 'busZone';
    return 'bus';
  }

  // "B" is the substitute-bus prefix ("bus za tramwaj").
  if (name.startsWith('B')) return 'busSpecial';

  return 'unknown';
};

const isTram = (line) => TRAM_CATEGORIES.has(lineToType(line));

/**
 * Natural sort so "4" comes before "10" and letters land after numbers.
 */
const compareLines = (a, b) => {
  const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
  const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
  if (aNum !== null && bNum !== null) return aNum - bNum;
  if (aNum !== null) return -1;
  if (bNum !== null) return 1;
  return a.localeCompare(b, 'pl');
};

/**
 * Group raw line labels into the categories the clients render.
 *
 * @param {string[]} rawLines
 * @returns {Record<string, string[]>}
 */
const categorizeLines = (rawLines) => {
  const categories = emptyCategories();
  const seen = new Set();

  for (const raw of rawLines || []) {
    if (typeof raw !== 'string') continue;
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);

    const type = lineToType(line);
    categories[type].push(line);
    if (type === 'unknown') continue;
    if (TRAM_CATEGORIES.has(type)) categories.allTrams.push(line);
    else categories.allBuses.push(line);
  }

  for (const key of Object.keys(categories)) categories[key].sort(compareLines);

  return categories;
};

module.exports = {
  CATEGORIES,
  EXPRESS_LINES,
  categorizeLines,
  compareLines,
  emptyCategories,
  isTram,
  lineToType,
};
