import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BADGE_GROW_SELECTED,
  BADGE_HEIGHT,
  badgeWidthFor,
  headingBucket,
  outlineDistance,
  vehicleMarkerGeometry,
} from '../src/lib/vehicle-marker.ts';

/** The finger-sized floor the surfaces pass in. */
const MIN_BOX = 44;

describe('headingBucket', () => {
  // Invariant 20: a marker redraws on every degree of GPS jitter unless the
  // heading is bucketed. Both surfaces bucket to 15°, and the bucket is what
  // the appearance is keyed on — so it has to be what the rotation uses too.
  it('buckets to 15 degrees', () => {
    assert.equal(headingBucket(0), 0);
    assert.equal(headingBucket(7), 0);
    assert.equal(headingBucket(8), 1);
    assert.equal(headingBucket(15), 1);
    assert.equal(headingBucket(90), 6);
  });

  it('wraps the top of the circle back onto zero', () => {
    // 353° rounds to bucket 24, which is bucket 0 — north, not a 25th bucket.
    assert.equal(headingBucket(360), 0);
    assert.equal(headingBucket(353), 0);
    assert.equal(headingBucket(352), 23);
  });

  it('has no bucket for a heading the feed did not give', () => {
    for (const value of [null, undefined, Number.NaN]) {
      assert.equal(headingBucket(value), null);
    }
  });

  it('holds jitter inside one bucket', () => {
    // A vehicle wobbling either side of a heading must not redraw; only a
    // crossing into the neighbouring bucket may.
    const buckets = new Set([88, 89, 90, 91, 92].map((h) => headingBucket(h)));
    assert.equal(buckets.size, 1, 'five degrees of jitter should be one bucket');
  });
});

describe('badgeWidthFor', () => {
  it('widens with the line number so long labels still fit', () => {
    assert.ok(badgeWidthFor('4') <= badgeWidthFor('123'));
    assert.ok(badgeWidthFor('123') <= badgeWidthFor('1234'));
  });

  it('gives the same width to every label of the same length', () => {
    assert.equal(badgeWidthFor('4'), badgeWidthFor('A'));
    assert.equal(badgeWidthFor('112'), badgeWidthFor('245'));
  });
});

describe('vehicleMarkerGeometry', () => {
  it('grows a selected badge on both axes', () => {
    const plain = vehicleMarkerGeometry('4', false, false, 90, MIN_BOX);
    const selected = vehicleMarkerGeometry('4', false, true, 90, MIN_BOX);

    assert.equal(selected.badgeWidth - plain.badgeWidth, BADGE_GROW_SELECTED * 2);
    assert.equal(selected.badgeHeight - plain.badgeHeight, BADGE_GROW_SELECTED * 2);
    assert.equal(plain.badgeHeight, BADGE_HEIGHT);
  });

  it('gives a tram square corners and a bus a full round end', () => {
    const tram = vehicleMarkerGeometry('4', true, false, 90, MIN_BOX);
    const bus = vehicleMarkerGeometry('4', false, false, 90, MIN_BOX);

    assert.ok(tram.badgeRadius < tram.badgeHeight / 2, 'a tram badge is a rounded rectangle');
    assert.equal(bus.badgeRadius, bus.badgeHeight / 2, 'a bus badge is a stadium');
  });

  it('never returns a box below the finger-sized floor', () => {
    // The box is the hit target on the native surface; a badge-sized one takes
    // taps meant for its neighbours at a busy stop.
    for (const line of ['4', '123', '1234']) {
      for (const heading of [null, 0, 45, 200]) {
        const { boxWidth, boxHeight } = vehicleMarkerGeometry(
          line,
          false,
          false,
          heading,
          MIN_BOX,
        );
        assert.ok(boxWidth >= MIN_BOX, `${line} @ ${heading} was ${boxWidth} wide`);
        assert.ok(boxHeight >= MIN_BOX, `${line} @ ${heading} was ${boxHeight} tall`);
      }
    }
  });

  it('is identical for two headings in the same bucket', () => {
    // What the surfaces key on is the bucket, so the geometry must not vary
    // within one — otherwise the drawn rotation and the cache key disagree.
    assert.deepEqual(
      vehicleMarkerGeometry('4', false, false, 88, MIN_BOX),
      vehicleMarkerGeometry('4', false, false, 92, MIN_BOX),
    );
  });
});

describe('outlineDistance', () => {
  it('measures the flat edges of a rounded rectangle', () => {
    // Straight out along +x from the centre of a 20×12 badge (half-extents
    // 10 and 6, corner radius 3) leaves through the flat right edge at 10.
    assert.ok(Math.abs(outlineDistance(1, 0, 10, 6, 3) - 10) < 1e-9);
    assert.ok(Math.abs(outlineDistance(0, 1, 10, 6, 3) - 6) < 1e-9);
  });

  it('cuts the corner shorter than a square one would', () => {
    // Only a ray that actually leaves through the corner arc is shortened. At
    // 45° a 20×12 badge is still exiting through its flat top edge, so the
    // radius makes no difference there — 30° is inside the arc, and is where
    // the rounding shows.
    const radians = (30 * Math.PI) / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);

    const rounded = outlineDistance(ux, uy, 10, 6, 3);
    const square = outlineDistance(ux, uy, 10, 6, 0);
    assert.ok(rounded < square, `rounded ${rounded} should be under square ${square}`);
  });

  it('leaves a ray through a flat edge untouched by the corner radius', () => {
    // The complement of the case above, so the two together say where the arc
    // begins rather than only that it exists somewhere.
    const diagonal = Math.SQRT1_2;
    assert.equal(
      outlineDistance(diagonal, diagonal, 10, 6, 3),
      outlineDistance(diagonal, diagonal, 10, 6, 0),
    );
  });

  it('is symmetric across both axes', () => {
    for (const [ux, uy] of [
      [0.6, 0.8],
      [0.28, 0.96],
    ]) {
      const base = outlineDistance(ux, uy, 10, 6, 3);
      assert.ok(Math.abs(outlineDistance(-ux, uy, 10, 6, 3) - base) < 1e-9);
      assert.ok(Math.abs(outlineDistance(ux, -uy, 10, 6, 3) - base) < 1e-9);
      assert.ok(Math.abs(outlineDistance(-ux, -uy, 10, 6, 3) - base) < 1e-9);
    }
  });
});
