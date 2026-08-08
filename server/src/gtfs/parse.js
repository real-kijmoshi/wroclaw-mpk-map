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

// Precompiled once, not per call: the per-instant lookup used to go through
// `date.toLocaleString('en-US', { timeZone })`, which costs ~120µs because it
// builds a whole formatter each time. formatToParts on one shared formatter is
// ~7x cheaper and does not care what timezone this process runs in.
const warsawWallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * The same instant, read as a wall clock in Wrocław.
 *
 * Returns a Date whose getters (getFullYear, getHours, …) read the
 * Europe/Warsaw time of `date`, so timetable code never depends on the
 * timezone the process happens to run in.
 */
const inWarsaw = (date) => {
  const parts = warsawWallClock.formatToParts(date);
  const fields = {};
  for (const part of parts) fields[part.type] = part.value;
  return new Date(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour) % 24,
    Number(fields.minute),
    Number(fields.second),
  );
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
 * Split one CSV line, honouring `"..."` quoting and the `""` escape.
 *
 * @param {string} line
 * @param {(value: string) => void} onField
 */
const splitCsvLine = (line, onField) => {
  let field = '';
  let inQuotes = false;
  let index = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      onField(field, index);
      index += 1;
      field = '';
    } else {
      field += ch;
    }
  }
  onField(field, index);
};

/**
 * A faster row iterator for the tables where csv-parse's per-row object
 * allocation shows up. Building a keyed object for each of stop_times.txt's
 * ~1.1M rows is the bulk of a cold GTFS build; this splits each line into an
 * array of fields and hands the caller a header->index map to index them by.
 * Quotes and CRLF are handled so a feed that quotes a comma or ships Windows
 * line endings is not mis-split.
 *
 * @param {Buffer} buffer
 * @param {(fields: string[], columns: Map<string, number>) => void} onRow
 */
const streamTableFast = async (buffer, onRow) => {
  // The file is read straight off the Buffer, line by line, rather than
  // converted to one big string and split into an array of every line first:
  // stop_times.txt is a million rows, and either whole-table structure is one
  // of the largest transients of a cold GTFS build.
  let from = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    from = 3; // UTF-8 BOM
  }

  const columns = new Map();
  let processed = 0;
  while (from < buffer.length) {
    let newline = buffer.indexOf(0x0a, from);
    if (newline === -1) newline = buffer.length;
    // Strip a CRLF line ending; a lone CR inside a quoted field is kept.
    let end = newline;
    if (end > from && buffer[end - 1] === 0x0d) end -= 1;

    const line = buffer.toString('utf8', from, end);
    from = newline + 1;

    if (processed === 0) {
      splitCsvLine(line, (value, index) => columns.set(value.trim(), index));
      processed += 1;
      continue;
    }
    if (!line) continue;

    const fields = [];
    splitCsvLine(line, (value) => fields.push(value.trim()));
    onRow(fields, columns);
    processed += 1;
    // Let the event loop breathe on the big tables so the vehicle polls queued
    // during a cold-start build are not starved for the whole ingest.
    if ((processed & 0xffff) === 0) await new Promise((resolve) => setImmediate(resolve));
  }
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

module.exports = { inWarsaw, parseTable, streamTable, streamTableFast, timeToSeconds, secondsToTime };
