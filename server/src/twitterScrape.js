'use strict';

/**
 * Reads a public X/Twitter profile without an API key, two different ways.
 *
 * There is no free API path to a user's timeline — that has needed a paid tier
 * since 2023, which is the whole reason `/alerts` went silent for a year (see
 * CLAUDE.md). Both approaches below read public HTML instead. Both are
 * exactly as fragile as that sounds: X can change this markup, add a login
 * wall, or rate-limit the IP at any time, with no contract that any of it
 * keeps working. That is why this lives in its own module, why every failure
 * is caught by the caller and logged rather than allowed to touch the rest of
 * the alerts pipeline, and why `scripts/verify-twitter-scrape.js` exists as a
 * manual, non-test way to check either one against the real profile before
 * enabling it in production — this sandbox has no path to x.com, so neither
 * has been verified from here.
 *
 * `scrapePostsHttp` (`TWITTER_SCRAPE_MODE=http`, the default) is a plain
 * fetch of X's syndication/embed endpoint — the same server-rendered HTML
 * widgets.js falls back to for logged-out embeds, so it doesn't need a
 * browser at all. It is also the less-supported path: syndication.twitter.com
 * is not a documented public API, could be retired or reshaped without
 * notice, and this markup shape is reverse-engineered rather than confirmed
 * against a live response.
 *
 * `scrapePosts` (`TWITTER_SCRAPE_MODE=browser`) drives a real headless
 * Chromium instead, reading the same `schema.org/SocialMediaPosting` markup
 * the rendered page exposes. It needs a real Chromium binary on disk, which
 * `playwright-core` does not download for you (unlike the full `playwright`
 * package, whose automatic multi-hundred-MB download on every `npm install`
 * would be a surprising cost to impose on a deployment that never uses this
 * feature). Run this once, on the machine that will actually poll X:
 *
 *   npx --yes playwright install chromium
 *
 * Use this mode if the http mode's endpoint stops answering — a real browser
 * is more work to run but far more likely to keep working, since it renders
 * whatever the site actually serves rather than one specific undocumented URL.
 */

const { fetchWithTimeout } = require('./http');
const { stripHtml } = require('./html');

const POST_SELECTOR = 'article[itemtype="https://schema.org/SocialMediaPosting"]';

// Legacy "Embedded Timelines" markup: server-rendered, meant for a widget
// iframe rather than a logged-in session, structured as one
// <div class="timeline-Tweet ..."> per post.
const SYNDICATION_URL = (username) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(username)}?dnt=true&showReplies=false`;

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
 * Pull `{text, date, url}` triples out of a syndication timeline response.
 *
 * Kept separate from the fetch below, same reason as `normalizeScrapedPosts`:
 * this is the part with actual logic in it, and it can be tested against a
 * fixture string without a network call.
 *
 * @param {string} html
 * @param {number} limit
 * @returns {{ text: string, date: string|null, url: string|null }[]}
 */
const parseSyndicationHtml = (html, limit) => {
  // One chunk per tweet card. Split rather than a single regex over the whole
  // document because the cards are siblings, not nested inside one match.
  // The lookahead has to reject a following "-": a bare \b word boundary would
  // also match the "timeline-Tweet-body" div nested inside every card, which
  // over-splits each card into several empty pieces.
  const chunks = String(html ?? '').split(/<div class="timeline-Tweet(?![\w-])/).slice(1, limit + 1);

  return chunks.map((chunk) => {
    const textMatch = chunk.match(/class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const urlMatch = chunk.match(/class="[^"]*timeline-Tweet-timestamp[^"]*"[^>]*\shref="([^"]+)"/);
    const dateMatch = chunk.match(/<time[^>]*\sdatetime="([^"]+)"/);

    return {
      text: textMatch ? stripHtml(textMatch[1]) : '',
      url: urlMatch ? urlMatch[1] : null,
      date: dateMatch ? dateMatch[1] : null,
    };
  });
};

/**
 * Fetch the most recent public posts from the syndication/embed endpoint —
 * no browser, just a GET request.
 *
 * @param {{
 *   username: string,
 *   limit?: number,
 *   timeoutMs?: number,
 *   userAgent?: string,
 * }} options
 * @returns {Promise<{ text: string, url: string|null, timestamp: number }[]>}
 */
const scrapePostsHttp = async ({
  username,
  limit = 10,
  timeoutMs = 30_000,
  userAgent = DEFAULT_USER_AGENT,
} = {}) => {
  if (!username) throw new Error('scrapePostsHttp requires a username');

  const response = await fetchWithTimeout(SYNDICATION_URL(username), {
    timeoutMs,
    headers: { 'User-Agent': userAgent, 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' },
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} from the syndication endpoint — ` +
        'it may have moved or started requiring a token; try TWITTER_SCRAPE_MODE=browser instead',
    );
  }

  const rawPosts = parseSyndicationHtml(await response.text(), limit);

  if (!rawPosts.length) {
    throw new Error('no timeline-Tweet cards found — the syndication endpoint markup may have changed');
  }

  return normalizeScrapedPosts(rawPosts);
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

module.exports = {
  DEFAULT_USER_AGENT,
  POST_SELECTOR,
  SYNDICATION_URL,
  normalizeScrapedPosts,
  parseSyndicationHtml,
  scrapePosts,
  scrapePostsHttp,
};
