'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const APP_SPREAD = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'stop-spread.ts');
const APP_MAP_HTML = path.join(__dirname, '..', '..', 'wroclive', 'src', 'lib', 'map-html.ts');
const APP_NATIVE_MAP = path.join(
  __dirname, '..', '..', 'wroclive', 'src', 'components', 'native-map.tsx',
);

/**
 * Lift a function out of a file so it can actually be run.
 *
 * The Leaflet page is a template string inside a TypeScript module and cannot
 * be imported from here, which is exactly why its copy of `spreadStops()` is
 * worth running rather than reading: the numbers below are the description in
 * `stop-spread.ts` restated as assertions, and they hold the copy to it.
 */
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

/** Read `const NAME = <number>` out of a source file as text. */
function readConstant(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const match = new RegExp(`(?:export |var )?(?:const )?${name} = (-?[0-9.e-]+)`).exec(source);
  assert.ok(match, `${name} not found in ${path.basename(file)}`);
  return Number(match[1]);
}

const GAP = readConstant(APP_SPREAD, 'STOP_SPREAD_GAP');
const MAX_METERS = readConstant(APP_SPREAD, 'STOP_SPREAD_MAX_METERS');

/** Metres per pixel in Web Mercator at Wrocław's latitude, by zoom level. */
const metersPerPixel = (zoom) =>
  (40075016.686 * Math.cos((51.108 * Math.PI) / 180)) / 2 ** (zoom + 8);

/** Every pairwise distance in a placement, so a pile can be checked as a whole. */
function separations(points) {
  const gaps = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      gaps.push(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return gaps;
}

/**
 * Stops whose dots land on the same pixels.
 *
 * A tram stop and the bus stop sharing its kerb are two GTFS records metres
 * apart. Drawn where they belong, the second dot is underneath the first and no
 * tap reaches it — the stop is on the map and its departures cannot be opened,
 * at any zoom, because both dots stay the same size as the map grows.
 */
describe('stop dot spreading', () => {
  const spreadStops = readFunction(APP_MAP_HTML, 'spreadStops');
  const street = metersPerPixel(17);

  it('pulls two stops on one coordinate far enough apart to tap', () => {
    const placed = spreadStops(
      [{ x: 200, y: 300 }, { x: 200, y: 300 }],
      GAP,
      MAX_METERS,
      street,
    );

    assert.ok(
      separations(placed)[0] >= GAP - 1e-9,
      `two coincident stops ended up ${separations(placed)[0].toFixed(1)}px apart`,
    );
    // …by both giving way, not by dragging one of them off on its own.
    for (const point of placed) {
      assert.ok(Math.abs(Math.hypot(point.x - 200, point.y - 300) - GAP / 2) < 1e-3);
    }
  });

  it('keeps a pile of three tappable, one dot each', () => {
    const placed = spreadStops(
      [{ x: 100, y: 100 }, { x: 103, y: 98 }, { x: 99, y: 104 }],
      GAP,
      MAX_METERS,
      street,
    );
    for (const gap of separations(placed)) {
      assert.ok(gap >= GAP - 1e-9, `a pile of three left dots ${gap.toFixed(1)}px apart`);
    }
  });

  /**
   * The fan may not become a claim about where a stop is. Forty metres is a
   * street with an island platform in it; further than that and the dot is
   * pointing at somewhere else entirely.
   */
  it('never moves a dot further than a stop may be drawn from its kerb', () => {
    for (const zoom of [13, 14, 15, 16, 17, 18]) {
      const scale = metersPerPixel(zoom);
      const points = [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ];
      const placed = spreadStops(points, GAP, MAX_METERS, scale);
      placed.forEach((point, index) => {
        const moved = Math.hypot(point.x - points[index].x, point.y - points[index].y) * scale;
        assert.ok(
          moved <= MAX_METERS + 1e-6,
          `zoom ${zoom}: a dot moved ${moved.toFixed(0)}m from its stop`,
        );
      });
    }
  });

  /**
   * Stops crowd together along a street as the map zooms out, and the allowance
   * shrinks in step: what a rider sees there is the same street, nudged. What
   * they must never see is it rearranged — the dots stay in the order they run
   * in, and none of them changes sides.
   */
  it('keeps a street a street as it crowds together', () => {
    const district = metersPerPixel(15);
    // Consecutive stops 60m apart: two stops, not two platforms, and already
    // closer than a fingertip on screen.
    const spacing = 60 / district;
    assert.ok(spacing < GAP, 'the fixture no longer overlaps on screen');

    const points = [0, 1, 2, 3, 4, 5].map((index) => ({ x: index * spacing, y: 0 }));
    const placed = spreadStops(points, GAP, MAX_METERS, district);

    for (let i = 1; i < placed.length; i++) {
      assert.ok(placed[i - 1].x < placed[i].x, 'two stops on a street swapped places');
    }
    placed.forEach((point, index) => {
      const moved = Math.hypot(point.x - points[index].x, point.y - points[index].y) * district;
      assert.ok(moved <= MAX_METERS + 1e-6, `a stop on the street moved ${moved.toFixed(0)}m`);
    });
  });

  it('leaves a stop standing on its own exactly where it is', () => {
    const points = [{ x: 10, y: 10 }, { x: 400, y: 380 }, { x: 402, y: 380 }];
    const placed = spreadStops(points, GAP, MAX_METERS, street);
    assert.deepEqual(placed[0], points[0]);
  });

  /**
   * A rider picks the platform by which side of the street it is on, so the fan
   * has to keep the pile's bearings: the northern record stays the northern dot
   * and the eastern one stays east.
   */
  it('keeps which stop is which way round', () => {
    const north = { x: 200, y: 297 };
    const south = { x: 200, y: 303 };
    const placed = spreadStops([north, south], GAP, MAX_METERS, street);
    assert.ok(placed[0].y < placed[1].y, 'the northern stop came out south of the other');

    const east = { x: 203, y: 300 };
    const west = { x: 197, y: 300 };
    const sideways = spreadStops([east, west], GAP, MAX_METERS, street);
    assert.ok(sideways[0].x > sideways[1].x, 'the eastern stop came out west of the other');
  });

  /**
   * Every frame re-runs this. A fan that depends on anything but the input
   * order rotates the pile under the rider's finger on each pan.
   */
  it('places the same stops the same way every time', () => {
    const points = [
      { x: 50, y: 50 },
      { x: 52, y: 51 },
      { x: 51, y: 49 },
      { x: 300, y: 120 },
    ];
    const once = spreadStops(points, GAP, MAX_METERS, street);
    assert.deepEqual(spreadStops(points, GAP, MAX_METERS, street), once);
    // The input is untouched, so the caller can compare the two and tell which
    // dots actually moved.
    assert.deepEqual(points[0], { x: 50, y: 50 });
  });

  it('answers for a degenerate input rather than throwing', () => {
    assert.deepEqual(spreadStops([], GAP, MAX_METERS, street), []);
    assert.deepEqual(spreadStops([{ x: 1, y: 2 }], GAP, MAX_METERS, street), [{ x: 1, y: 2 }]);
    // A surface that has not been measured yet reports no scale at all.
    const pair = [{ x: 1, y: 2 }, { x: 1, y: 2 }];
    assert.deepEqual(spreadStops(pair, GAP, MAX_METERS, 0), pair);
  });

  /**
   * Invariant 19's rule, one layer down: both surfaces draw the same map, and
   * this is the one piece of it the Leaflet page cannot import. The page's copy
   * is what the tests above run; these two checks are what keep it a copy.
   */
  it('is one rule shared by both map surfaces', () => {
    const page = fs.readFileSync(APP_MAP_HTML, 'utf8');
    const spread = fs.readFileSync(APP_SPREAD, 'utf8');
    const native = fs.readFileSync(APP_NATIVE_MAP, 'utf8');

    // The page interpolates the authority's constants instead of restating
    // them, so the two can never drift apart by a number.
    assert.match(page, /var STOP_SPREAD_GAP = \$\{STOP_SPREAD_GAP\};/);
    assert.match(page, /var STOP_SPREAD_MAX_METERS = \$\{STOP_SPREAD_MAX_METERS\};/);
    assert.match(page, /import \{ STOP_SPREAD_GAP, STOP_SPREAD_MAX_METERS \} from '\.\/stop-spread'/);
    // …and its copy of the solver says where the original lives.
    assert.match(page, /stop-spread\.ts/);

    // The solver's own working constants live inside it on both sides, so they
    // are compared rather than trusted.
    assert.equal(readConstant(APP_MAP_HTML, 'PASSES'), readConstant(APP_SPREAD, 'PASSES'));
    assert.equal(readConstant(APP_MAP_HTML, 'COINCIDENT'), readConstant(APP_SPREAD, 'COINCIDENT'));
    for (const source of [page, spread]) {
      assert.match(source, /GOLDEN_ANGLE = Math\.PI \* \(3 - Math\.sqrt\(5\)\)/);
    }

    // The native surface has a build step and imports the real thing.
    assert.match(native, /from '@\/lib\/stop-spread'/);
    assert.match(native, /spreadStops\(/);
  });

  /**
   * The dot is what a tap has to reach. The Leaflet page's stop icon is a
   * 104x56 box — room for a two-line name — and Leaflet makes all of it
   * interactive, so a stop was taking every tap within half a name's width of
   * itself: fanning the dots apart changed nothing, because the box they were
   * fanned out of still covered them.
   */
  it('lets a stop marker take taps on its dot and its name, not its box', () => {
    const page = fs.readFileSync(APP_MAP_HTML, 'utf8');
    assert.match(
      page,
      /\.leaflet-marker-icon\.stop-marker \{[^}]*pointer-events: none;/,
      'the stop icon box still swallows taps meant for its neighbours',
    );
    // Both of the marker's own shapes still take one — a tap on a stop's name
    // opens the same board its dot does. (The rules carry interpolated colours,
    // so the block is matched by length rather than up to its closing brace.)
    assert.match(page, /\.stop__dot \{[\s\S]{0,400}?pointer-events: auto;/);
    assert.match(page, /\.stop__name \{[\s\S]{0,600}?pointer-events: auto;/);
  });
});
