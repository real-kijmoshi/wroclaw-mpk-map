'use strict';

const AdmZip = require('adm-zip');

const { REQUIRED_TABLES } = require('./catalogue');
const { parseTable } = require('./parse');

/**
 * Find a GTFS table inside the archive by file name, ignoring any directory.
 *
 * Some publishers ship the tables at the root and others nest them in a folder
 * (`GTFS/shapes.txt`). An exact-path lookup silently misses the nested layout,
 * which then looks like a feed that is missing shapes.txt — the dane.gov.pl
 * mirror was rejected in production for exactly this reason.
 */
const findEntry = (zip, fileName) => {
  const wanted = fileName.toLowerCase();
  return (
    zip.getEntry(fileName) ??
    zip.getEntries().find((entry) => {
      if (entry.isDirectory) return false;
      return entry.entryName.replace(/^.*\//, '').toLowerCase() === wanted;
    }) ??
    null
  );
};

const entryBuffer = (zip, name) => {
  const entry = findEntry(zip, name);
  return entry ? entry.getData() : null;
};

/**
 * Reject an archive that is missing tables the map needs.
 *
 * The city's archive interleaves complete ~11 MB snapshots with ~6 MB ones, and
 * a snapshot without `shapes.txt` produces a map with vehicles but no routes —
 * which looks like a rendering bug, not a data problem. Checked before the
 * expensive indexing so a bad candidate costs one download, not a full build.
 *
 * @throws when a required table is absent or empty
 */
const assertComplete = (buffer) => {
  const zip = new AdmZip(buffer);
  const missing = REQUIRED_TABLES.filter((table) => {
    const entry = findEntry(zip, `${table}.txt`);
    // A header-only table is as useless as an absent one.
    return !entry || entry.header.size < 64;
  });

  if (missing.length) {
    throw new Error(`incomplete feed, missing ${missing.map((t) => `${t}.txt`).join(', ')}`);
  }
};

const isDate = (value) => typeof value === 'string' && /^\d{8}$/.test(value);

/**
 * When a feed is valid, read out of the feed itself.
 *
 * The filename usually says (`..._GTFS_25072026`), but the filename is a
 * convention that can change and is not always available — the city's data API
 * hands out bare file ids. The archive is the authority on its own dates:
 * `feed_info.txt` states them outright, and `calendar.txt` bounds them.
 *
 * @returns {{start: string, end: string}|null} YYYYMMDD, as GTFS writes them
 */
const readEffectiveWindow = (buffer) => {
  const zip = new AdmZip(buffer);

  const info = entryBuffer(zip, 'feed_info.txt');
  if (info) {
    const [row] = parseTable(info);
    if (isDate(row?.feed_start_date) && isDate(row?.feed_end_date)) {
      return { start: row.feed_start_date, end: row.feed_end_date };
    }
  }

  const calendar = entryBuffer(zip, 'calendar.txt');
  if (!calendar) return null;

  let start = null;
  let end = null;
  for (const row of parseTable(calendar)) {
    if (isDate(row.start_date) && (start === null || row.start_date < start)) start = row.start_date;
    if (isDate(row.end_date) && (end === null || row.end_date > end)) end = row.end_date;
  }

  return start && end ? { start, end } : null;
};

/** YYYYMMDD for a Date, in Europe/Warsaw where the timetable lives. */
const serviceDayKey = (date = new Date()) => {
  const local = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  return (
    `${local.getFullYear()}` +
    `${String(local.getMonth() + 1).padStart(2, '0')}` +
    `${String(local.getDate()).padStart(2, '0')}`
  );
};

/**
 * Is this archive the timetable in force today?
 *
 * Used to choose between candidates when their names are unavailable, so a
 * future-dated snapshot is not served early. An archive that declares no dates
 * at all counts as in force — better to run on it than to reject everything.
 */
const isInForce = (buffer, now = new Date()) => {
  const window = readEffectiveWindow(buffer);
  if (!window) return true;

  const today = serviceDayKey(now);
  return window.start <= today && today <= window.end;
};

module.exports = {
  assertComplete,
  entryBuffer,
  findEntry,
  isInForce,
  readEffectiveWindow,
  serviceDayKey,
};
