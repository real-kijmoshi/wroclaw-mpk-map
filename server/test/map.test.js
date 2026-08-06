'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const { createApp } = require('../src/app');
const { GtfsStore } = require('../src/gtfs/store');
const { buildFixtureZip } = require('./fixtures/gtfs');

const MAP_HTML = path.join(__dirname, '..', 'views', 'map.html');
const LANDING_MAP_HTML = path.join(__dirname, '..', '..', 'landing', 'map.html');
const APP_PALETTE = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'lines.ts');

const readMap = () => fs.readFileSync(MAP_HTML, 'utf8');

/**
 * Pull a `name = { key: '#hex', ... }` table out of a source file as text.
 *
 * Neither file can be required from here — map.html is a page and lines.ts is
 * TypeScript importing react-native types — so both palettes are read the same
 * way, which is also what makes comparing them meaningful rather than circular.
 */
function readPalette(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(name);
  assert.notEqual(start, -1, `${name} not found in ${path.basename(file)}`);

  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  assert.ok(open !== -1 && close !== -1, `${name} is not an object literal`);

  const table = {};
  for (const [, key, value] of source
    .slice(open, close)
    .matchAll(/([A-Za-z]+)\s*:\s*['"](#[0-9A-Fa-f]{6})['"]/g)) {
    table[key] = value.toUpperCase();
  }

  assert.ok(Object.keys(table).length > 5, `${name} parsed as ${JSON.stringify(table)}`);
  return table;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

describe('browser map', () => {
  const gtfs = new GtfsStore();
  let server;
  let base;

  before(async () => {
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';

    const app = createApp({
      gtfs,
      vehicles: { status: {}, snapshot: { locations: [], count: 0, lastUpdated: null } },
      alerts: { status: { providers: [] }, getAlerts: () => [] },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  it('serves the page as HTML', async () => {
    const response = await fetch(`${base}/map`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /<title>MPK Wrocław/);
  });

  /**
   * landing/map.html is the same page served statically so the demo works
   * without the server hosting it. If the two diverge, /map fixes never reach
   * the landing copy — keep them byte-identical.
   */
  it('keeps the landing copy identical to the served page', () => {
    const landing = fs.readFileSync(LANDING_MAP_HTML, 'utf8');
    assert.equal(landing, readMap());
  });

  /**
   * The page carries its own copy of the line palette, and it drifted: it was
   * still serving the pre-2026 rainbow long after the app replaced it, which is
   * how white-on-#F8E71C survived there. Comparing the two tables is the only
   * thing that actually keeps invariant 17 true.
   */
  it('uses the same line palette as the app', () => {
    const page = readPalette(MAP_HTML, 'LINE_COLOR');
    const app = readPalette(APP_PALETTE, 'LINE_COLOR');
    assert.deepEqual(page, app);
  });

  /**
   * Invariant 11: every line colour is a background for white text, and the map
   * is read in the sunlight you are standing in. #F8E71C behind white sat at
   * about 1.4:1.
   */
  it('keeps every line colour readable behind white text', () => {
    for (const [category, colour] of Object.entries(readPalette(MAP_HTML, 'LINE_COLOR'))) {
      const ratio = contrast(colour, '#FFFFFF');
      assert.ok(ratio >= 4.5, `${category} (${colour}) is ${ratio.toFixed(2)}:1 against white`);
    }
  });

  /**
   * OpenStreetMap and CARTO both require attribution, and the control was
   * switched off outright — the tile layer declared it, and nothing displayed
   * it.
   */
  it('leaves map attribution switched on', () => {
    const html = readMap();
    assert.doesNotMatch(html, /attributionControl:\s*false/);
    assert.match(html, /attribution:\s*['"][^'"]*OpenStreetMap/);
  });

  /**
   * Invariant 7, on this client: /lines answers 503 while the feed is ingesting.
   * The page used to render categories straight out of `{error, state}`, so only
   * array-valued keys may reach the filter list.
   */
  it('never renders a non-array payload as line categories', () => {
    const html = readMap();
    const match = /if \(Array\.isArray\(value\)\) clean\[key\] = value;/.exec(html);
    assert.ok(match, 'the /lines payload is not filtered down to array-valued keys');
    assert.match(html, /response\.status === 503/);
  });

  /**
   * A tap on a stop reached the map's own click handler, which cleared the very
   * route the stop belonged to: the board opened and the line vanished.
   */
  it('stops marker taps from reaching the map click handler', () => {
    const html = readMap();
    const handlers = html.match(/L\.DomEvent\.stopPropagation\(event\)/g) ?? [];
    assert.ok(
      handlers.length >= 3,
      `expected the vehicle and stop handlers to stop propagation, found ${handlers.length}`,
    );
  });
});
