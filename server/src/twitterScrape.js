'use strict';

/**
 * Reads a public X/Twitter profile with a headless browser.
 *
 * There is no free API path to a user's timeline — that has needed a paid tier
 * since 2023, which is the whole reason `/alerts` went silent for a year (see
 * CLAUDE.md). This reads the same public HTML a logged-out visitor sees
 * instead. It is exactly as fragile as that sounds: X can change this markup,
 * add a login wall, or rate-limit the IP at any time, with no contract that any
 * of it keeps working. That is why this lives in its own module, is off by
 * default (`TWITTER_SCRAPE_ENABLED`), and every failure is caught by the caller
 * and logged rather than allowed to touch the rest of the alerts pipeline.
 *
 * It also needs a real Chromium binary on disk, which `playwright-core` does
 * not download for you (unlike the full `playwright` package, whose automatic
 * multi-hundred-MB download on every `npm install` would be a surprising cost
 * to impose on a deployment that never uses this feature). Run this once,
 * on the machine that will actually poll X:
 *
 *   npx --yes playwright install chromium
 *
 * `scripts/verify-twitter-scrape.js` is a manual, non-test way to check this
 * actually works against the real profile before enabling it in production.
 */

const POST_SELECTOR = 'article[itemtype="https://schema.org/SocialMediaPosting"]';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Turn the browser's raw `{text, date, url}` triples into alert-shaped posts.
 *
 * Kept as a pure function, separate from the Playwright orchestration below,
 * specifically so it can be unit tested without a browser or network — the
 * automated suite has neither, per CLAUDE.md.
 *
 * @param {{ text: string, date: string|null, url: string|null }[]} rawPosts
 * @returns {{ text: string, url: string|null, timestamp: number }[]}
 */
const normalizeScrapedPosts = (rawPosts) => {
  if (!Array.isArray(rawPosts)) return [];

  return rawPosts
    .map((post) => ({
      text: String(post?.text ?? '').trim(),
      url: post?.url ?? null,
      timestamp: post?.date ? Date.parse(post.date) : Number.NaN,
    }))
    // A retweet-only or media-only post can have no text at all; nothing to
    // show means nothing worth returning.
    .filter((post) => post.text.length > 0)
    .map((post) => ({ ...post, timestamp: Number.isFinite(post.timestamp) ? post.timestamp : Date.now() }));
};

/**
 * Fetch the most recent public posts from a profile page.
 *
 * @param {{
 *   url: string,
 *   limit?: number,
 *   timeoutMs?: number,
 *   headless?: boolean,
 *   userAgent?: string,
 *   executablePath?: string,
 * }} options
 * @returns {Promise<{ text: string, url: string|null, timestamp: number }[]>}
 */
const scrapePosts = async ({
  url,
  limit = 10,
  timeoutMs = 30_000,
  headless = true,
  userAgent = DEFAULT_USER_AGENT,
  // Points at a Chromium already on disk (a distro package, or a browser
  // fetched by a differently-pinned Playwright version) instead of the one
  // `playwright-core` expects at its own managed path.
  executablePath = process.env.TWITTER_SCRAPE_EXECUTABLE_PATH || undefined,
} = {}) => {
  if (!url) throw new Error('scrapePosts requires a profile url');

  // Required lazily: a server that never enables this feature never pays the
  // cost of loading it, and a missing/broken install fails only this one
  // provider rather than the whole process.
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (error) {
    throw new Error(`playwright-core is not installed (${error.message})`);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless, executablePath });
  } catch (error) {
    throw new Error(
      `could not launch Chromium — run "npx --yes playwright install chromium" on this machine, ` +
        `or set TWITTER_SCRAPE_EXECUTABLE_PATH to an existing install (${error.message})`,
    );
  }

  try {
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector(POST_SELECTOR, { timeout: timeoutMs });

    // The timeline only renders what has scrolled into view. Keep scrolling
    // until enough posts are loaded or a scroll produces nothing new — that
    // second condition is what stops this looping forever behind a login wall
    // that caps how much a logged-out visitor ever gets to see.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const count = await page.locator(POST_SELECTOR).count();
      if (count >= limit) break;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);

      if ((await page.locator(POST_SELECTOR).count()) === count) break;
    }

    const rawPosts = await page.locator(POST_SELECTOR).evaluateAll(
      (articles, max) =>
        articles.slice(0, max).map((article) => ({
          text: article.querySelector('meta[itemprop="articleBody"]')?.getAttribute('content') ?? '',
          date: article.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') ?? null,
          url: article.querySelector('meta[itemprop="url"]')?.getAttribute('content') ?? null,
        })),
      limit,
    );

    return normalizeScrapedPosts(rawPosts);
  } finally {
    await browser.close();
  }
};

module.exports = { DEFAULT_USER_AGENT, POST_SELECTOR, normalizeScrapedPosts, scrapePosts };
