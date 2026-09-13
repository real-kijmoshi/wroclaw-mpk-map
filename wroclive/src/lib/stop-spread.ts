/**
 * Pulling stop dots that land on each other apart, in one place.
 *
 * A tram stop and the bus stop serving the same kerb are two separate GTFS
 * records metres apart — the pair on Nowowiejska is the case this was written
 * for. Drawn honestly, the two dots sit on top of each other and only one of
 * them can be tapped: whichever the platform happens to put on top takes every
 * tap, so the other stop's departure board is unreachable. Zooming in does not
 * help, because both dots stay the same size as the map grows.
 *
 * The rule is one sentence. **Dots closer together than `gap` are pushed apart
 * until they clear it, and no dot is ever drawn more than
 * `STOP_SPREAD_MAX_METERS` from the stop it belongs to.**
 *
 * The second half is what keeps this a drawing decision rather than a claim
 * about where a stop is, and it is also what makes the first half behave at
 * every scale without a zoom threshold anywhere: at street zoom that allowance
 * is tens of points and a pile fans out properly; at district zoom it is a
 * pixel or two, so a field of dots is nudged imperceptibly instead of being
 * rearranged into something the city does not look like.
 *
 * Pushing pairs apart, rather than placing a cluster on a ring, is deliberate.
 * A ring has to decide what a cluster *is*, and two clusters that each decide
 * separately push their members into each other — observed doing exactly that
 * on the four platforms of one junction. Pairs need no such decision: every dot
 * moves the least that clears its neighbours, which also leaves the pile's
 * bearings intact, and a rider picks a platform by which side of the street it
 * is on.
 *
 * Both map surfaces run this pass. This module is the authority and
 * `native-map.tsx` imports it; the Leaflet page in `map-html.ts` has no build
 * step and carries a copy that names this file, the same arrangement the
 * vehicle marker's solver has. `test/map.test.js`'s neighbour,
 * `test/stop-spread.test.js`, lifts that copy back out and runs it against the
 * rule above rather than trusting it.
 */

/**
 * How far apart two dots have to end up before both can be tapped.
 *
 * The native dot's box — its hit target — is 20pt, so two points of clearance
 * puts a fingertip inside one box and no other. The Leaflet page's dot is
 * smaller than its box and needs less, but a marker that moves differently on
 * the two surfaces is a bug report nobody can reproduce.
 */
export const STOP_SPREAD_GAP = 22;

/**
 * How far a stop's dot may be drawn from the coordinate it belongs to.
 *
 * Forty metres is the width of a street with an island platform in it: the
 * tram stop and the bus stop that share it, the two kerbs of one crossing.
 * Beyond that a dot stops being a location and becomes a hint, and a rider
 * walking to the wrong side of a junction has been misled by the map.
 */
export const STOP_SPREAD_MAX_METERS = 40;

/** A position in whatever screen units the caller measures in (points, pixels). */
export type SpreadPoint = { x: number; y: number };

/**
 * Push overlapping dots apart, and leave everything else where it is.
 *
 * Positions come in and go out in screen space, in the caller's own units, so a
 * surface only has to know how to project a coordinate and what a unit is worth
 * in metres. The returned array is parallel to the input, and the input is not
 * touched — a caller can compare the two to see which dots actually moved.
 *
 * Deliberately free of imports and of module state: the Leaflet page carries
 * this function as text, and `test/stop-spread.test.js` lifts it back out and
 * runs it.
 */
export function spreadStops(
  points: readonly SpreadPoint[],
  gap: number,
  maxOffsetMeters: number,
  metersPerPoint: number,
): SpreadPoint[] {
  /**
   * How many times the pass goes round.
   *
   * Each one clears the pairs that are still too close, and a push can create a
   * new overlap with a third dot, so it is worth repeating — but it converges
   * in two or three rounds on anything a stop layer actually contains, and what
   * is left after twelve is a crowd the maximum offset was never going to
   * untangle. Declared here, with the two below, so this function depends on
   * nothing outside itself — that is what lets the page's copy be lifted out
   * and run.
   */
  const PASSES = 12;

  /** Two points closer than this are the same point and have no direction. */
  const COINCIDENT = 1e-6;

  /** The golden angle: successive multiples of it never fall on each other. */
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  const placed = points.map((point) => ({ x: point.x, y: point.y }));
  if (placed.length < 2 || !(gap > 0) || !(metersPerPoint > 0) || !(maxOffsetMeters > 0)) {
    return placed;
  }

  const maxOffset = maxOffsetMeters / metersPerPoint;

  // Which stops could ever be in each other's way. No dot moves further than
  // `maxOffset`, so a pair that starts further apart than that twice over plus
  // the gap cannot meet however the rest of the layer shuffles — and every pass
  // below then walks a handful of neighbours instead of a hundred stops squared,
  // which is what a crowded district zoom hands this function.
  const horizon = gap + 2 * maxOffset;
  const pairs: number[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y) >= horizon) continue;
      pairs.push(i, j);
    }
  }
  if (!pairs.length) return placed;

  // Two records on one coordinate have no direction to be pushed along, so they
  // are given one first: a turn of the golden angle per stop, which is stable
  // between frames and never lines two of them up.
  for (let pair = 0; pair < pairs.length; pair += 2) {
    const [i, j] = [pairs[pair], pairs[pair + 1]];
    if (Math.hypot(placed[j].x - placed[i].x, placed[j].y - placed[i].y) > COINCIDENT) continue;
    const angle = GOLDEN_ANGLE * j;
    placed[j] = {
      x: placed[j].x + COINCIDENT * Math.cos(angle),
      y: placed[j].y + COINCIDENT * Math.sin(angle),
    };
  }

  for (let pass = 0; pass < PASSES; pass++) {
    let pushed = false;

    for (let pair = 0; pair < pairs.length; pair += 2) {
      const [i, j] = [pairs[pair], pairs[pair + 1]];
      const dx = placed[j].x - placed[i].x;
      const dy = placed[j].y - placed[i].y;
      const distance = Math.hypot(dx, dy);
      if (distance >= gap) continue;

      // Half the shortfall each, along the line they already lie on: the one
      // to the north stays the northern dot.
      const step = (gap - distance) / 2;
      const ux = dx / distance;
      const uy = dy / distance;
      placed[i] = { x: placed[i].x - ux * step, y: placed[i].y - uy * step };
      placed[j] = { x: placed[j].x + ux * step, y: placed[j].y + uy * step };
      pushed = true;
    }

    if (!pushed) break;

    // Hauled back to within sight of its own stop after every round, so the
    // pushes of the next one start from somewhere a dot is allowed to be.
    for (let i = 0; i < placed.length; i++) {
      const dx = placed[i].x - points[i].x;
      const dy = placed[i].y - points[i].y;
      const offset = Math.hypot(dx, dy);
      if (offset <= maxOffset) continue;
      placed[i] = {
        x: points[i].x + (dx / offset) * maxOffset,
        y: points[i].y + (dy / offset) * maxOffset,
      };
    }
  }

  // A dot that was never in anyone's way is handed back exactly as it came in:
  // a surface that redraws on every pan can then tell a stop that has to move
  // from one that does not.
  for (let i = 0; i < placed.length; i++) {
    if (Math.hypot(placed[i].x - points[i].x, placed[i].y - points[i].y) > COINCIDENT) continue;
    placed[i] = { x: points[i].x, y: points[i].y };
  }

  return placed;
}
