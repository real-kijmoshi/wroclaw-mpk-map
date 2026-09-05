#!/usr/bin/env node
'use strict';

/**
 * Manual, one-off check for the configured alerts sources.
 *
 * Deliberately not part of `npm test`: it needs a real network path to the
 * city's notice page (and to an RSS bridge, if one is configured), which
 * this sandbox may not have. Run this by hand, on the machine that will
 * actually run the server, before trusting it in production:
 *
 *   npm run scrape:alerts
 *
 * Prints the headlines each source yields, because the failure that matters
 * here is a source that answers happily with the wrong kind of content — a
 * page of press releases reads as a notice list right up until "MPK kupuje
 * nowe tramwaje" shows up as a service alert.
 */

const config = require('../src/config');
const { fetchWithTimeout, requestText } = require('../src/http');
const { buildBridgeUrl, parseFeed, parsePage } = require('../src/alerts');

const printItems = (items) => {
  for (const [index, item] of items.entries()) {
    console.log(`--- ${index + 1} ---`);
    console.log(
      `Data: ${new Date(item.timestamp).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`,
    );
    if (item.title) console.log(item.title);
    console.log(item.content);
    console.log(`Link: ${item.url ?? '(none)'}`);
    console.log();
  }
};

/** The default source: a notice page, read as a feed if it offers one. */
const checkPages = async () => {
  const { pages, timeoutMs } = config.alerts;

  if (!pages.length) {
    console.log('No notice page configured — set ALERT_PAGE_URLS.\n');
    return false;
  }

  let any = false;
  for (const url of pages) {
    console.log(`Fetching notices from ${url} …`);
    const startedAt = Date.now();

    try {
      const response = await fetchWithTimeout(url, { timeoutMs });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const body = await response.text();
      const feed = parseFeed(body, url);
      const how = feed.length ? 'feed' : 'scrape';
      const items = feed.length ? feed : parsePage(body, url);

      console.log(`\nGot ${items.length} notice(s) by ${how} in ${Date.now() - startedAt} ms.\n`);
      if (!items.length) {
        console.log('Nothing came back — the page markup or feed shape probably changed.\n');
        continue;
      }

      printItems(items.slice(0, 10));
      console.log('(these should read as disruptions, not announcements)\n');
      any = true;
    } catch (error) {
      console.error(`${url} failed: ${error.message}\n`);
    }
  }
  return any;
};

/** The optional extra source: @AlertMPK through whatever bridge is configured. */
const checkBridges = async () => {
  const { enabled, bridges, username, maxPosts, timeoutMs } = config.alerts.xBridge;

  if (!enabled || !bridges.length) {
    console.log(`No RSS bridge configured for @${username} — set ALERT_X_BRIDGE_URLS to add one.`);
    return false;
  }

  // Tries every configured bridge in order and stops at the first that
  // answers, same as the server itself does.
  for (const bridge of bridges) {
    const url = buildBridgeUrl(bridge, username);
    console.log(`Fetching up to ${maxPosts} posts for @${username} from ${url} …`);
    const startedAt = Date.now();

    try {
      // requestText(), not fetchWithTimeout() — a bridge fronting X can
      // answer fetch() with an empty 200 body; see the doc comment on
      // requestText in src/http.js for how that was confirmed.
      const response = await requestText(url, { timeoutMs });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const items = parseFeed(response.text, url).slice(0, maxPosts);

      console.log(`\nGot ${items.length} post(s) in ${Date.now() - startedAt} ms.\n`);

      if (!items.length) {
        console.log('Nothing came back — the bridge may be serving an empty or broken feed.\n');
        continue;
      }

      printItems(items);
      return true;
    } catch (error) {
      console.error(`${bridge} failed: ${error.message}\n`);
    }
  }

  console.error('No configured bridge answered — add another via ALERT_X_BRIDGE_URLS.');
  return false;
};

const main = async () => {
  const pagesOk = await checkPages();
  const bridgeOk = await checkBridges();

  // A deploy where nothing answers gets zero alerts until someone notices,
  // so this exits non-zero rather than printing a wall of failures and
  // succeeding.
  if (!pagesOk && !bridgeOk) {
    console.error('\nNo alerts source answered.');
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error('Scrape failed:', error.message);
  process.exitCode = 1;
});
