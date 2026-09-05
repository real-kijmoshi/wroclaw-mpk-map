import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OFF_ROUTE_METERS,
  type Point,
  projectProgress,
  splitRoute,
} from '../src/lib/route-progress.ts';

/**
 * A straight run east along a Wrocław latitude. A degree of longitude here is
 * ~0.63 of a degree of latitude, which is exactly why the projection converts
 * to metres rather than working in degrees.
 */
const LAT = 51.1;
const LINE: Point[] = [
  [LAT, 17.0],
  [LAT, 17.01],
  [LAT, 17.02],
];

describe('projectProgress', () => {
  it('needs at least two points to have a route', () => {
    assert.equal(projectProgress([], LAT, 17.0), null);
    assert.equal(projectProgress([[LAT, 17.0]], LAT, 17.0), null);
  });

  it('projects a fix on the line onto the right segment', () => {
    const progress = projectProgress(LINE, LAT, 17.005);
    assert.ok(progress);
    assert.equal(progress.segmentIndex, 0);
    assert.ok(Math.abs(progress.fraction - 0.5) < 0.01, `fraction ${progress.fraction}`);
    assert.ok(progress.distanceMeters < 1, `on the line, got ${progress.distanceMeters}m`);
  });

  it('measures distance along the whole route, not just the segment', () => {
    const first = projectProgress(LINE, LAT, 17.005);
    const second = projectProgress(LINE, LAT, 17.015);
    assert.ok(first && second);
    assert.equal(second.segmentIndex, 1);
    // The second fix is one segment further on, so its along-distance must
    // exceed the first by roughly one segment length.
    const segment = second.alongMeters - first.alongMeters;
    assert.ok(segment > 600 && segment < 800, `one segment apart, got ${segment}m`);
  });

  it('reports the perpendicular distance for a fix beside the line', () => {
    // ~0.0009 degrees of latitude is about 100 m north of the route.
    const progress = projectProgress(LINE, LAT + 0.0009, 17.005);
    assert.ok(progress);
    assert.ok(
      progress.distanceMeters > 80 && progress.distanceMeters < 120,
      `expected ~100m, got ${progress.distanceMeters}m`,
    );
  });

  it('gives up on a fix that is clearly off the route', () => {
    // Far enough north that no segment is within OFF_ROUTE_METERS; the surface
    // then draws the route unsplit rather than snapping the vehicle to it.
    assert.equal(projectProgress(LINE, LAT + 0.05, 17.005), null);
  });

  it('still projects a fix just inside the off-route limit', () => {
    const inside = projectProgress(LINE, LAT + 0.0009, 17.005);
    assert.ok(inside, `${OFF_ROUTE_METERS}m is the limit; 100m must be inside it`);
  });

  it('clamps a fix just past the terminus to the last point', () => {
    // ~70 m beyond the end — a vehicle sitting at a terminus, within the
    // off-route limit. It projects onto the end of the final segment rather
    // than running off it.
    const progress = projectProgress(LINE, LAT, 17.021);
    assert.ok(progress);
    assert.equal(progress.segmentIndex, LINE.length - 2);
    assert.ok(Math.abs(progress.fraction - 1) < 1e-9, `fraction ${progress.fraction}`);
  });

  it('gives up once past the terminus by more than the off-route limit', () => {
    // Several kilometres beyond the end is not "at the terminus", and clamping
    // it there would draw the whole route as travelled.
    assert.equal(projectProgress(LINE, LAT, 17.09), null);
  });
});

describe('splitRoute', () => {
  it('shares the projected point so the two halves do not gap', () => {
    const progress = projectProgress(LINE, LAT, 17.005);
    assert.ok(progress);
    const { travelled, remaining } = splitRoute(LINE, progress);

    assert.deepEqual(
      travelled[travelled.length - 1],
      remaining[0],
      'the halves must meet at the same coordinate',
    );
  });

  it('keeps every original point across the two halves', () => {
    const progress = projectProgress(LINE, LAT, 17.005);
    assert.ok(progress);
    const { travelled, remaining } = splitRoute(LINE, progress);

    // Each half carries the shared projected point, so the totals overlap by
    // exactly one.
    assert.equal(travelled.length + remaining.length, LINE.length + 2);
    assert.deepEqual(travelled[0], LINE[0]);
    assert.deepEqual(remaining[remaining.length - 1], LINE[LINE.length - 1]);
  });
});
