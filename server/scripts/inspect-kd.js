#!/usr/bin/env node
'use strict';

/**
 * Inspect the real KD (Koleje Dolnośląskie) GTFS sample.
 *
 * The sample lives behind HTTP Basic Auth at
 * https://kd.kiedyprzyjedzie.pl/gtfs/kd_sample/google_transit.zip and is what
 * the whole KD integration is shaped around, so before writing any parser this
 * prints exactly what the current feed contains: every table, its columns and
 * its record count — and the answers to the questions the implementation
 * depends on (has shape_id? has trip_short_name? has platform_code?).
 *
 * Run with the credentials in the environment:
 *
 *   KD_GTFS_URL=https://kd.kiedyprzyjedzie.pl/gtfs/kd_sample/google_transit.zip
 *   KD_GTFS_USERNAME=kd_sample
 *   KD_GTFS_PASSWORD='…'
 *   node scripts/inspect-kd.js
 */

const AdmZip = require('adm-zip');

const config = require('../src/config');
const { fetchWithTimeout } = require('../src/http');
const { findEntry } = require('../src/gtfs/archive');
const { parseTable } = require('../src/gtfs/parse');

const TABLES = [
  'agency',
  'routes',
  'trips',
  'stops',
  'stop_times',
  'calendar',
  'calendar_dates',
  'feed_info',
  'shapes',
];

const header = (text) => console.log(`\n=== ${text} ===`);

const main = async () => {
  const { enabled, gtfsUrl, username, password, timeoutMs } = config.kd;

  if (!username || !password) {
    console.error('KD_GTFS_USERNAME / KD_GTFS_PASSWORD are required.');
    process.exitCode = 1;
    return;
  }

  console.log(`enabled=${enabled}`);
  console.log(`url=${gtfsUrl}`);
  console.log('(credentials not printed)');

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  header('Download');
  const startedAt = Date.now();

  const response = await fetchWithTimeout(gtfsUrl, {
    timeoutMs,
    redirect: 'follow',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/zip' },
  });

  console.log(`HTTP ${response.status} ${response.statusText}`);
  console.log(`Content-Type: ${response.headers.get('content-type') ?? '(none)'}`);
  console.log(`Content-Length: ${response.headers.get('content-length') ?? '(unknown)'}`);
  console.log(`Downloaded in ${Date.now() - startedAt} ms`);

  if (!response.ok) {
    if (response.status === 401) {
      console.error('KD GTFS authentication failed (401)');
    }
    process.exitCode = 1;
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // A zip starts with the local-file signature PK\x03\x04 (or an empty-archive
  // PK\x05\x06). Anything else means the server answered with an error page
  // wearing a 200.
  const isZip =
    buffer.length > 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    buffer[3] === 0x04;
  console.log(`Looks like a ZIP: ${isZip ? 'YES' : 'NO'}`);
  if (!isZip) {
    console.log(`First bytes: ${buffer.slice(0, 32).toString('utf8')}`);
    process.exitCode = 1;
    return;
  }

  const zip = new AdmZip(buffer);

  const files = zip
    .getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .sort();

  header('Tables in the archive');
  for (const name of files) console.log(`  ${name}`);

  const counts = {};
  const columns = {};

  header('Schema and record counts');
  for (const table of TABLES) {
    const entry = findEntry(zip, `${table}.txt`);
    if (!entry) {
      console.log(`  ${table}.txt — MISSING`);
      continue;
    }
    const rows = parseTable(entry.getData());
    counts[table] = rows.length;
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    columns[table] = cols;
    console.log(`  ${table}.txt — ${rows.length} rows`);
    console.log(`      columns: ${JSON.stringify(cols)}`);
  }

  header('Answers the implementation depends on');
  const tripsCols = columns.trips ?? [];
  console.log(`Has trips.shape_id:        ${tripsCols.includes('shape_id') ? 'YES' : 'NO'}`);
  console.log(`Has trips.trip_short_name: ${tripsCols.includes('trip_short_name') ? 'YES' : 'NO'}`);
  console.log(`Has trips.direction_id:    ${tripsCols.includes('direction_id') ? 'YES' : 'NO'}`);
  console.log(`Has stops.platform_code:   ${(columns.stops ?? []).includes('platform_code') ? 'YES' : 'NO'}`);
  console.log(`Has trips.block_id:        ${tripsCols.includes('block_id') ? 'YES' : 'NO'}`);

  header('Sample rows');
  const sample = (table, row = 0) => {
    const entry = findEntry(zip, `${table}.txt`);
    if (!entry) return;
    const rows = parseTable(entry.getData());
    console.log(`  ${table} #${row}: ${JSON.stringify(rows[row] ?? null)}`);
  };
  sample('routes');
  sample('trips');
  sample('stops');
  sample('stop_times');

  const feed = parseTable(findEntry(zip, 'feed_info.txt')?.getData() ?? Buffer.from(''));
  if (feed[0]) console.log(`\n  feed_info: ${JSON.stringify(feed[0])}`);

  console.log('\nSummary');
  for (const key of ['routes', 'trips', 'stops', 'stop_times', 'shapes']) {
    console.log(`  ${key}: ${counts[key] ?? 0}`);
  }
};

main().catch((error) => {
  console.error(`inspect-kd failed: ${error.message}`);
  process.exitCode = 1;
});
