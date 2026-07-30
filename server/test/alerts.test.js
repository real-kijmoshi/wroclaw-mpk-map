'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { extractAffectedLines, parseFeed, stripHtml } = require('../src/alerts');

const KNOWN = new Set(['4', '10', '17', '128', '240', 'A', 'N']);

describe('extractAffectedLines', () => {
  it('finds line numbers that exist in the timetable', () => {
    const text = 'Uwaga! Linie 4, 10 i 17 jadą objazdem.';
    assert.deepEqual(extractAffectedLines(text, KNOWN).sort(), ['10', '17', '4']);
  });

  it('ignores numbers that are not lines', () => {
    // The old implementation matched every number, so dates and times all
    // became "affected lines".
    const text = 'W dniu 2026-06-15 od godz. 22:00 do 05:30 linia 128 nie kursuje.';
    assert.deepEqual(extractAffectedLines(text, KNOWN), ['128']);
  });

  it('only treats a bare letter as a line when the context is transport', () => {
    assert.deepEqual(extractAffectedLines('Autobus linii A pojedzie inaczej', KNOWN), ['A']);
    assert.deepEqual(extractAffectedLines('Wariant A remontu ulicy', KNOWN), []);
  });

  it('returns nothing without a known-line set', () => {
    assert.deepEqual(extractAffectedLines('linia 4', new Set()), []);
    assert.deepEqual(extractAffectedLines('', KNOWN), []);
    assert.deepEqual(extractAffectedLines(null, KNOWN), []);
  });

  it('does not report the same line twice', () => {
    assert.deepEqual(extractAffectedLines('Linia 4 oraz linia 4 wracają', KNOWN), ['4']);
  });
});

describe('parseFeed', () => {
  it('reads RSS 2.0 items', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>MPK</title>
        <item>
          <title>Objazd linii 4</title>
          <description>&lt;p&gt;Tramwaje &lt;b&gt;4&lt;/b&gt; jadą objazdem.&lt;/p&gt;</description>
          <link>https://example.org/a</link>
          <pubDate>Mon, 15 Jun 2026 08:00:00 +0200</pubDate>
        </item>
      </channel></rss>`;

    const [item] = parseFeed(xml, 'https://example.org/rss');
    assert.equal(item.title, 'Objazd linii 4');
    assert.equal(item.content, 'Tramwaje 4 jadą objazdem.', 'HTML markup is stripped');
    assert.equal(item.url, 'https://example.org/a');
    assert.equal(item.timestamp, Date.parse('Mon, 15 Jun 2026 08:00:00 +0200'));
  });

  it('reads Atom entries', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>urn:1</id>
          <title>Awaria</title>
          <summary>Linia 128 skrócona.</summary>
          <link href="https://example.org/b"/>
          <updated>2026-06-15T06:00:00Z</updated>
        </entry>
      </feed>`;

    const [item] = parseFeed(xml, 'https://example.org/atom');
    assert.equal(item.title, 'Awaria');
    assert.equal(item.url, 'https://example.org/b');
    assert.equal(item.timestamp, Date.parse('2026-06-15T06:00:00Z'));
  });

  it('returns an empty list for documents that are not feeds', () => {
    assert.deepEqual(parseFeed('<html><body>nope</body></html>', 'x'), []);
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    assert.equal(stripHtml('<p>a &amp; b</p>'), 'a & b');
    assert.equal(stripHtml(undefined), '');
  });
});
