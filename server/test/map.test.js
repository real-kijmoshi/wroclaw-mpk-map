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
const APP_MAP_HTML = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'map-html.ts');
const APP_PALETTE = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'lines.ts');
const APP_MARKER = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'vehicle-marker.ts');

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

/**
 * Read `const NAME = <number>` out of a source file as text.
 *
 * Same reasoning as `readPalette`: this page cannot import the app's module,
 * and the app's module is TypeScript, so both are read as text — which is what
 * makes comparing them a real check rather than a circular one.
 */
function readConstants(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const found = {};
  for (const name of names) {
    const match = new RegExp(`(?:export )?const ${name} = (-?[0-9.]+)`).exec(source);
    assert.ok(match, `${name} not found in ${path.basename(file)}`);
    found[name] = Number(match[1]);
  }
  return found;
}

/** The three badge widths, in order, out of whichever form the file writes them in. */
function readBadgeWidths(file, functionName) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(functionName);
  assert.notEqual(start, -1, `${functionName} not found in ${path.basename(file)}`);
  const widths = [...source.slice(start, start + 400).matchAll(/\b(\d\d)\b/g)]
    .map(([, value]) => Number(value))
    .filter((value) => value >= 20);
  assert.equal(widths.length >= 3, true, `${functionName} parsed as ${widths}`);
  return widths.slice(0, 3);
}

/**
 * Signed distance to a rounded rectangle — negative inside, zero on the
 * outline. Deliberately a different formula from the ray intersection it is
 * used to check, so the two cannot be wrong in the same way.
 */
function distanceToOutline(px, py, a, b, r) {
  const qx = Math.abs(px) - (a - r);
  const qy = Math.abs(py) - (b - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Lift a function out of the page's inline script so it can actually be run. */
function readFunction(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found in ${path.basename(file)}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) {
      return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
    }
  }
  throw new assert.AssertionError({ message: `${name} is not a complete function` });
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
   * The vehicle marker is the app's marker (invariant 19), and its geometry
   * lives in `wroclive/src/lib/vehicle-marker.ts`. This page has no build step
   * and cannot import it, so it carries a hand copy — and a hand copy of the
   * app's values is exactly what drifted with the palette. Compare them.
   */
  it('draws the vehicle marker with the app’s geometry', () => {
    const names = [
      'BADGE_HEIGHT',
      'BADGE_RADIUS_TRAM',
      'BADGE_GROW_SELECTED',
      'TAIL_LENGTH',
      'TAIL_OUTLINE',
      'TAIL_SINK',
      'DOT_SIZE',
      'DOT_TAIL_LENGTH',
      'DOT_TAIL_OUTLINE',
      'DOT_TAIL_SINK',
    ];
    assert.deepEqual(readConstants(MAP_HTML, names), readConstants(APP_MARKER, names));

    // The city-zoom dot is sized by how many vehicles its cell stands for, and
    // the steps have to be the same four everywhere or the two clients disagree
    // about what a busy street looks like.
    const densities = (file) => {
      const source = fs.readFileSync(file, 'utf8');
      const match = /DENSITY_SIZES = (\[[^\]]*\])/.exec(source);
      assert.ok(match, `DENSITY_SIZES not found in ${path.basename(file)}`);
      return JSON.parse(match[1]);
    };
    assert.deepEqual(densities(MAP_HTML), densities(APP_MARKER));
    assert.deepEqual(
      readBadgeWidths(MAP_HTML, 'badgeWidth'),
      readBadgeWidths(APP_MARKER, 'badgeWidthFor'),
    );

    // The tail's own size lives in the CSS here rather than in a constant, so
    // it is checked against the module's numbers directly.
    const { TAIL_HALF_BASE, TAIL_LENGTH, TAIL_OUTLINE } = readConstants(APP_MARKER, [
      'TAIL_HALF_BASE',
      'TAIL_LENGTH',
      'TAIL_OUTLINE',
    ]);
    const html = readMap();
    assert.ok(
      html.includes(`border-width: 0 ${TAIL_HALF_BASE}px ${TAIL_LENGTH}px`),
      'the tinted tail does not match the app’s size',
    );
    assert.ok(
      html.includes(
        `border-width: 0 ${TAIL_HALF_BASE + TAIL_OUTLINE}px ${TAIL_LENGTH + TAIL_OUTLINE}px`,
      ),
      'the tail’s white keyline does not match the app’s size',
    );

    const { DOT_TAIL_HALF_BASE, DOT_TAIL_LENGTH, DOT_TAIL_OUTLINE } = readConstants(APP_MARKER, [
      'DOT_TAIL_HALF_BASE',
      'DOT_TAIL_LENGTH',
      'DOT_TAIL_OUTLINE',
    ]);
    assert.ok(
      html.includes(`border-width: 0 ${DOT_TAIL_HALF_BASE}px ${DOT_TAIL_LENGTH}px`),
      'the dot’s tail does not match the app’s size',
    );
    assert.ok(
      html.includes(
        `border-width: 0 ${DOT_TAIL_HALF_BASE + DOT_TAIL_OUTLINE}px ${DOT_TAIL_LENGTH + DOT_TAIL_OUTLINE}px`,
      ),
      'the dot tail’s white keyline does not match the app’s size',
    );
  });

  /**
   * The badge and its tail are one shape only if the tail actually touches the
   * badge at *every* heading — and a badge is a rounded rectangle, 12px from
   * its centre due north and 19px due east. The arrow this replaced orbited at
   * one fixed radius, which is why it floated off the short sides and buried
   * itself in the long ones. `outlineDistance()` is what removed that, so what
   * it returns has to land on the outline, checked here against an independent
   * distance function.
   */
  it('puts the marker’s tail on the badge outline at every heading', () => {
    const outlineDistance = readFunction(MAP_HTML, 'outlineDistance');

    // A tram (square shoulders), a bus (a pill), and the widest badge there is.
    for (const [a, b, r] of [[15, 12, 6], [15, 12, 12], [19, 12, 6], [21, 14, 14]]) {
      for (let bucket = 0; bucket < 24; bucket++) {
        const radians = (bucket * 15 * Math.PI) / 180;
        const ux = Math.sin(radians);
        const uy = -Math.cos(radians);
        const distance = outlineDistance(ux, uy, a, b, r);
        const off = distanceToOutline(distance * ux, distance * uy, a, b, r);
        assert.ok(
          Math.abs(off) < 1e-9,
          `${bucket * 15}° on ${a}×${b} r${r}: tail sits ${off.toFixed(3)}px off the outline`,
        );
      }
    }
  });

  /**
   * OpenStreetMap requires attribution, and the control was switched off
   * outright — the tile layer declared it, and nothing displayed it.
   */
  it('leaves map attribution switched on', () => {
    const html = readMap();
    assert.doesNotMatch(html, /attributionControl:\s*false/);
    assert.match(html, /attribution:\s*'[^']*OpenStreetMap/);
    // The licence wants the credit to link to the copyright page, not just
    // name the project.
    assert.match(html, /openstreetmap\.org\/copyright/);
  });

  /**
   * The basemap comes from OpenStreetMap's own tile servers, on the single
   * hostname their usage policy asks for: {s}-style sharding costs a
   * connection per host over HTTP/2 rather than saving one.
   */
  it('serves the basemap from tile.openstreetmap.org, unsharded', () => {
    const html = readMap();
    const tiles = /L\.tileLayer\(\s*'([^']+)'/.exec(html);
    assert.ok(tiles, 'no tile layer URL found');
    assert.equal(tiles[1], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.doesNotMatch(tiles[1], /\{s\}/, 'the tile URL is sharded across subdomains');
  });

  /**
   * OSM publishes one raster style and it is light, so dark mode is a filter
   * rather than a second tile URL — and the filter belongs to the tile pane
   * alone. Over the whole map it inverts the line palette with the basemap: a
   * red tram badge comes out cyan, which is invariant 11 undone at render time.
   */
  it('filters the tiles for dark mode, and only the tiles', () => {
    const html = readMap();
    assert.match(html, /\.leaflet-tile-pane\s*\{\s*filter:\s*var\(--tile-filter\);\s*\}/);

    // Defined light, redefined dark: a filter that only exists inside the
    // media query leaves the variable unresolved in light mode.
    assert.match(html, /--tile-filter:\s*none;/);
    assert.match(html, /--tile-filter:\s*invert\(1\)/);

    // The tile pane is the only selector allowed to name it. Anything wider —
    // `.leaflet-container`, `#map`, `body` — holds the marker panes too.
    const carriers = [...html.matchAll(/([^{}\n]+)\{[^}]*var\(--tile-filter\)[^}]*\}/g)].map(
      ([, selector]) => selector.trim(),
    );
    assert.deepEqual(carriers, ['.leaflet-tile-pane']);
  });

  /**
   * Invariant 19: this page and the app's Leaflet page are two readers of the
   * same design, and the basemap is one more thing that has to move together —
   * the app pointing at a retired provider is a blank map with no error.
   */
  it('uses the same tile source as the app page', () => {
    const appPage = fs.readFileSync(APP_MAP_HTML, 'utf8');
    const tiles = /L\.tileLayer\(\s*'([^']+)'/.exec(readMap());
    assert.ok(tiles, 'no tile layer URL found in the served page');
    assert.ok(
      appPage.includes(tiles[1]),
      `wroclive/src/lib/map-html.ts does not serve tiles from ${tiles[1]}`,
    );
    assert.match(appPage, /\.leaflet-tile-pane \{ filter: var\(--tile-filter\); \}/);
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
