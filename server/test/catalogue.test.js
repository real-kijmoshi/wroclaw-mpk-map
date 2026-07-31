'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  describePayload,
  effectiveDateFromName,
  orderByEffectiveDate,
  parseFileListing,
  pickZipResources,
} = require('../src/gtfs/catalogue');

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Modelled on the real listing for dataset 6, captured 2026-07-30.
const listing = {
  files: [
    { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_25072026', url: 'https://api.open-data.cui.wroclaw.pl/f/1', rozszerzenie: 'zip' },
    { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_18072026', url: 'https://api.open-data.cui.wroclaw.pl/f/2', rozszerzenie: 'zip' },
    { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_01082026', url: 'https://api.open-data.cui.wroclaw.pl/f/3', rozszerzenie: 'zip' },
    { nazwa: 'OtwartyWroclaw_rozklad_jazdy_GTFS_13072026', url: 'https://api.open-data.cui.wroclaw.pl/f/4', rozszerzenie: 'zip' },
  ],
};

describe('effectiveDateFromName', () => {
  it('reads DDMMYYYY out of a snapshot filename', () => {
    assert.equal(iso(effectiveDateFromName('..._GTFS_25072026')), '2026-07-25');
    assert.equal(iso(effectiveDateFromName('..._GTFS_01082026')), '2026-08-01');
  });

  it('returns null when there is no valid date', () => {
    assert.equal(effectiveDateFromName('no date here'), null);
    assert.equal(effectiveDateFromName('..._GTFS_99992026'), null, 'day 99 is not a date');
    assert.equal(effectiveDateFromName(null), null);
  });
});

describe('parseFileListing', () => {
  it('reads the archive listing regardless of key naming', () => {
    const entries = parseFileListing(listing);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].name, 'OtwartyWroclaw_rozklad_jazdy_GTFS_25072026');
  });

  it('ignores the XML sibling feed and junk', () => {
    const entries = parseFileListing({
      a: [{ name: 'rozklad XML', url: 'https://x.pl/x.zip' }],
      b: { name: 'GTFS_01012026', url: 'https://x.pl/ok', extension: 'zip' },
      c: { name: 'no url' },
      d: 'string',
    });
    assert.deepEqual(
      entries.map((entry) => entry.url),
      ['https://x.pl/ok'],
    );
  });

  it('survives a payload that is not a listing at all', () => {
    assert.deepEqual(parseFileListing(null), []);
    assert.deepEqual(parseFileListing('nope'), []);
    assert.deepEqual(parseFileListing({}), []);
  });
});

describe('orderByEffectiveDate', () => {
  it('never serves a timetable that is not in force yet', () => {
    // 01082026 is the newest entry but takes effect in two days.
    const ordered = orderByEffectiveDate(parseFileListing(listing), Date.UTC(2026, 6, 30));

    assert.equal(iso(ordered[0].effectiveDate), '2026-07-25');
    assert.deepEqual(
      ordered.map((entry) => iso(entry.effectiveDate)),
      ['2026-07-25', '2026-07-18', '2026-07-13', '2026-08-01'],
    );
  });

  it('rolls onto the future snapshot once it takes effect', () => {
    const ordered = orderByEffectiveDate(parseFileListing(listing), Date.UTC(2026, 7, 1));
    assert.equal(iso(ordered[0].effectiveDate), '2026-08-01');
  });

  it('keeps undated entries ahead of future-dated ones', () => {
    const ordered = orderByEffectiveDate(
      [
        { name: 'future', effectiveDate: Date.UTC(2030, 0, 1) },
        { name: 'undated', effectiveDate: null },
      ],
      Date.UTC(2026, 6, 30),
    );
    assert.deepEqual(
      ordered.map((entry) => entry.name),
      ['undated', 'future'],
    );
  });
});

describe('describePayload', () => {
  // Printed to the log when the parser finds nothing, so that the next
  // production log says what the payload actually looks like instead of
  // needing someone to curl the endpoint by hand.
  it('summarises an object without dumping all of it', () => {
    const described = describePayload({ files: [{ nazwa: 'a' }], total: 1 });
    assert.match(described, /keys \[files, total\]/);
    assert.ok(described.length < 500);
  });

  it('handles arrays and non-objects', () => {
    assert.equal(describePayload([1, 2, 3]), 'array of 3');
    assert.equal(describePayload(null), 'null');
    assert.equal(describePayload('text'), 'string');
  });
});

describe('pickZipResources', () => {
  it('accepts extensionless zip endpoints', () => {
    // The shape that broke the old filter: no .zip anywhere in the path.
    assert.deepEqual(
      pickZipResources([
        { url: 'https://open-data.cui.wroclaw.pl/hdb/download/119/', format: 'ZIP', name: 'GTFS' },
      ]),
      ['https://open-data.cui.wroclaw.pl/hdb/download/119/'],
    );
  });

  it('ranks GTFS resources ahead of other archives', () => {
    const urls = pickZipResources([
      { url: 'https://x.pl/other', format: 'zip', name: 'something else' },
      { url: 'https://x.pl/gtfs', format: 'zip', name: 'rozklad GTFS' },
    ]);
    assert.equal(urls[0], 'https://x.pl/gtfs');
  });

  it('rejects the XML timetable, which also ships zipped', () => {
    assert.deepEqual(
      pickZipResources([{ url: 'https://x.pl/xml.zip', format: 'zip', name: 'rozklad XML' }]),
      [],
    );
  });

  it('tolerates junk input', () => {
    assert.deepEqual(pickZipResources(undefined), []);
    assert.deepEqual(pickZipResources('nope'), []);
    assert.deepEqual(pickZipResources([null, { url: 'ftp://x' }, {}]), []);
  });
});
