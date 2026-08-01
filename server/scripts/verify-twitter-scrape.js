#!/usr/bin/env node
'use strict';

/**
 * Manual, one-off check for the X/Twitter scrape provider.
 *
 * Deliberately not part of `npm test`: it needs a real Chromium binary on disk
 * and a real network path to x.com, neither of which the automated suite may
 * have (CI does not install a browser, and this sandbox cannot reach x.com at
 * all). Run this by hand, on the machine that will actually run the server,
 * before setting TWITTER_SCRAPE_ENABLED=true:
 *
 *   npx --yes playwright install chromium   # once, if not already installed
 *   npm run scrape:twitter
 */

const config = require('../src/config');
const { scrapePosts } = require('../src/twitterScrape');

const main = async () => {
  const { username, maxPosts, timeoutMs, headless, executablePath } = config.alerts.twitterScrape;
  const url = `https://x.com/${username}`;

  console.log(`Fetching up to ${maxPosts} posts from ${url} …`);
  const startedAt = Date.now();

  const posts = await scrapePosts({ url, limit: maxPosts, timeoutMs, headless, executablePath });

  console.log(`\nGot ${posts.length} post(s) in ${Date.now() - startedAt} ms.\n`);

  if (!posts.length) {
    console.log('Nothing came back. Either the account has no recent posts, or');
    console.log('the profile markup changed and src/twitterScrape.js needs adjusting.');
    return;
  }

  for (const [index, post] of posts.entries()) {
    console.log(`--- ${index + 1} ---`);
    console.log(`Data: ${new Date(post.timestamp).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`);
    console.log(post.text);
    console.log(`Link: ${post.url ?? '(none)'}`);
    console.log();
  }
};

main().catch((error) => {
  console.error('Scrape failed:', error.message);
  process.exitCode = 1;
});
