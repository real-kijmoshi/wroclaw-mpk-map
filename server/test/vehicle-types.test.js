'use strict';

const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { describe, it } = require('node:test');

const { GtfsStore } = require('../src/gtfs/store');
const { combine, UNKNOWN } = require('../src/fleet');
const { parseFlag, parseLowFloor, readPhrases, readVehicleTypes } = require('../src/gtfs/vehicle-types');
const { buildFixtureZip } = require('./fixtures/gtfs');

const zipOf = (files) => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return new AdmZip(zip.toBuffer());
};

const typesFrom = (text, name = 'vehicle_types.txt') => readVehicleTypes(zipOf({ [name]: text }));

describe('vehicle_types.txt', () => {
  /**
   * The table is not in the GTFS spec, so its columns are a publishing
   * convention rather than a contract — read the way `parseFileListing()` reads
   * the catalogue, by looking for a column that plausibly carries each field.
   * Pinning one spelling means a rename silently serves nothing.
   */
  it('accepts the column spellings publishers actually use', () => {
    const byLongNames = typesFrom(
      ['vehicle_type_id,vehicle_type_name,low_floor,air_conditioning', 'A,Škoda 19T,1,0'].join('\n'),
    );
    const byShortNames = typesFrom(
      ['id,model,niska_podloga,klimatyzacja', 'A,Škoda 19T,tak,nie'].join('\n'),
    );

    for (const types of [byLongNames, byShortNames]) {
      assert.equal(types.get('A').model, 'Škoda 19T');
      assert.equal(types.get('A').lowFloor, 'full');
      assert.equal(types.get('A').airConditioning, false);
    }
  });

  it('finds the table under the other names it ships as', () => {
    const row = ['vehicle_type_id,vehicle_type_name', 'A,Pesa Twist'].join('\n');
    for (const name of ['vehicle_types.txt', 'vehicle_type.txt', 'vehicles.txt']) {
      assert.equal(typesFrom(row, name).get('A').model, 'Pesa Twist', name);
    }
    // Invariant 5: nested layouts are found by file name, not by path.
    assert.equal(
      readVehicleTypes(zipOf({ 'GTFS/vehicle_types.txt': row })).get('A').model,
      'Pesa Twist',
    );
  });

  /** A feed with no such table is the ordinary case, not a failure. */
  it('returns nothing for a feed that ships no table', () => {
    assert.equal(readVehicleTypes(zipOf({ 'routes.txt': 'route_id\n4' })).size, 0);
  });

  /**
   * Silence is not a "no". A description that never mentions air conditioning
   * leaves it unknown, so the client says "brak danych" rather than telling a
   * rider the tram is not air conditioned on the strength of a sentence that
   * was about something else.
   */
  it('reads prose but never turns silence into a no', () => {
    assert.deepEqual(readPhrases('Tramwaj częściowo niskopodłogowy z klimatyzacją'), {
      lowFloor: 'partial',
      airConditioning: true,
    });
    assert.deepEqual(readPhrases('Autobus wysokopodłogowy bez klimatyzacji'), {
      lowFloor: 'none',
      airConditioning: false,
    });
    assert.deepEqual(readPhrases('Solaris Urbino 12'), { lowFloor: null, airConditioning: null });
    assert.deepEqual(readPhrases(''), { lowFloor: null, airConditioning: null });
  });

  /**
   * `ł` is its own letter rather than an `l` with a mark, so NFD leaves it
   * alone — every "niskopodłogowy" in the feed sails past an ASCII pattern
   * unless it is replaced by hand.
   */
  it('matches the accented and the de-accented spelling alike', () => {
    for (const text of ['niskopodłogowy', 'niskopodlogowy', 'NISKOPODŁOGOWY']) {
      assert.equal(readPhrases(text).lowFloor, 'full', text);
    }
  });

  it('states nothing for a value it does not recognise', () => {
    assert.equal(parseFlag(''), null);
    assert.equal(parseFlag('maybe'), null);
    assert.equal(parseFlag(undefined), null);
    // GTFS's own 2 = not accessible must not read as truthy.
    assert.equal(parseFlag('2'), false);
    assert.equal(parseFlag('tak'), true);
  });

  it('reads a low-floor column as a level, a share or a flag', () => {
    assert.equal(parseLowFloor('100'), 'full');
    assert.equal(parseLowFloor('27%'), 'partial');
    assert.equal(parseLowFloor('częściowa'), 'partial');
    // 0 and 1 are the flag encoding, not one percent of a low floor.
    assert.equal(parseLowFloor('1'), 'full');
    assert.equal(parseLowFloor('0'), 'none');
    assert.equal(parseLowFloor('sort of'), null);
  });

  /**
   * A stated column is the publisher's answer and a sentence is an inference
   * from it, so the column wins. The other way round, one adjective in a
   * description would overrule a field somebody filled in on purpose.
   */
  it('lets a column overrule the prose, never the reverse', () => {
    const types = typesFrom(
      [
        'vehicle_type_id,vehicle_type_name,vehicle_type_description,air_conditioning',
        'A,Konstal 105Na,Tramwaj z klimatyzacją,0',
      ].join('\n'),
    );
    assert.equal(types.get('A').airConditioning, false);
  });

  /**
   * A municipal `vehicle_types.txt` is at least as likely to hold a fare or
   * traction class ("Tramwaj") as a model ("Moderus Beta MF 24 AC"). Printing
   * the first gives a rider a card reading "POJAZD / Tramwaj", which looks like
   * an answer and is worse than the honest "Model nieznany" they get from a
   * feed with no table at all.
   */
  it('refuses to print a bare category as a model', () => {
    const types = typesFrom(
      [
        'vehicle_type_id,vehicle_type_name',
        '1,Tramwaj',
        '2,AUTOBUS',
        '3,Autobus przegubowy',
        '4,Moderus Beta MF 24 AC',
      ].join('\n'),
    );

    assert.equal(types.get('1').model, null);
    assert.equal(types.get('2').model, null, 'case and spacing do not smuggle one through');
    // Not a bare category — it says something real about the vehicle arriving.
    assert.equal(types.get('3').model, 'Autobus przegubowy');
    assert.equal(types.get('4').model, 'Moderus Beta MF 24 AC');
  });

  /** A rejected name is still read for what it says about the floor. */
  it('still reads a category name for its adjectives', () => {
    const types = typesFrom(
      ['vehicle_type_id,vehicle_type_name', '1,Tramwaj niskopodłogowy'].join('\n'),
    );
    assert.equal(types.get('1').lowFloor, 'full');
    assert.equal(types.get('1').wheelchair, true);
  });

  it('hands out frozen, shared attribute objects', () => {
    const types = typesFrom(['vehicle_type_id,vehicle_type_name', 'A,Pesa Twist'].join('\n'));
    assert.equal(Object.isFrozen(types.get('A')), true);
    assert.equal(types.get('A'), types.get('A'));
  });
});

describe('GtfsStore vehicle types', () => {
  it('joins trips to the type table and counts what it read', async () => {
    const store = new GtfsStore();
    await store.build(buildFixtureZip());

    const trip = (id) => store.trips[store.tripIndexById.get(id)];
    assert.equal(trip('t4a').vehicleTypeId, 'VT1');
    assert.equal(store.status.counts.vehicleTypes, 3);

    const beta = store.getVehicleType('VT1');
    assert.equal(beta.model, 'Moderus Beta MF 24 AC');
    assert.equal(beta.lowFloor, 'partial');
    assert.equal(beta.airConditioning, true);
    // Nothing in the row said "wheelchair", but a low floor is how one gets on.
    assert.equal(beta.wheelchair, true);

    const konstal = store.getVehicleType('VT2');
    assert.equal(konstal.lowFloor, 'none');
    assert.equal(konstal.airConditioning, false);
    assert.equal(konstal.wheelchair, false);

    // A row that states only a name states only a name.
    const solaris = store.getVehicleType('VT3');
    assert.equal(solaris.model, 'Solaris Urbino 12');
    assert.equal(solaris.lowFloor, null);
    assert.equal(solaris.wheelchair, null);
    assert.equal(solaris.airConditioning, null);
  });

  /**
   * `trips.vehicle_id` does double duty across the feeds this store reads: a
   * type reference in Wrocław's, one physical bus in a subcontractor's, which
   * Kłosok's GTFS-RT joins on. Reading the second as a type would print a fleet
   * number to a rider as a model.
   */
  it('never reads a physical vehicle id as a type', () => {
    const store = new GtfsStore();
    return store.build(buildFixtureZip()).then(() => {
      const bus = store.trips[store.tripIndexById.get('t128')];
      assert.equal(bus.vehicleId, '8123', 'still joinable by Kłosok');
      assert.equal(bus.vehicleTypeId, null, 'but not a type');
      assert.equal(store.getVehicleType('8123'), null);
      assert.equal(store.getVehicleType(null), null);
    });
  });

  /**
   * Which trips column points at the type table is a publishing convention too,
   * so a single guessed name would silently join nothing on a feed that spells
   * it differently.
   */
  it('joins on whichever trips column resolves to a type', async () => {
    const zip = new AdmZip(buildFixtureZip());
    zip.addFile(
      'trips.txt',
      Buffer.from(
        [
          'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,vehicle_type_id',
          '4,WEEKDAY,t4a,OPORÓW,0,s4a,VT1',
        ].join('\n'),
        'utf8',
      ),
      '',
      undefined,
      true,
    );

    const store = new GtfsStore();
    await store.build(zip.toBuffer());
    assert.equal(store.trips[store.tripIndexById.get('t4a')].vehicleTypeId, 'VT1');
  });

  it('builds a feed with no type table exactly as before', async () => {
    const store = new GtfsStore();
    await store.build(buildFixtureZip({ omit: ['vehicle_types'] }));

    assert.equal(store.status.counts.vehicleTypes, 0);
    assert.equal(store.trips[store.tripIndexById.get('t4a')].vehicleTypeId, null);
    assert.equal(store.getVehicleType('VT1'), null);
  });
});

describe('combining the roster and the feed', () => {
  const roster = Object.freeze({
    model: 'Moderus Beta MF 24 AC',
    kind: 'tram',
    lowFloor: 'partial',
    wheelchair: null,
    airConditioning: null,
    years: '2018',
    source: 'https://example.invalid',
  });
  const feed = Object.freeze({
    model: 'Tramwaj',
    lowFloor: 'full',
    wheelchair: true,
    airConditioning: true,
    description: null,
  });

  /**
   * The roster is keyed on the side number, so it describes the vehicle that
   * turned up; the feed describes the type the timetable rostered onto the run,
   * which is a plan and can be swapped on the day.
   */
  it('lets the roster win per field and the feed fill the gaps', () => {
    const merged = combine(roster, feed);
    assert.equal(merged.model, 'Moderus Beta MF 24 AC');
    assert.equal(merged.lowFloor, 'partial');
    assert.equal(merged.wheelchair, true, 'gap filled from the feed');
    assert.equal(merged.airConditioning, true);
    assert.equal(merged.years, '2018');
  });

  /** With an empty roster — the bus half of the bundled one — the feed is all there is. */
  it('serves the feed alone when the roster knows nothing', () => {
    const merged = combine(UNKNOWN, feed);
    assert.equal(merged.model, 'Tramwaj');
    assert.equal(merged.lowFloor, 'full');
    assert.equal(merged.airConditioning, true);
  });

  it('stays UNKNOWN when neither says anything', () => {
    assert.equal(combine(UNKNOWN, null), UNKNOWN);
    assert.equal(
      combine(UNKNOWN, { model: null, lowFloor: null, wheelchair: null, airConditioning: null }),
      UNKNOWN,
    );
  });

  it('returns the roster object untouched when there is no feed answer', () => {
    assert.equal(combine(roster, null), roster);
  });

  /**
   * This runs for every vehicle on every poll, so the merge has to be memoised
   * on the identity of its two interned inputs rather than allocating a fresh
   * object several hundred times a minute.
   */
  it('interns the merged object', () => {
    assert.equal(combine(roster, feed), combine(roster, feed));
    assert.equal(Object.isFrozen(combine(roster, feed)), true);
  });
});
