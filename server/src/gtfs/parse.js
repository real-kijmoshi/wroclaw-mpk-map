'use strict';

const { Readable } = require('node:stream');
const { parse } = require('csv-parse');
const { parse: parseSync } = require('csv-parse/sync');

const CSV_OPTIONS = {
  bom: true,
  columns: (header) => header.map((column) => column.trim()),
  skip_empty_lines: true,
  relax_column_count: true,
  trim: true,
};

/** Parse a whole GTFS table into an array of objects. Use for small files. */
const parseTable = (buffer) => parseSync(buffer, CSV_OPTIONS);

/**
 * Stream a large GTFS table row by row so the full array never exists in
 * memory. stop_times.txt and shapes.txt are millions of rows in Wrocław's feed.
 *
 * @param {Buffer} buffer
 * @param {(row: Record<string, string>) => void} onRow
 */
const streamTable = async (buffer, onRow) => {
  const parser = Readable.from(buffer).pipe(parse(CSV_OPTIONS));
  for await (const row of parser) onRow(row);
};

/**
 * GTFS times may exceed 24h ("25:10:00" is 1:10 the next day), so they are kept
 * as seconds after midnight of the service day.
 *
 * @returns {number} seconds, or -1 when unparseable
 */
const timeToSeconds = (value) => {
  if (!value) return -1;
  const parts = value.split(':');
  if (parts.length < 2) return -1;
  const hours = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  const seconds = parts.length > 2 ? Number.parseInt(parts[2], 10) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return -1;
  return hours * 3600 + minutes * 60 + seconds;
};

/** Inverse of timeToSeconds, wrapping past-midnight times back into 00:xx. */
const secondsToTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
};

module.exports = { parseTable, streamTable, timeToSeconds, secondsToTime };
