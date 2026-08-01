'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { normalizeScrapedPosts, parseSyndicationHtml, scrapePosts, scrapePostsHttp } = require('../src/twitterScrape');

/**
 * `normalizeScrapedPosts` is deliberately a pure function, separate from the
 * Playwright orchestration in `scrapePosts`, so the logic that matters can be
 * tested without a browser or a network — neither of which this suite has.
 * The browser-driving half is checked by hand with
 * `npm run scrape:twitter`, not here.
 */
describe('normalizeScrapedPosts', () => {
  it('parses a valid ISO date into a timestamp', () => {
    const [post] = normalizeScrapedPosts([
      { text: 'Linia 4 objazdem', date: '2026-07-31T12:00:00.000Z', url: 'https://x.com/AlertMPK/status/1' },
    ]);
    assert.equal(post.timestamp, Date.parse('2026-07-31T12:00:00.000Z'));
    assert.equal(post.url, 'https://x.com/AlertMPK/status/1');
  });

  it('drops posts with no text — a retweet or media-only post', () => {
    assert.deepEqual(normalizeScrapedPosts([{ text: '', date: null, url: 'https://x.com/x/status/1' }]), []);
    assert.deepEqual(normalizeScrapedPosts([{ text: '   ', date: null, url: null }]), []);
  });

  it('falls back to now when the date is missing or unparseable', () => {
    const before = Date.now();
    const [post] = normalizeScrapedPosts([{ text: 'Uwaga, objazd', date: 'not a date', url: null }]);
    assert.ok(post.timestamp >= before);
  });

  it('trims surrounding whitespace from the post text', () => {
    const [post] = normalizeScrapedPosts([{ text: '  Linia 17 opóźniona  ', date: null, url: null }]);
    assert.equal(post.text, 'Linia 17 opóźniona');
  });

  it('tolerates junk input', () => {
    assert.deepEqual(normalizeScrapedPosts(null), []);
    assert.deepEqual(normalizeScrapedPosts(undefined), []);
    assert.deepEqual(normalizeScrapedPosts([null, undefined, {}]), []);
  });
});

describe('scrapePosts input validation', () => {
  it('rejects a missing url before touching a browser', async () => {
    await assert.rejects(() => scrapePosts({}), /requires a profile url/);
  });
});

describe('scrapePostsHttp input validation', () => {
  it('rejects a missing username before touching the network', async () => {
    await assert.rejects(() => scrapePostsHttp({}), /requires a username/);
  });
});

/**
 * `parseSyndicationHtml` is the part of the http-mode scraper with actual
 * logic in it, kept separate from the fetch call for the same reason as
 * `normalizeScrapedPosts` — testable against a fixture string, no network.
 * The fixture below matches X's legacy "Embedded Timelines" markup
 * (syndication.twitter.com), which is what scripts/verify-twitter-scrape.js
 * checks against the real endpoint — this suite can't, per CLAUDE.md.
 */
describe('parseSyndicationHtml', () => {
  const tweetCard = ({ text, datetime, href }) => `
    <div class="timeline-Tweet" data-tweet-id="1">
      <div class="timeline-Tweet-body">
        <p class="timeline-Tweet-text" lang="pl" dir="ltr">${text}</p>
      </div>
      <a class="timeline-Tweet-timestamp" href="${href}">
        <time datetime="${datetime}">1 min</time>
      </a>
    </div>`;

  it('extracts text, url and date from each tweet card', () => {
    const html = [
      tweetCard({
        text: '🚨 Linia 4: objazd przez Świdnicką od godz. 22:00.',
        datetime: '2026-07-31T10:15:00.000Z',
        href: 'https://twitter.com/AlertMPK/status/1001',
      }),
      tweetCard({
        text: 'Linia 17 kursuje z opóźnieniami.',
        datetime: '2026-07-31T08:00:00.000Z',
        href: 'https://twitter.com/AlertMPK/status/1000',
      }),
    ].join('\n');

    const posts = parseSyndicationHtml(html, 10);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].text, '🚨 Linia 4: objazd przez Świdnicką od godz. 22:00.');
    assert.equal(posts[0].url, 'https://twitter.com/AlertMPK/status/1001');
    assert.equal(posts[0].date, '2026-07-31T10:15:00.000Z');
    assert.equal(posts[1].text, 'Linia 17 kursuje z opóźnieniami.');
  });

  it('respects the limit and does not read past it', () => {
    const html = Array.from({ length: 5 }, (_, i) =>
      tweetCard({ text: `Post ${i}`, datetime: '2026-07-31T08:00:00.000Z', href: `https://x.com/a/status/${i}` }),
    ).join('\n');

    assert.equal(parseSyndicationHtml(html, 2).length, 2);
  });

  it('returns an empty text for a card missing the text paragraph', () => {
    const html = `
      <div class="timeline-Tweet" data-tweet-id="1">
        <a class="timeline-Tweet-timestamp" href="https://x.com/a/status/1">
          <time datetime="2026-07-31T08:00:00.000Z">1 min</time>
        </a>
      </div>`;

    const [post] = parseSyndicationHtml(html, 10);
    assert.equal(post.text, '');
    assert.equal(post.url, 'https://x.com/a/status/1');
  });

  it('tolerates markup with no tweet cards at all', () => {
    assert.deepEqual(parseSyndicationHtml('<html><body>nothing here</body></html>', 10), []);
    assert.deepEqual(parseSyndicationHtml('', 10), []);
    assert.deepEqual(parseSyndicationHtml(undefined, 10), []);
  });
});
