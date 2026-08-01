'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { extractAffectedLines, parseFeed, parsePage, stripHtml } = require('../src/alerts');

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
