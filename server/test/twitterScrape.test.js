'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { normalizeScrapedPosts, scrapePosts } = require('../src/twitterScrape');

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
