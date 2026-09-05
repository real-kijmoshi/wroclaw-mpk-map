#!/usr/bin/env node
'use strict';

/**
 * Upstream connectivity check.
 *
 * Wrocław's open-data portal and MPK's live-position endpoint have both moved
 * in the past, and when they move the server just goes quiet. Run
 * `npm run doctor` to see exactly which sources answer today.
 *
 * The GTFS download URL is not configured anywhere — it is resolved at runtime
 * from the city's data API, so this reports which snapshot discovery picked as
 * well as whether it downloads.
 */

const AdmZip = require('adm-zip');

const config = require('../src/config');
const { fetchWithTimeout, requestText } = require('../src/http');
const { buildBridgeUrl, parseFeed, parsePage, parseStructuredNotices } = require('../src/alerts');
const { fetchKlosokFeed } = require('../src/klosok/fetch');
const { parseRealtime: parseKlosokRealtime } = require('../src/klosok/realtime');
const { resolveFeedCandidates } = require('../src/gtfs/catalogue');
const { assertComplete } = require('../src/gtfs/store');

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

  // Discovery first: the download URL is resolved at runtime from the city's
  // data API, so "which URL" is itself part of what this checks.
  let candidates = [];
  try {
    candidates = await resolveFeedCandidates();
    console.log(DIM(`  catalogue resolved ${candidates.length} candidate(s)`));
    if (candidates[0]?.name) console.log(DIM(`  snapshot in force: ${candidates[0].name}`));
  } catch (error) {
    report('gtfs', config.gtfs.catalogueUrl, false, `discovery failed: ${error.message}`);
  }

  if (!candidates.length) {
    report('gtfs', config.gtfs.catalogueUrl, false, 'no candidates resolved');
    return;
  }

  for (const { url } of candidates.slice(0, config.gtfs.maxCandidates)) {
    try {
      const { value: buffer, ms } = await timed(async () => {
        const response = await fetchWithTimeout(url, {
          timeoutMs: config.gtfs.timeoutMs,
          redirect: 'follow',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return Buffer.from(await response.arrayBuffer());
      });

      // Same completeness check the server applies before accepting a feed.
      assertComplete(buffer);
      const names = new AdmZip(buffer)
        .getEntries()
        .map((entry) => entry.entryName)
        .filter((name) => name.endsWith('.txt'));

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

// A handful of lines that always run, so an empty answer means the request was
// rejected rather than that nothing happens to be moving.
const SAMPLE_TRAMS = ['4', '17'];
const SAMPLE_BUSES = ['128', '145'];

const VEHICLE_BODIES = {
  // Two encodings are documented in the wild; report which one MPK accepts.
  typed: () => {
    const body = new URLSearchParams();
    for (const line of SAMPLE_BUSES) body.append('busList[bus][]', line);
    for (const line of SAMPLE_TRAMS) body.append('busList[tram][]', line);
    return body;
  },
  flat: () => {
    const body = new URLSearchParams();
    for (const line of [...SAMPLE_TRAMS, ...SAMPLE_BUSES]) body.append('busList[][]', line);
    return body;
  },
};

const checkVehicles = async () => {
  console.log('\nLive vehicle positions');

  for (const url of config.vehicles.sources) {
    let anyWorked = false;

    for (const [name, buildBody] of Object.entries(VEHICLE_BODIES)) {
      try {
        const { value, ms } = await timed(async () => {
          const response = await fetchWithTimeout(url, {
            method: 'POST',
            timeoutMs: config.vehicles.timeoutMs,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: buildBody().toString(),
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
        if (!rows.length) throw new Error('empty list — this body encoding was not accepted');

        anyWorked = true;
        report(
          'vehicles',
          `${url}  [${name}]`,
          true,
          `${rows.length} vehicles in ${ms} ms — sample ${JSON.stringify(rows[0])}`,
        );
      } catch (error) {
        report('vehicles', `${url}  [${name}]`, false, error.message);
      }
    }

    if (!anyWorked) {
      console.log(DIM('      No body encoding worked for this URL — the endpoint likely changed.'));
    }
  }
};

const checkOpenData = async () => {
  console.log('\nOpen Data vehicle positions');
  const url = config.vehicles.openDataUrl;
  if (!url) {
    console.log(DIM('  No Open Data source configured — set OPEN_DATA_VEHICLE_URL to enable.'));
    return;
  }

  try {
    const { value, ms } = await timed(async () => {
      const response = await fetchWithTimeout(url, { timeoutMs: config.vehicles.openDataTimeoutMs });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const payload = await response.json();
      const rows = payload?.dane;
      if (!Array.isArray(rows)) throw new Error('no "dane" list in the response');
      return rows;
    });

    if (!value.length) throw new Error('empty list — the table is empty or changed shape');
    report('open-data', url, true, `${value.length} vehicles in ${ms} ms — sample ${JSON.stringify(value[0])}`);
  } catch (error) {
    report('open-data', url, false, error.message);
  }
};

const checkKlosok = async () => {
  console.log('\nPT KŁOSOK (live bus positions)');

  const { klosok } = config;
  if (!klosok.enabled) {
    console.log(DIM('  KLOSOK_ENABLED is false — GTFS-RT check skipped.'));
    return;
  }
  if (!klosok.gtfsRtUrl) {
    console.log(DIM('  No GTFS-RT URL configured — set KLOSOK_GTFS_RT_URL to enable.'));
    return;
  }

  try {
    const { value, ms } = await timed(async () => {
      const response = await fetchKlosokFeed(klosok.gtfsRtUrl, {
        timeoutMs: klosok.timeoutMs,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    });

    const parsed = parseKlosokRealtime(value);
    if (!parsed.vehicles.length) throw new Error('feed decoded but no positions passed sanity checks');
    report(
      'klosok',
      klosok.gtfsRtUrl,
      true,
      `${parsed.stats.vehiclePositions} vehicle positions, ` +
        `${parsed.stats.freshPositions} fresh, ${parsed.tripUpdates.size} trip updates in ${ms} ms`,
    );
    for (const vehicle of parsed.vehicles.slice(0, 3)) {
      console.log(
        DIM(
          `        · ${vehicle.id} — lat ${vehicle.lat}, lon ${vehicle.lon}` +
            (vehicle.vehicleLabel ? `, label ${vehicle.vehicleLabel}` : '') +
            (vehicle.tripId ? `, trip ${vehicle.tripId}` : ''),
        ),
      );
    }
  } catch (error) {
    report('klosok', klosok.gtfsRtUrl, false, error.message);
  }
};

const checkAlerts = async () => {
  console.log('\nService notice pages');
  for (const url of config.alerts.pages) {
    try {
      const { value, ms } = await timed(async () => {
        const response = await fetchWithTimeout(url, { timeoutMs: config.alerts.timeoutMs });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const body = await response.text();
        const feed = parseFeed(body, url);
        if (feed.length) return { how: 'rss', items: feed };
        // Same order the server itself reads a page in, so this reports on
        // what it will actually get.
        const structured = parseStructuredNotices(body, url);
        if (structured.length) return { how: 'stated', items: structured };
        return { how: 'scraped', items: parsePage(body, url) };
      });

      const { how, items } = value;
      if (!items.length) throw new Error('no notices found — markup or feed shape changed');

      report('alerts', url, true, `${items.length} ${how} items in ${ms} ms`);
      // Print a few headlines: the failure mode that matters here is a source
      // that answers happily with the wrong kind of content.
      for (const item of items.slice(0, 4)) {
        const lines = item.affected?.length ? ` [${item.affected.join(' ')}]` : '';
        console.log(DIM(`        · ${(item.title ?? item.content ?? '').slice(0, 90)}${lines}`));
      }
      console.log(DIM('        (these should read as disruptions, not announcements)'));
    } catch (error) {
      report('alerts', url, false, error.message);
    }
  }

  const { enabled, bridges, username, maxPosts, timeoutMs } = config.alerts.xBridge;

  if (!enabled || !bridges.length) {
    console.log(
      DIM(`  @${username} bridge not configured — set ALERT_X_BRIDGE_URLS to add it`),
    );
    return;
  }

  // Every configured bridge is checked, not just the first that answers —
  // unlike the server itself, doctor's job is to say which candidates still
  // work, and a bridge fronting X goes down with no notice.
  for (const bridge of bridges) {
    const url = buildBridgeUrl(bridge, username);
    try {
      const { value: items, ms } = await timed(async () => {
        // requestText(), not fetchWithTimeout() — a bridge fronting X can
        // answer the global fetch() with an empty 200 body; see src/http.js.
        const response = await requestText(url, { timeoutMs });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return parseFeed(response.text, url).slice(0, maxPosts);
      });
      if (!items.length) throw new Error('no items in feed — the bridge may be serving an empty page');
      report('alerts', url, true, `${items.length} posts in ${ms} ms`);
      for (const item of items.slice(0, 4)) {
        console.log(DIM(`        · ${(item.content ?? '').slice(0, 90)}`));
      }
    } catch (error) {
      report('alerts', url, false, error.message);
    }
  }
};

const main = async () => {
  const onlyKlosok = process.argv.includes('--klosok');
  console.log('Checking every upstream source this server depends on.\n');
  console.log(
    DIM('Vehicle sources come from VEHICLE_POSITION_URLS; alerts default to the'),
  );
  console.log(DIM('notice pages in ALERT_PAGE_URLS plus any ALERT_X_BRIDGE_URLS.'));
  console.log(DIM('the GTFS archive is discovered at runtime — see src/gtfs/catalogue.js.'));

  if (onlyKlosok) {
    await checkKlosok();
    console.log('\nSummary');
    const inGroup = results.filter((result) => result.group === 'klosok');
    const working = inGroup.filter((result) => result.ok);
    // Disabled is a clean skip, not a failure: the app works without these buses.
    if (!config.klosok.enabled) {
      console.log('  klosok: disabled — nothing to check');
      return;
    }
    console.log(
      `  ${working.length ? PASS : FAIL} klosok: ${working.length}/${inGroup.length} sources reachable`,
    );
    process.exitCode = working.length ? 0 : 1;
    return;
  }

  await checkGtfs();
  await checkVehicles();
  await checkOpenData();
  await checkKlosok();
  await checkAlerts();
  console.log('\nSummary');
  const groups = ['gtfs', 'vehicles', 'open-data', 'klosok', 'alerts'];
  let fatal = false;

  for (const group of groups) {
    const inGroup = results.filter((result) => result.group === group);
    const working = inGroup.filter((result) => result.ok);
    // Alerts and the supplementary Open Data source are nice-to-haves; the
    // other is what the map is made of. Kłosok (suburban buses) is optional —
    // the app works without it, so an outage must not fail the exit code.
    const required = group !== 'alerts' && group !== 'open-data' && group !== 'klosok';
    const ok = working.length > 0;
    if (required && !ok) fatal = true;

    const note = required
      ? ' — THIS BREAKS THE APP'
      : group === 'alerts'
        ? ' — alerts will be empty'
        : group === 'klosok'
          ? ' — Kłosok buses will be missing (MPK still works)'
          : ' — MPK source keeps the map working';

    console.log(
      `  ${ok ? PASS : FAIL} ${group}: ${working.length}/${inGroup.length} sources reachable` +
        (ok ? ` — using ${working[0].url}` : note),
    );
  }

  if (fatal) {
    console.log(
      '\nNo working source for required data.\n' +
        'If GTFS discovery found nothing, capture the real payload and fix the parser —\n' +
        'do not paper over it with GTFS_URLS, which pins you to one snapshot forever:\n' +
        `  curl -s ${config.gtfs.catalogueUrl} | head -c 2000`,
    );
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
