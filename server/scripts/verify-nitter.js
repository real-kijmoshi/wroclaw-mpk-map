#!/usr/bin/env node
'use strict';

/**
 * Manual, one-off check for the Nitter-based alerts source.
 *
 * Deliberately not part of `npm test`: it needs a real network path to a
 * public Nitter mirror, which this sandbox may not have. Run this by hand,
 * on the machine that will actually run the server, before trusting it in
 * production:
 *
 *   npm run scrape:nitter
 *
 * Tries every configured instance (NITTER_INSTANCE_URLS) in order and stops
 * at the first one that answers, same as the server itself does.
 */

const config = require('../src/config');
const { requestText } = require('../src/http');
const { parseFeed } = require('../src/alerts');

const main = async () => {
  const { instances, username, maxPosts, timeoutMs } = config.alerts.nitter;

  for (const instance of instances) {
    const url = `${instance.replace(/\/$/, '')}/${username}/rss`;
    console.log(`Fetching up to ${maxPosts} posts for @${username} from ${url} …`);
    const startedAt = Date.now();

    try {
      // requestText(), not the global fetch() — nitter.net answers fetch()
      // with an empty 200 body; see the doc comment on requestText in
      // src/http.js for how that was confirmed.
      const response = await requestText(url, { timeoutMs });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const items = parseFeed(response.text, url).slice(0, maxPosts);

      console.log(`\nGot ${items.length} post(s) in ${Date.now() - startedAt} ms.\n`);

      if (!items.length) {
        console.log('Nothing came back — the instance may be serving an empty or broken feed.');
        continue;
      }

      for (const [index, item] of items.entries()) {
        console.log(`--- ${index + 1} ---`);
        console.log(`Data: ${new Date(item.timestamp).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`);
        console.log(item.content);
        console.log(`Link: ${item.url ?? '(none)'}`);
        console.log();
      }
      return;
    } catch (error) {
      console.error(`${instance} failed: ${error.message}\n`);
    }
  }

  console.error('No configured Nitter instance answered — add another via NITTER_INSTANCE_URLS.');
  process.exitCode = 1;
};

main().catch((error) => {
  console.error('Scrape failed:', error.message);
  process.exitCode = 1;
});
