#!/usr/bin/env node
'use strict';

/**
 * Upstream connectivity check.
 *
 * Wrocław's open-data portal and MPK's live-position endpoint have both moved
 * in the past, and when they move the server just goes quiet. Run
 * `npm run doctor` to see exactly which sources answer today, then put the
 * winners in .env (GTFS_URLS / VEHICLE_POSITION_URLS / ALERT_FEED_URLS).
 */

const AdmZip = require('adm-zip');

const config = require('../src/config');
const { fetchWithTimeout } = require('../src/http');
const { parseFeed } = require('../src/alerts');

const PASS = '[32m✔[0m';
const FAIL = '[31m✘[0m';
const DIM = (text) => `[2m${text}[0m`;

const results = [];

const report = (group, url, ok, detail) => {
  results.push({ group, url, ok });
  console.log(`  ${ok ? PASS : FAIL} ${url}`);
  if (detail) console.log(`      ${DIM(detail)}`);
};

const timed = async (task) => {
  const startedAt = Date.now();
  const value = await task();
  return { value, ms: Date.now() - startedAt };
};

const checkGtfs = async () => {
  console.log('\nGTFS timetable archives');
  for (const url of config.gtfs.sources) {
    try {
      const { value: buffer, ms } = await timed(async () => {
        const response = await fetchWithTimeout(url, {
          timeoutMs: config.gtfs.timeoutMs,
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return Buffer.from(await response.arrayBuffer());
      });

      const names = new AdmZip(buffer)
        .getEntries()
        .map((entry) => entry.entryName)
        .filter((name) => name.endsWith('.txt'));

      if (!names.includes('routes.txt') || !names.includes('trips.txt')) {
        throw new Error(`zip is missing core GTFS tables (has: ${names.join(', ') || 'nothing'})`);
      }

      report(
        'gtfs',
        url,
        true,
        `${(buffer.length / 1e6).toFixed(1)} MB in ${ms} ms — ${names.length} tables`,
      );
    } catch (error) {
      report('gtfs', url, false, error.message);
    }
  }
};

const checkVehicles = async () => {
  console.log('\nLive vehicle positions');
  const body = new URLSearchParams();
  for (const line of ['4', '17', '128']) body.append('busList[bus][]', line);
  for (const line of ['4', '17']) body.append('busList[tram][]', line);

  for (const url of config.vehicles.sources) {
    try {
      const { value, ms } = await timed(async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          timeoutMs: config.vehicles.timeoutMs,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`not JSON: ${text.slice(0, 80).replace(/\s+/g, ' ')}…`);
        }
      });

      const rows = Array.isArray(value) ? value : value.vehicles ?? value.data ?? [];
      if (!Array.isArray(rows)) throw new Error('no vehicle list in the response');

      const sample = rows[0] ? JSON.stringify(rows[0]) : 'none';
      report('vehicles', url, rows.length > 0, `${rows.length} vehicles in ${ms} ms — sample ${sample}`);
    } catch (error) {
      report('vehicles', url, false, error.message);
    }
  }
};

const checkAlerts = async () => {
  console.log('\nService alert feeds');
  for (const url of config.alerts.feeds) {
    try {
      const { value: items, ms } = await timed(async () => {
        const response = await fetchWithTimeout(url, { timeoutMs: config.alerts.timeoutMs });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return parseFeed(await response.text(), url);
      });

      if (!items.length) throw new Error('parsed as a feed but contained no items');
      report('alerts', url, true, `${items.length} items in ${ms} ms — latest: ${items[0].title ?? items[0].content?.slice(0, 60)}`);
    } catch (error) {
      report('alerts', url, false, error.message);
    }
  }

  if (config.alerts.twitter.bearerToken) {
    console.log(DIM('  X/Twitter provider enabled (a paid tier is required to read timelines)'));
  } else {
    console.log(DIM('  X/Twitter provider disabled — set TWITTER_BEARER_TOKEN to enable'));
  }
};

const main = async () => {
  console.log('Checking every upstream source this server depends on.\n');
  console.log(DIM('Override any of them with GTFS_URLS, VEHICLE_POSITION_URLS or ALERT_FEED_URLS.'));

  await checkGtfs();
  await checkVehicles();
  await checkAlerts();

  console.log('\nSummary');
  const groups = ['gtfs', 'vehicles', 'alerts'];
  let fatal = false;

  for (const group of groups) {
    const inGroup = results.filter((result) => result.group === group);
    const working = inGroup.filter((result) => result.ok);
    // Alerts are a nice-to-have; the other two are what the map is made of.
    const required = group !== 'alerts';
    const ok = working.length > 0;
    if (required && !ok) fatal = true;

    console.log(
      `  ${ok ? PASS : FAIL} ${group}: ${working.length}/${inGroup.length} sources reachable` +
        (ok ? ` — using ${working[0].url}` : required ? ' — THIS BREAKS THE APP' : ' — alerts will be empty'),
    );
  }

  if (fatal) {
    console.log(
      '\nNo working source for required data. If MPK or the city portal changed URLs again,\n' +
        'add the new one to .env, for example:\n' +
        '  GTFS_URLS=https://new-host/gtfs.zip,https://www.wroclaw.pl/open-data/…/GTFS.zip',
    );
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
