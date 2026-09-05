'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const config = require('../src/config');
const {
  AlertsService,
  XBridgeProvider,
  buildBridgeUrl,
  extractAffectedLines,
  fingerprint,
  normalizeText,
  parseFeed,
  parsePage,
  stripHtml,
  toXPostUrl,
} = require('../src/alerts');

const KNOWN = new Set(['4', '10', '17', '128', '240', 'A', 'N']);

describe('extractAffectedLines', () => {
  it('does not mistake a day-of-month for a real line with the same number', () => {
    // Wrocław has real lines 1, 6 and 21 — these are dates, not references to
    // them. Observed live: "21.07.2026" and "6 lipca" produced phantom badges
    // for lines 21 and 6 on notices that were correctly about other lines.
    assert.deepEqual(extractAffectedLines('Od 1 sierpnia zmiana tras tramwajów', KNOWN), []);
    assert.deepEqual(
      extractAffectedLines('Kłokoczyce: od 6 lipca zmiany w kursowaniu autobusów', KNOWN),
      [],
    );
    assert.deepEqual(
      extractAffectedLines('Od 25 lipca zmiana lokalizacji przystanku 21.07.2026', KNOWN),
      [],
    );
  });

  it('does not mistake the opening day of a date range for a real line', () => {
    // Observed live: "(11 - 16 lipca)" produced a phantom line 11 badge on a
    // notice about a crane installation, not tram line 11 — the single-day
    // stripper caught "16 lipca" but left the range's opening "11" behind.
    const known = new Set([...KNOWN, '11']);
    assert.deepEqual(
      extractAffectedLines(
        'Zmiany rozkładu jazdy autobusów i tramwajów (11 - 16 lipca)',
        known,
      ),
      [],
    );
    assert.deepEqual(
      extractAffectedLines('Utrudnienia od 11 do 16 lipca na trasie objazdu', known),
      [],
    );
  });

  it('still finds a real line mentioned next to an unrelated date', () => {
    assert.deepEqual(
      extractAffectedLines('Linia 4 pojedzie objazdem od 25.07.2026', KNOWN).sort(),
      ['4'],
    );
  });

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

describe('parseFeed against a real X-bridge RSS response', () => {
  // Captured live from https://nitter.net/AlertMPK/rss, back when Nitter was
  // the bridge. Nitter is gone but the fixture is not stale: this is the
  // shape any bridge republishing an X profile emits (attributed <guid>,
  // CDATA description with an <a> wrapping the #AlertMPK hashtag), and that
  // shape is what broke the old syndication.twitter.com scraper's ad-hoc
  // regex parsing — exactly the kind of markup parseFeed() has to keep
  // tolerating.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
      <channel>
        <title>MPK Wrocław / @AlertMPK</title>
        <link>https://nitter.net/AlertMPK</link>
        <item>
          <title>#AlertMPK ul. Reymonta/Kleczkowska - ruch przywrócony.</title>
          <dc:creator>@AlertMPK</dc:creator>
          <description><![CDATA[<p><a href="https://nitter.net/search?f=tweets&q=%23AlertMPK">#AlertMPK</a> ul. Reymonta/Kleczkowska - ruch przywrócony.</p>]]></description>
          <pubDate>Thu, 06 Aug 2026 09:11:21 GMT</pubDate>
          <guid isPermaLink="false">2085292635451724015</guid>
          <link>https://nitter.net/AlertMPK/status/2085292635451724015#m</link>
        </item>
      </channel>
    </rss>`;

  it('reads the numeric guid rather than its isPermaLink attribute', () => {
    const [item] = parseFeed(xml, 'https://nitter.net/AlertMPK/rss');
    assert.equal(item.id, '2085292635451724015');
  });

  it('strips the link markup out of the CDATA description', () => {
    const [item] = parseFeed(xml, 'https://nitter.net/AlertMPK/rss');
    assert.equal(item.content, '#AlertMPK ul. Reymonta/Kleczkowska - ruch przywrócony.');
  });

  it('reads the permalink and publish date', () => {
    const [item] = parseFeed(xml, 'https://nitter.net/AlertMPK/rss');
    assert.equal(item.url, 'https://nitter.net/AlertMPK/status/2085292635451724015#m');
    assert.equal(item.timestamp, Date.parse('Thu, 06 Aug 2026 09:11:21 GMT'));
  });
});

describe('toXPostUrl', () => {
  it('rewrites a bridge permalink to the equivalent x.com one', () => {
    assert.equal(
      toXPostUrl('https://nitter.net/AlertMPK/status/2085292635451724015#m'),
      'https://x.com/AlertMPK/status/2085292635451724015',
    );
  });

  it('works no matter which bridge served the feed', () => {
    assert.equal(
      toXPostUrl('https://nitter.example.org/AlertMPK/status/1'),
      'https://x.com/AlertMPK/status/1',
    );
  });

  it('tolerates junk input', () => {
    assert.equal(toXPostUrl(null), null);
    assert.equal(toXPostUrl(undefined), null);
    assert.equal(toXPostUrl('not a url'), 'not a url');
  });
});

describe('buildBridgeUrl', () => {
  it('substitutes the username into a templated bridge URL', () => {
    assert.equal(
      buildBridgeUrl('https://rsshub.example.com/twitter/user/{username}', 'AlertMPK'),
      'https://rsshub.example.com/twitter/user/AlertMPK',
    );
  });

  it('falls back to the Nitter path shape for a bare base URL', () => {
    // Nitter's public mirrors are gone, but a private one is still a valid
    // bridge — an operator who has one should not have to rewrite its URL.
    assert.equal(
      buildBridgeUrl('https://mirror.example.org/', 'AlertMPK'),
      'https://mirror.example.org/AlertMPK/rss',
    );
  });

  it('escapes a username that is not URL-safe', () => {
    assert.equal(
      buildBridgeUrl('https://bridge.example.com/user/{username}', 'a b'),
      'https://bridge.example.com/user/a%20b',
    );
  });
});

describe('XBridgeProvider', () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title>#AlertMPK Objazd linii 4</title>
        <description>#AlertMPK Objazd linii 4</description>
        <guid isPermaLink="false">42</guid>
        <link>https://bridge.example.com/AlertMPK/status/42#m</link>
        <pubDate>Thu, 06 Aug 2026 09:11:21 GMT</pubDate>
      </item>
    </channel></rss>`;

  const ok = (text) => ({ ok: true, status: 200, statusText: 'OK', text });

  // The HTTP reader is injected (see XBridgeProvider's constructor) so bridge
  // failover is exercised without a socket — the suite runs with no network.
  const provider = (bridges, request = () => ok(rss)) =>
    new XBridgeProvider({ username: 'AlertMPK', bridges, maxPosts: 10, timeoutMs: 50, request });

  it('names itself after the account, not the software behind the bridge', () => {
    assert.equal(provider(['https://bridge.example.com/user/{username}']).name, 'x-bridge:@AlertMPK');
  });

  it('throws a useful error when no bridge is configured', async () => {
    await assert.rejects(() => provider([]).fetch(), /no RSS bridge configured/);
  });

  it('reads posts and rewrites their links to x.com', async () => {
    const seen = [];
    const items = await provider(['https://bridge.example.com/user/{username}'], (url) => {
      seen.push(url);
      return ok(rss);
    }).fetch();

    assert.deepEqual(seen, ['https://bridge.example.com/user/AlertMPK']);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://x.com/AlertMPK/status/42');
    assert.equal(items[0].content, '#AlertMPK Objazd linii 4');
    // The account posts nothing but alerts, so a post carries no headline of
    // its own — the content is the alert.
    assert.equal(items[0].title, null);
  });

  it('falls through to the next bridge when the first one is down', async () => {
    const seen = [];
    const items = await provider(
      ['https://dead.example.com/user/{username}', 'https://alive.example.com/user/{username}'],
      (url) => {
        seen.push(url);
        if (url.includes('dead')) return { ok: false, status: 502, statusText: 'Bad Gateway', text: '' };
        return ok(rss);
      },
    ).fetch();

    assert.equal(seen.length, 2, 'both bridges tried, in order');
    assert.equal(items.length, 1);
  });

  it('treats an empty feed as a failure, not as zero alerts', async () => {
    // A discontinued bridge answers 200 with an empty channel rather than an
    // error — that is how the Nitter source went silent with nothing in
    // /health saying so. It has to read as a failed provider, so the previous
    // list is kept and `lastError` explains the staleness.
    await assert.rejects(
      () =>
        provider(['https://empty.example.com/user/{username}'], () =>
          ok('<rss version="2.0"><channel/></rss>'),
        ).fetch(),
      /no items in feed/,
    );
  });
});

describe('default alerts configuration', () => {
  it('ships a source that answers out of the box', () => {
    // The Nitter source was the only default one, and when Nitter was
    // discontinued a stock deploy had no alerts source at all — /alerts just
    // stayed empty, which is the same silent failure the paid X API caused
    // before it. A default page is what keeps that from repeating.
    assert.ok(config.alerts.pages.length, 'at least one notice page is configured by default');
  });

  it('configures no X bridge by default', () => {
    // Pointing the stock deploy at someone else's public bridge is how this
    // broke the first time; a bridge is something an operator opts into.
    assert.deepEqual(config.alerts.xBridge.bridges, []);
  });
});

describe('parsePage', () => {
  // MPK publishes disruptions as web pages only; there is no API.
  const html = `
    <html><body>
      <nav><a href="/">Strona główna</a><a href="/kontakt">Kontakt</a></nav>
      <main>
        <ul>
          <li>
            <a href="/komunikacja/objazd-linii-4">Objazd linii 4 i 10 od 15.06.2026</a>
            <span>15.06.2026</span>
          </li>
          <li><a href="/komunikacja/awaria">Awaria tramwaju na Świdnickiej</a></li>
          <li><a href="#">Zobacz wszystkie</a></li>
          <li><a href="/o-nas">Krótko</a></li>
        </ul>
      </main>
    </body></html>`;

  it('finds notices and resolves relative links', () => {
    const items = parsePage(html, 'https://www.wroclaw.pl/komunikacja/zmiany-w-komunikacji');
    assert.deepEqual(
      // The trailing publish date (and its "od"/"z dnia" connector) is
      // stripped from the title; it is already surfaced as a relative age.
      items.map((item) => item.title),
      ['Objazd linii 4 i 10', 'Awaria tramwaju na Świdnickiej'],
    );
    assert.equal(items[0].url, 'https://www.wroclaw.pl/komunikacja/objazd-linii-4');
  });

  it('reads the publication date printed next to the headline', () => {
    const [first] = parsePage(html, 'https://www.wroclaw.pl/');
    assert.equal(new Date(first.timestamp).toISOString().slice(0, 10), '2026-06-15');
  });

  it('skips navigation, anchors and text too short to be a headline', () => {
    const titles = parsePage(html, 'https://www.wroclaw.pl/').map((item) => item.title);
    assert.ok(!titles.includes('Strona główna'));
    assert.ok(!titles.includes('Zobacz wszystkie'));
    assert.ok(!titles.includes('Krótko'));
  });

  it('picks up the lead paragraph as the body', () => {
    // Shaped like the wroclaw.pl notice list: headline link, then a lead.
    const withLead = `
      <article>
        <a href="/komunikacja/trzebnicka">Zmiana organizacji ruchu na Trzebnickiej</a>
        <p>Od 25.07.2026 ulica Trzebnicka jest jednokierunkowa. Dotyczy linii 108, 111 i 132.</p>
      </article>`;

    const [item] = parsePage(withLead, 'https://www.wroclaw.pl/');
    assert.equal(item.title, 'Zmiana organizacji ruchu na Trzebnickiej');
    assert.match(item.content, /jednokierunkowa/);
    assert.equal(new Date(item.timestamp).toISOString().slice(0, 10), '2026-07-25');
  });

  it('does not use the next headline as this one\'s description', () => {
    // Long enough to pass a naive length check, so the link stripping is what
    // has to catch it.
    const list = `
      <ul>
        <li><a href="/a">Objazd linii 4 od poniedziałku</a></li>
        <li><a href="/b">Awaria tramwaju na Świdnickiej wstrzymuje ruch w obu kierunkach</a></li>
      </ul>`;
    const [first] = parsePage(list, 'https://x.pl/');
    assert.equal(first.content, first.title, 'the next headline is not a description');
  });

  it('stops a notice body at the start of the next notice', () => {
    const two = `
      <article>
        <a href="/a">Zmiana organizacji ruchu na ulicy Trzebnickiej</a>
        <p>Od 25.07.2026 ulica Trzebnicka jest jednokierunkowa. Dotyczy linii 128.</p>
      </article>
      <article>
        <a href="/b">Od 1 sierpnia zmiana tras tramwajów</a>
        <p>Tramwaje linii 4 pojadą objazdem przez Świdnicką.</p>
      </article>`;

    const [first] = parsePage(two, 'https://x.pl/');
    assert.match(first.content, /Trzebnicka jest jednokierunkowa/);
    assert.doesNotMatch(first.content, /Świdnick/, 'the next notice must not bleed in');
  });

  it('rejects corporate news, which is what a company news page is full of', () => {
    // mpk.wroc.pl/o-mpk/aktualnosci is press releases, not disruptions. Every
    // one of these mentions trams or buses; none of them is an alert.
    const news = `
      <ul>
        <li><a href="/1">MPK Wrocław kupuje nowe tramwaje Moderus Gamma</a></li>
        <li><a href="/2">Autobusy elektryczne wyjadą na ulice Wrocławia</a></li>
        <li><a href="/3">Dzień otwarty w zajezdni tramwajowej Borek</a></li>
        <li><a href="/4">Nowa linia autobusowa połączy Psie Pole z centrum</a></li>
      </ul>`;
    assert.deepEqual(parsePage(news, 'https://mpk.wroc.pl/o-mpk/aktualnosci'), []);
  });

  it('still accepts real disruption headlines', () => {
    const real = `
      <ul>
        <li><a href="/a">Objazd linii 4 i 10 od poniedziałku</a></li>
        <li><a href="/b">Zmiana trasy autobusów 128 i 240</a></li>
        <li><a href="/c">Awaria tramwaju wstrzymała ruch na Świdnickiej</a></li>
        <li><a href="/d">Linia 17 nie kursuje do odwołania</a></li>
      </ul>`;
    assert.equal(parsePage(real, 'https://www.wroclaw.pl/').length, 4);
  });

  it('ignores roadworks that mention no transport anywhere', () => {
    const roadworks =
      '<a href="/x">Remont nawierzchni na ulicy Legnickiej</a><p>Prace potrwają do jesieni.</p>';
    assert.deepEqual(parsePage(roadworks, 'https://x.pl/'), []);
  });

  it('keeps a disruption whose lines are only named in the body', () => {
    // The headline says nothing about transport; the lead does.
    const notice = `
      <a href="/x">Zmiana organizacji ruchu na ulicy Trzebnickiej</a>
      <p>Od 25.07.2026 zmiany obejmą linie 128 oraz 240 w obu kierunkach.</p>`;
    const [item] = parsePage(notice, 'https://www.wroclaw.pl/');
    assert.equal(item.title, 'Zmiana organizacji ruchu na ulicy Trzebnickiej');
  });

  it('returns nothing rather than guessing on unrelated markup', () => {
    assert.deepEqual(parsePage('<html><body><a href="/x">Sklep firmowy</a></body></html>', 'https://x.pl'), []);
    assert.deepEqual(parsePage('', 'https://x.pl'), []);
    assert.deepEqual(parsePage(null, 'https://x.pl'), []);
  });
});

describe('parsePage against real page markup', () => {
  // Wrocław's notice page is built with Tilda, which wraps each photo tile in
  // an anchor that itself contains a <style> block for responsive images —
  // observed live as raw CSS leaking into a notice's title.
  const tildaTile = (href, title, dateSuffix) => `
    <a href="${href}" class="t-tilesWithPhoto__link">
      <style>
        @media screen and (max-width: 767px) { .t-tilesWithPhoto.t-template .boxWithImg img { min-height: 250px; } }
      </style>
      <img src="/photo.jpg">
      <div class="t-tilesWithPhoto__title">${title} ${dateSuffix}</div>
    </a>`;

  const page = `
    <a href="https://www.wroclaw.pl/komunikacja/zmiany-w-komunikacji">Zmiany w komunikacji</a>
    ${tildaTile('/a', 'Ludzkie szczątki na Traugutta. Od 1 sierpnia zmiana tras tramwajów', '30.07.2026')}
    ${tildaTile('/b', 'Zmiana nazwy przystanku „pl. Staszica”', '27.07.2026')}
    ${tildaTile('/c', 'Od 25 lipca zmiana lokalizacji przystanku "Kromera (Czajkowskiego)"', '21.07.2026')}
    ${tildaTile('/d', 'Kłokoczyce: od 6 lipca zmiany w kursowaniu autobusów', '02.07.2026')}`;

  it('drops the page\'s own self-link rather than reporting it as a notice', () => {
    const items = parsePage(page, 'https://www.wroclaw.pl/komunikacja/zmiany-w-komunikacji');
    assert.ok(
      !items.some((item) => item.title === 'Zmiany w komunikacji'),
      'the page heading linking to itself is not a distinct notice',
    );
  });

  it('never leaks the Tilda tile stylesheet into a title or body', () => {
    const items = parsePage(page, 'https://www.wroclaw.pl/komunikacja/zmiany-w-komunikacji');
    assert.equal(items.length, 4);
    for (const item of items) {
      assert.doesNotMatch(item.title, /@media|t-tilesWithPhoto|min-height/);
      assert.doesNotMatch(item.content, /@media|t-tilesWithPhoto|min-height/);
    }
  });

  it('strips the trailing publish date off the displayed title', () => {
    const [first] = parsePage(page, 'https://www.wroclaw.pl/komunikacja/zmiany-w-komunikacji');
    assert.equal(
      first.title,
      'Ludzkie szczątki na Traugutta. Od 1 sierpnia zmiana tras tramwajów',
    );
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    assert.equal(stripHtml('<p>a &amp; b</p>'), 'a & b');
    assert.equal(stripHtml(undefined), '');
  });

  it('removes a <style> block along with its content, not just its tags', () => {
    const withStyle = '<style>@media (max-width: 767px) { .x { color: red; } }</style>Real text';
    assert.equal(stripHtml(withStyle), 'Real text');
  });

  it('removes a <script> block along with its content', () => {
    assert.equal(stripHtml('<script>alert(1)</script>Real text'), 'Real text');
  });
});

const LONG_TEXT = 'Tramwaje linii 4 i 10 kursują objazdem przez ulicę Zieloną od poniedziałku';

const mockProvider = (name, items, opts = {}) => ({
  name,
  async fetch() {
    if (opts.fail) throw new Error(`${name} failed`);
    if (opts.delay) await new Promise((resolve) => setTimeout(resolve, opts.delay));
    return items;
  },
});

const mkItem = (overrides = {}) => ({
  id: null,
  title: null,
  content: '',
  url: null,
  timestamp: Date.now(),
  source: 'test',
  ...overrides,
});

describe('fingerprint / normalizeText', () => {
  it('lowercases and collapses whitespace', () => {
    assert.equal(
      normalizeText('  Linia  4   Objazd  '),
      'linia 4 objazd',
    );
  });

  it('strips URLs', () => {
    assert.equal(
      normalizeText('Objazd https://example.com/a i https://example.com/b'),
      'objazd i',
    );
  });

  it('normalizes smart punctuation to ASCII', () => {
    assert.equal(
      normalizeText('"Cytat" – myślnik…'),
      'cytat - myślnik',
    );
  });

  it('trims mechanical source prefixes', () => {
    assert.equal(
      normalizeText('#AlertMPK Ruch przywrócony na ulicy Reymonta'),
      'ruch przywrócony na ulicy reymonta',
    );
    assert.equal(
      normalizeText('@AlertMPK Ruch przywrócony na ulicy Reymonta'),
      'ruch przywrócony na ulicy reymonta',
    );
  });

  it('returns null for text shorter than 30 characters', () => {
    assert.equal(fingerprint(null, 'Linia 4 nie kursuje'), null, 'short text → no fingerprint');
    assert.ok(fingerprint(null, LONG_TEXT), 'long text → non-null fingerprint');
  });

  it('same text from different sources produces the same fingerprint', () => {
    const a = fingerprint(LONG_TEXT, null);
    const b = fingerprint(null, LONG_TEXT);
    assert.equal(a, b);
  });
});

describe('AlertsService dedup', () => {
  it('same ID from the same source => one alert', async () => {
    const item = mkItem({
      id: 'same-id',
      title: LONG_TEXT,
      content: 'Detail.',
      url: 'https://a.com',
      timestamp: 1000,
      source: 'a',
    });
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [item]),
      mockProvider('b', [{ ...item, source: 'b', timestamp: 2000 }]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 1, 'same ID deduped');
  });

  it('same normalized content, different source/ID => one alert', async () => {
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [mkItem({ id: '1', title: LONG_TEXT, content: 'Detail.', url: 'https://a.com', timestamp: 1000, source: 'a' })]),
      mockProvider('b', [mkItem({ id: '2', title: LONG_TEXT, content: 'Detail.', url: 'https://b.com', timestamp: 2000, source: 'b' })]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 1, 'cross-source fingerprint dedup');
    assert.equal(result[0].timestamp, 2000, 'newest timestamp wins');
    assert.equal(result[0].url, 'https://a.com', 'original URL preferred');
  });

  it('short identical generic text stays separate unless same ID', async () => {
    const base = 'Nie kursuje';
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [mkItem({ id: '1', title: base, content: '', timestamp: 1000, source: 'a' })]),
      mockProvider('b', [mkItem({ id: '2', title: base, content: '', timestamp: 2000, source: 'b' })]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 2, 'short content not fingerprint-deduped');
  });

  it('different content about the same line stays separate', async () => {
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [mkItem({ id: '1', title: LONG_TEXT, content: 'A detail.', timestamp: 1000, source: 'a' })]),
      mockProvider('b', [mkItem({ id: '2', title: 'Inny objazd linii 4', content: LONG_TEXT, timestamp: 2000, source: 'b' })]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 2, 'different content not deduped');
  });

  it('URL differences only: deduped when content is the same', async () => {
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [mkItem({ id: '1', title: LONG_TEXT, content: 'Detail.', url: 'https://a.com/1', timestamp: 1000, source: 'a' })]),
      mockProvider('b', [mkItem({ id: '2', title: LONG_TEXT, content: 'Detail.', url: 'https://b.com/2', timestamp: 2000, source: 'b' })]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 1, 'URL-only difference deduped');
    assert.equal(result[0].url, 'https://a.com/1', 'original URL kept');
  });

  it('merged alert unions affected lines from both sources', async () => {
    // Two items whose non-URL content is identical (same fingerprint after URL
    // stripping) but whose URLs embed different line numbers. The merged alert
    // should carry the union of both sets.
    const base = 'Tramwaje kursują objazdem przez ulicę Zieloną. ';
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [
        mkItem({ id: '1', title: null, content: base + 'https://linia-10.example.com', url: null, timestamp: 1000, source: 'a' }),
      ]),
      mockProvider('b', [
        mkItem({ id: '2', title: null, content: base + 'https://linia-4.example.com', url: null, timestamp: 2000, source: 'b' }),
      ]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 1, 'fingerprint deduped');
    const lines = result[0].affected.sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(lines, ['4', '10'], 'union of affected lines');
  });

  it('newest timestamp wins on merge', async () => {
    const service = new AlertsService(() => KNOWN, [
      mockProvider('a', [mkItem({ id: '1', title: LONG_TEXT, content: 'Detail.', url: null, timestamp: 1000, source: 'a' })]),
      mockProvider('b', [mkItem({ id: '2', title: LONG_TEXT, content: 'Detail.', url: null, timestamp: 5000, source: 'b' })]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 1, 'merged');
    assert.equal(result[0].timestamp, 5000, 'newest timestamp');
  });

  it('all providers failure retains previous list', async () => {
    let shouldFail = false;
    const provider = {
      name: 'flippy',
      async fetch() {
        if (shouldFail) throw new Error('down');
        return [mkItem({ id: 'x', title: LONG_TEXT, content: 'Body.', timestamp: 1000, source: 'flippy' })];
      },
    };
    const service = new AlertsService(() => KNOWN, [provider]);

    const result1 = await service.refresh();
    assert.equal(result1.length, 1, 'first refresh has the alert');

    shouldFail = true;
    const result2 = await service.refresh();
    assert.equal(result2.length, 1, 'previous list retained on total failure');
  });

  it('one provider failure: successful results still used', async () => {
    const service = new AlertsService(() => KNOWN, [
      mockProvider('fail', [], { fail: true }),
      mockProvider('ok', [
        mkItem({ id: '1', title: LONG_TEXT, content: 'Body.', url: null, timestamp: 1000, source: 'ok' }),
        mkItem({ id: '2', title: 'Different text entirely here.', content: 'Body 2.', url: null, timestamp: 2000, source: 'ok' }),
      ]),
    ]);
    const result = await service.refresh();
    assert.equal(result.length, 2, 'successful provider results used');
  });
});

describe('AlertsService poll lifecycle', () => {
  it('never overlaps refreshes when refresh exceeds the interval', async () => {
    const origInterval = config.alerts.refreshIntervalMs;
    config.alerts.refreshIntervalMs = 10;

    let inFlight = 0;
    let maxConcurrent = 0;
    const service = new AlertsService(() => KNOWN, [
      {
        name: 'slow',
        async fetch() {
          inFlight++;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 80));
          inFlight--;
          return [mkItem({ id: '1', title: LONG_TEXT, content: 'Body.', url: null, timestamp: 1000, source: 'slow' })];
        },
      },
    ]);

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    service.stop();
    config.alerts.refreshIntervalMs = origInterval;

    assert.equal(maxConcurrent, 1, 'no overlapping refreshes');
  });

  it('start() twice starts only one loop', async () => {
    let count = 0;
    const service = new AlertsService(() => KNOWN, [
      {
        name: 'count',
        async fetch() {
          count++;
          return [];
        },
      },
    ]);
    service.start();
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();
    assert.equal(count, 1, 'only one initial refresh');
  });

  it('stop() during in-flight prevents rearm', async () => {
    const service = new AlertsService(() => KNOWN, [
      {
        name: 'slow',
        async fetch() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [mkItem({ id: '1', title: LONG_TEXT, content: 'Body.', url: null, timestamp: 1000, source: 'slow' })];
        },
      },
    ]);

    service.start();
    // Let the in-flight refresh start
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(service.timer !== null, 'timer exists during in-flight');

    service.stop();
    assert.equal(service._stopped, true);

    // Wait for the in-flight refresh to settle
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(service.timer, null, 'no timer re-armed after stop');
    assert.equal(service.started, false);
  });

  it('stop() before start is a no-op', () => {
    const service = new AlertsService(() => KNOWN, []);
    service.stop();
    assert.equal(service.timer, null);
    assert.equal(service.started, false);
  });
});

// --- Line extraction regression tests (must keep passing after dedupe changes) ---

describe('date/time line extraction regression (dedupe does not regress extraction)', () => {
  it('22:00 does not become line 22', () => {
    assert.deepEqual(extractAffectedLines('W dniu 2026-06-15 od godz. 22:00 do 05:30 linia 128 nie kursuje.', KNOWN), ['128']);
  });

  it('21.07.2026 does not become line 21', () => {
    assert.deepEqual(extractAffectedLines('Od 21.07.2026 zmiana tras', KNOWN), []);
  });

  it('11–16 lipca does not become lines 11 and 16', () => {
    const known = new Set([...KNOWN, '11', '16']);
    assert.deepEqual(extractAffectedLines('Prace budowlane (11 - 16 lipca)', known), []);
  });
});
