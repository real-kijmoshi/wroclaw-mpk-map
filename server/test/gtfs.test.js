'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

const { GtfsStore, assertComplete } = require('../src/gtfs/store');
const { simplify, distanceMeters } = require('../src/gtfs/geo');
const { secondsToTime, timeToSeconds } = require('../src/gtfs/parse');
const { matchRank, normalizeSearchText } = require('../src/search');
const { buildFixtureZip } = require('./fixtures/gtfs');

describe('GtfsStore', () => {
  const store = new GtfsStore();

  before(async () => {
    await store.build(buildFixtureZip());
  });

  it('categorises every route in the feed', () => {
    assert.deepEqual(store.lines.tram, ['4']);
    assert.deepEqual(store.lines.bus, ['128']);
    assert.deepEqual(store.lines.busNight, ['240']);
  });

  it('builds one variant per shape, most used first', () => {
    const variants = store.getVariants('4');
    assert.equal(variants.length, 2);
    assert.equal(variants[0].shapeId, 's4a', 's4a has two trips so it ranks first');
    assert.equal(variants[0].tripCount, 2);
    assert.equal(variants[1].tripCount, 1);
  });

  it('names variants from their first and last stop', () => {
    const [first] = store.getVariants('4');
    assert.equal(first.direction, 'Rynek → Oporów');
    assert.equal(first.headsign, 'OPORÓW');
  });

  it('attaches ordered stops with times to each variant', () => {
    const [first] = store.getVariants('4');
    assert.deepEqual(
      first.stops.map((stop) => stop.name),
      ['Rynek', 'Świdnicka', 'Oporów'],
    );
    assert.equal(first.stops[0].departure, '08:00:00');
  });

  it('picks the variant closest to a reported vehicle position', () => {
    // Near Biskupin, which only the return leg (s4b) passes.
    const eastbound = store.getBestVariant('4', 51.1, 17.099);
    assert.equal(eastbound.shapeId, 's4b');

    // Near Oporów on the outbound leg.
    const westbound = store.getBestVariant('4', 51.0951, 17.0105);
    assert.equal(westbound.shapeId, 's4a');
  });

  it('uses the reported heading to choose between the two directions', () => {
    // Just off Oporów, the terminus s4a ends at and s4b starts from. Distance
    // puts both within a few dozen metres, so proximity alone decides the
    // direction on GPS noise — and half the time announces the wrong terminus.
    const position = [51.081, 16.983];

    assert.equal(store.getBestVariant('4', ...position, { heading: 231 }).shapeId, 's4a');
    assert.equal(store.getBestVariant('4', ...position, { heading: 78 }).shapeId, 's4b');
  });

  it('reports where on the shape a position falls', () => {
    const { variant, projection } = store.matchVariant('4', 51.105, 17.033);
    assert.equal(variant.shapeId, 's4a');
    assert.ok(projection.distance < 5, `expected to be on the line, got ${projection.distance} m`);
    // Świdnicka is the second stop, roughly 550 m into the route.
    assert.ok(projection.along > 500 && projection.along < 620, `got ${projection.along} m`);
  });

  it('measures each stop along the shape and against the start of the run', () => {
    const [variant] = store.getVariants('4');
    const along = variant.stops.map((stop) => stop.alongMeters);
    assert.deepEqual([...along].sort((a, b) => a - b), along, 'stops advance along the shape');
    assert.equal(along[0], 0);
    assert.ok(Math.abs(along[2] - variant.lengthMeters) < 1, 'the last stop is the end of the shape');

    // 08:00, 08:05, 08:15 — offsets from the moment the run leaves Rynek, so
    // they hold for every departure of the shape and not just this one.
    assert.deepEqual(
      variant.stops.map((stop) => stop.arrivalOffset),
      [0, 300, 900],
    );
  });

  it('indexes every trip running a shape, in departure order', () => {
    const [variant] = store.getVariants('4');
    assert.deepEqual(
      [...variant.trips].map((index) => store.trips[index].id),
      ['t4a', 't4a2'],
    );
    assert.equal(store.tripStart[variant.trips[0]], 8 * 3600, 't4a leaves at 08:00');
    assert.equal(store.tripEnd[variant.trips[0]], 8 * 3600 + 900, 'and arrives at 08:15');
  });

  it('falls back to the busiest variant without a position', () => {
    assert.equal(store.getBestVariant('4', null, null).shapeId, 's4a');
    assert.equal(store.getBestVariant('4', Number.NaN, Number.NaN).shapeId, 's4a');
  });

  it('returns null for unknown lines', () => {
    assert.equal(store.getBestVariant('999', 51.1, 17.03), null);
    assert.deepEqual(store.getVariants('999'), []);
  });

  it('indexes stops for lookup and search', () => {
    assert.equal(store.getStop('1').name, 'Rynek');
    assert.equal(store.getStop('nope'), null);
    assert.deepEqual(
      store.searchStops('swidnicka').map((stop) => stop.name),
      ['Świdnicka'],
      'search ignores Polish diacritics',
    );
    assert.deepEqual(store.getLinesForStop('4'), ['4']);
  });

  it('finds nearby stops with real distances on both axes', () => {
    // Rynek is at 51.11 / 17.032. A degree of longitude is ~0.63 of a degree of
    // latitude here, so a grid built on 111 km/degree for both under-searches
    // east-west; these assertions pin the real geometry.
    const near = store.findStopsNear(51.11, 17.032, { radiusMeters: 800 });
    assert.deepEqual(near.map((stop) => stop.name), ['Rynek', 'Świdnicka']);
    assert.equal(near[0].distance, 0);
    assert.ok(near[1].distance > 500 && near[1].distance < 600, `got ${near[1].distance} m`);

    assert.deepEqual(store.findStopsNear(51.11, 17.032, { radiusMeters: 100 }).length, 1);
    assert.deepEqual(store.findStopsNear(Number.NaN, 17.032), []);
  });

  it('honours calendar days when listing departures', () => {
    // 2026-06-15 is a Monday, so WEEKDAY services run.
    const monday = new Date('2026-06-15T05:00:00Z');
    const departures = store.getDepartures('1', { now: monday, limit: 10 });
    assert.ok(departures.length > 0);
    assert.ok(departures.every((departure) => departure.serviceDay === 'today'));
    assert.ok(departures.every((departure) => departure.inSeconds >= 0));

    // Sunday morning: no WEEKDAY service runs, and the night bus is outside
    // an explicitly requested two-hour horizon.
    const sunday = new Date('2026-06-14T05:00:00Z');
    assert.deepEqual(store.getDepartures('1', { now: sunday, limit: 10, horizonSeconds: 7200 }), []);
  });

  it('keeps departures on their own nearby same-name platform', () => {
    const anchor = store.getStop('4');
    const platformRows = store.departuresByStop.get('4');
    store.departuresByStop.set('4', []);
    store.stopsById.set('4-sibling', {
      ...anchor,
      id: '4-sibling',
      code: '104B',
      lat: anchor.lat + 0.0005,
    });
    store.departuresByStop.set('4-sibling', platformRows);

    try {
      const departures = store.getDeparturesForStop('4', {
        now: new Date('2026-06-15T07:00:00Z'),
        limit: 10,
      });
      assert.deepEqual(departures, []);
    } finally {
      store.departuresByStop.set('4', platformRows);
      store.departuresByStop.delete('4-sibling');
      store.stopsById.delete('4-sibling');
    }
  });

  it('groups duplicate pattern records but keeps opposing platforms in search', async () => {
    const platformStore = new GtfsStore();
    await platformStore.build(buildFixtureZip({
      stops: [
        ['1', '101', 'Rynek', '51.11000', '17.03200'],
        ['2', '102', 'Świdnicka', '51.10500', '17.03300'],
        ['3', '103', 'Oporów', '51.08000', '16.98000'],
        ['4', '104', 'Biskupin', '51.10000', '17.10000'],
        ['5', '105', 'Krzyki', '51.07000', '17.03000'],
        ['a', '24505', 'Spółdzielcza', '51.10000', '17.00000'],
        ['b', '24534', 'Spółdzielcza', '51.10003', '17.00003'],
        ['c', '24414', 'Spółdzielcza', '51.10022', '17.00022'],
      ],
    }));

    const platforms = platformStore.searchStops('spoldzielcza', 10);
    assert.equal(platforms.length, 2, 'two code areas, not three raw records');
    assert.deepEqual(platforms[0].ids, ['a', 'b']);
    assert.equal(platforms[1].id, 'c');
  });

  it('applies calendar_dates exceptions', () => {
    // Christmas Day 2026 is a Friday, but WEEKDAY is cancelled and WEEKEND added.
    const christmas = new Date('2026-12-25T06:00:00Z');
    assert.equal(store.isServiceActive('WEEKDAY', christmas), false);
    assert.equal(store.isServiceActive('WEEKEND', christmas), true);
  });

  it('surfaces after-midnight trips from the previous service day', () => {
    // Sunday 00:30 local: the Saturday 240 trip at 25:30 is still to come.
    const earlySunday = new Date('2026-06-14T00:30:00+02:00');
    const departures = store.getDepartures('1', { now: earlySunday, limit: 10 });
    assert.equal(departures.length, 1);
    assert.equal(departures[0].line, '240');
    assert.equal(departures[0].serviceDay, 'yesterday');
    assert.equal(departures[0].departure, '01:30:00');
  });

  it('shows tomorrow’s first service after the evening timetable ends', () => {
    const lateMonday = new Date('2026-06-15T21:30:00Z');
    const departures = store.getDepartures('1', { now: lateMonday, limit: 10 });

    assert.ok(departures.some((departure) => departure.serviceDay === 'tomorrow'));
    assert.equal(departures[0].line, '4');
    assert.equal(departures[0].serviceDay, 'tomorrow');
  });

  it('reports counts after a build', () => {
    assert.equal(store.status.counts.routes, 3);
    assert.equal(store.status.counts.variants, 4);
    assert.equal(store.status.counts.stops, 5);
  });

  it('records per-stage timings and memory for the build', () => {
    const lastBuild = store.performance.lastBuild;
    assert.ok(lastBuild.totalMs >= 0, 'total build time is reported');
    for (const stage of [
      'archiveOpen',
      'agency',
      'routes',
      'trips',
      'stops',
      'calendar',
      'shapes',
      'stopTimes',
      'variants',
    ]) {
      assert.ok(Number.isFinite(lastBuild.stages[stage]), `stage ${stage} is timed`);
    }
    // stopTimes excludes the variants pass, so the stages never double-count.
    assert.ok(lastBuild.stages.stopTimes + lastBuild.stages.variants <= lastBuild.totalMs);
    for (const [kind, memory] of [
      ['latestMemory', lastBuild.latestMemory],
      ['peakMemory', lastBuild.peakMemory],
    ]) {
      for (const key of ['rssMb', 'heapUsedMb', 'externalMb', 'arrayBuffersMb']) {
        assert.ok(Number.isFinite(memory[key]), `${kind}.${key} is a number`);
      }
    }
    assert.ok(lastBuild.peakMemory.heapUsedMb >= lastBuild.latestMemory.heapUsedMb);
  });
});

describe('stop search', () => {
  const buildWithStops = async (stops) => {
    const store = new GtfsStore();
    await store.build(buildFixtureZip({ stops }));
    return store;
  };

  const stops = (rows) =>
    rows.map(([id, name], index) => [id, String(index), name, '51.10', '17.03']);

  it('returns nothing for empty, whitespace or all-punctuation queries', async () => {
    const store = await buildWithStops(stops([['1', 'Rynek'], ['2', 'Świdnicka']]));
    assert.deepEqual(store.searchStops(''), []);
    assert.deepEqual(store.searchStops('   '), []);
    assert.deepEqual(store.searchStops('\t\n'), []);
  });

  it('folds Polish diacritics in both directions', async () => {
    const store = await buildWithStops(
      stops([
        ['1', 'Żabka'],
        ['2', 'Kąty Wrocławskie'],
        ['3', 'Dworcowa'],
        ['4', 'Ząbkowice'],
      ]),
    );
    // Query without diacritics matches a name that has them (ż -> z, ą -> a).
    assert.deepEqual(store.searchStops('zabka').map((stop) => stop.name), ['Żabka']);
    assert.deepEqual(store.searchStops('zabkowice').map((stop) => stop.name), ['Ząbkowice']);
    // Query with diacritics matches a name that has none.
    assert.deepEqual(store.searchStops('żabka').map((stop) => stop.name), ['Żabka']);
    // Case does not matter.
    assert.deepEqual(store.searchStops('DwOrCoWa').map((stop) => stop.name), ['Dworcowa']);
  });

  it('ranks exact, prefix, word-prefix and substring matches in order', async () => {
    const store = await buildWithStops(
      stops([
        ['1', 'Podworcowa'], // rank 3: substring only ("dworcowa" mid-word)
        ['2', 'Aleja Dworcowa'], // rank 2: a word starts with the query
        ['3', 'Dworcowa Stary'], // rank 1: the name starts with the query
        ['4', 'Dworcowa'], // rank 0: exact
      ]),
    );
    assert.deepEqual(
      store.searchStops('dworcowa').map((stop) => stop.name),
      ['Dworcowa', 'Dworcowa Stary', 'Aleja Dworcowa', 'Podworcowa'],
    );
  });

  it('breaks ties by shorter name, then lexical order, then id', async () => {
    const store = await buildWithStops(
      stops([
        // Both rank 1 (name starts with the query), same name length; the
        // id decides. Inserted out of id order on purpose.
        ['b', 'Dworcowa Południe'],
        ['a', 'Dworcowa Północ'],
        // Shorter rank-1 name wins over a longer one.
        ['c', 'Dworcowa B'],
        ['d', 'Dworcowa Bą'],
      ]),
    );
    const names = store.searchStops('dworcowa', 10).map((stop) => stop.name);
    assert.deepEqual(names, ['Dworcowa B', 'Dworcowa Bą', 'Dworcowa Północ', 'Dworcowa Południe']);
  });

  it('is deterministic: the same query yields the same ordering', async () => {
    const store = await buildWithStops(
      stops([
        ['1', 'Dworcowa'],
        ['2', 'Dworcowa Południe'],
        ['3', 'Podworcowa'],
        ['4', 'Aleja Dworcowa'],
      ]),
    );
    const first = store.searchStops('dworcowa', 10).map((stop) => stop.id);
    const second = store.searchStops('dworcowa', 10).map((stop) => stop.id);
    assert.deepEqual(first, second);
  });

  it('honours the limit and never returns duplicates', async () => {
    const store = await buildWithStops(
      stops([
        ['1', 'Rynek'],
        ['2', 'Rynek Główny'],
        ['3', 'Rynek Południe'],
        ['4', 'Mały Rynek'],
        ['5', 'Rynek Północ'],
      ]),
    );
    const limited = store.searchStops('rynek', 2);
    assert.equal(limited.length, 2);
    const ids = limited.map((stop) => stop.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate stops');
  });

  it('treats canonically-equivalent spellings as the same name', async () => {
    // "S\u0301widnicka" is "Świdnicka" written as S + U+0301.
    const store = await buildWithStops(stops([['1', 'S\u0301widnicka'], ['2', 'Świdnicka']]));
    const results = store.searchStops('swidnicka', 10);
    assert.deepEqual(results.map((stop) => stop.name).sort(), ['Świdnicka', 'Świdnicka']);
    // The query itself, written the other way, matches both too.
    assert.equal(store.searchStops('S\u0301widnicka', 10).length, 2);
  });

  it('folds Polish ł but does not transliterate unrelated letters', async () => {
    const store = await buildWithStops(stops([['1', 'Straße'], ['2', 'Rynek']]));
    // ß is not a Polish diacritic and remains distinct from ss.
    assert.deepEqual(store.searchStops('strasse'), []);
    assert.equal(store.searchStops('straße').length, 1);
    assert.equal(normalizeSearchText('Łowiecka'), 'lowiecka');
  });

  it('finds an exact match that sits late in insertion order (the old cutoff bug)', async () => {
    // The old implementation stopped collecting after `limit * 10` matches,
    // so with limit 2 it broke after 20 results and never examined the exact
    // match at the very end of the feed — returning only prefix hits even
    // though the exact name was present. Every stop is scanned now.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => [`w${i}`, `Rynek-Południe-${i}`]),
      ['exact', 'Rynek'],
    ];
    const store = await buildWithStops(stops(rows));
    const names = store.searchStops('rynek', 2).map((stop) => stop.name);
    assert.equal(names[0], 'Rynek');
    assert.equal(names.length, 2);
    assert.notEqual(names[1], 'Rynek', 'the second hit is a prefix match, not a duplicate');
  });

  it('treats Ł/ł as a letter, not a word boundary', async () => {
    // Ł has no canonical decomposition, so NFD normalization leaves it in place
    // — and the old ASCII-only WORD_BREAK treated it as a separator. That split
    // "aleja łowiecka" into ["aleja", "owiecka"], downgrading a word-prefix
    // match ("ło") to a generic substring match. The Unicode regex keeps ł as a
    // letter so the word is "łowiecka" and the prefix rank is preserved.
    const store = await buildWithStops(stops([['1', 'Aleja Łowiecka']]));
    assert.deepEqual(store.searchStops('ło').map((stop) => stop.name), ['Aleja Łowiecka']);
    assert.deepEqual(store.searchStops('łow').map((stop) => stop.name), ['Aleja Łowiecka']);
  });

  it('treats every Polish letter as a letter for word boundaries', async () => {
    // Ł/ł have no canonical decomposition and survive normalizeSearchText()
    // as-is, so the word boundary must not split on them. The other Polish
    // letters (Ś, Ź, Ć, Ń, Ó, Ę, Ą, Ż) DO decompose to ASCII under NFD, so
    // they work with any word-boundary regex — these tests pin that end-to-end
    // behaviour through searchStops for both groups.
    const store = await buildWithStops(
      stops([
        ['1', 'Aleja Łowiecka'],
        ['2', 'Aleja Świdnicka'],
        ['3', 'Aleja Żmigrodzka'],
        ['4', 'Aleja Źródlana'],
        ['5', 'Aleja Ćwiartki'],
        ['6', 'Aleja Ńuty'],
        ['7', 'Aleja Ówczysko'],
        ['8', 'Aleja Ędka'],
        ['9', 'Aleja Ąbługa'],
      ]),
    );
    // Each query is a word-prefix: "łowiecka" starts with "ło", etc.
    assert.deepEqual(store.searchStops('łow').map((s) => s.name), ['Aleja Łowiecka']);
    assert.deepEqual(store.searchStops('świ').map((s) => s.name), ['Aleja Świdnicka']);
    assert.deepEqual(store.searchStops('żmig').map((s) => s.name), ['Aleja Żmigrodzka']);
    assert.deepEqual(store.searchStops('źród').map((s) => s.name), ['Aleja Źródlana']);
    assert.deepEqual(store.searchStops('ćwia').map((s) => s.name), ['Aleja Ćwiartki']);
    assert.deepEqual(store.searchStops('ńut').map((s) => s.name), ['Aleja Ńuty']);
    assert.deepEqual(store.searchStops('ówcz').map((s) => s.name), ['Aleja Ówczysko']);
    assert.deepEqual(store.searchStops('ędk').map((s) => s.name), ['Aleja Ędka']);
    assert.deepEqual(store.searchStops('ąbł').map((s) => s.name), ['Aleja Ąbługa']);
  });

  it('ranks a Polish word-prefix above a generic substring', async () => {
    // "Aleja Łowiecka" — querying "ło" is a word-prefix (rank 2).
    // "Członkowie" — querying "ło" is a substring mid-word (rank 3).
    // The word-prefix must win even though "Członkowie" sorts later.
    const store = await buildWithStops(
      stops([
        ['1', 'Aleja Łowiecka'],
        ['2', 'Członkowie'],
      ]),
    );
    assert.deepEqual(
      store.searchStops('ło').map((stop) => stop.name),
      ['Aleja Łowiecka', 'Członkowie'],
    );
  });

  it('matchRank keeps a folded ł as part of a word (unit-level regression)', () => {
    // Normalize both sides the same way searchStops does.
    const name = normalizeSearchText('Aleja Łowiecka');
    assert.equal(name, 'aleja lowiecka', 'ł folds to an ordinary searchable l');

    // Word-prefix, not substring: the folded l is still part of "lowiecka".
    assert.equal(matchRank(name, normalizeSearchText('ło')), 2);
    assert.equal(matchRank(name, normalizeSearchText('łow')), 2);

    // Other Polish letters that decompose to ASCII behave the same way in
    // multi-word names: the second word still starts with the query letter.
    assert.equal(matchRank(normalizeSearchText('Aleja Świdnicka'), normalizeSearchText('świ')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Żmigrodzka'), normalizeSearchText('żmig')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Źródlana'), normalizeSearchText('źr')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Ćwiartki'), normalizeSearchText('ćw')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Ńuty'), normalizeSearchText('ńut')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Ówczysko'), normalizeSearchText('ówcz')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Ędka'), normalizeSearchText('ęd')), 2);
    assert.equal(matchRank(normalizeSearchText('Aleja Ąbługa'), normalizeSearchText('ąb')), 2);

    // Ranking order still holds: exact > prefix > word-prefix > substring.
    assert.equal(matchRank(name, name), 0, 'exact');
    assert.equal(matchRank(name, normalizeSearchText('aleja')), 1, 'full-name prefix');
    assert.equal(matchRank(name, normalizeSearchText('ło')), 2, 'word-prefix');
    assert.equal(matchRank(name, normalizeSearchText('owiec')), 3, 'substring');
  });

  it('is deterministic with mixed Latin and Polish text', async () => {
    const store = await buildWithStops(
      stops([
        ['a', 'Łowiecka'],
        ['b', 'Świdnicka'],
        ['c', 'Żmigrodzka'],
        ['d', 'Źródlana'],
      ]),
    );
    const first = store.searchStops('ło', 10).map((s) => s.id);
    const second = store.searchStops('ło', 10).map((s) => s.id);
    assert.deepEqual(first, second, 'identical input yields identical order');
  });
});

describe('assertComplete', () => {
  it('accepts a full archive', () => {
    assert.doesNotThrow(() => assertComplete(buildFixtureZip()));
  });

  it('rejects a snapshot with no route geometry', () => {
    // The city's archive interleaves ~11 MB snapshots with ~6 MB ones; a short
    // one can be missing shapes.txt, which leaves the map with no routes.
    assert.throws(
      () => assertComplete(buildFixtureZip({ omit: ['shapes'] })),
      /missing shapes\.txt/,
    );
  });

  it('accepts an archive whose tables are nested in a directory', () => {
    // Some publishers ship GTFS/shapes.txt rather than shapes.txt; an
    // exact-path lookup reads that as a feed with no route geometry.
    assert.doesNotThrow(() => assertComplete(buildFixtureZip({ prefix: 'GTFS/' })));
  });

  it('names every missing table', () => {
    assert.throws(
      () => assertComplete(buildFixtureZip({ omit: ['shapes', 'stop_times'] })),
      /stop_times\.txt/,
    );
  });
});

describe('nested archives', () => {
  it('indexes a feed whose tables sit in a subdirectory', async () => {
    const nested = new GtfsStore();
    await nested.build(buildFixtureZip({ prefix: 'OtwartyWroclaw_GTFS/' }));

    assert.deepEqual(nested.lines.tram, ['4']);
    assert.equal(nested.status.counts.stops, 5);
    // The point of the fix: route geometry survives the nesting.
    assert.ok(nested.getVariants('4')[0].points.length > 0);
  });
});

describe('geometry helpers', () => {
  it('measures real-world distances', () => {
    // Rynek to Dworzec Główny is roughly 1.6 km.
    const meters = distanceMeters(51.11, 17.032, 51.0985, 17.0365);
    assert.ok(meters > 1200 && meters < 1600, `unexpected distance ${meters}`);
  });

  it('drops collinear points when simplifying', () => {
    const straight = new Float64Array([51.1, 17.0, 51.2, 17.0, 51.3, 17.0]);
    assert.equal(simplify(straight, 5).length, 4, 'middle point of a straight line is redundant');
  });

  it('keeps corners when simplifying', () => {
    const corner = new Float64Array([51.1, 17.0, 51.1, 17.1, 51.2, 17.1]);
    assert.equal(simplify(corner, 5).length, 6);
  });

  it('handles long shapes without overflowing the stack', () => {
    const points = new Float64Array(200_000);
    for (let i = 0; i < points.length / 2; i += 1) {
      points[i * 2] = 51.1 + Math.sin(i / 50) * 0.05;
      points[i * 2 + 1] = 17.0 + Math.cos(i / 50) * 0.05;
    }
    assert.ok(simplify(points, 5).length < points.length);
  });
});

describe('time helpers', () => {
  it('round-trips times', () => {
    assert.equal(timeToSeconds('08:05:30'), 29_130);
    assert.equal(secondsToTime(29_130), '08:05:30');
  });

  it('supports GTFS times past midnight', () => {
    assert.equal(timeToSeconds('25:30:00'), 91_800);
    assert.equal(secondsToTime(91_800), '01:30:00');
  });

  it('rejects unparseable values', () => {
    assert.equal(timeToSeconds(''), -1);
    assert.equal(timeToSeconds('nope'), -1);
    assert.equal(secondsToTime(-1), null);
  });
});
