/**
 * The vehicle marker's geometry, in one place.
 *
 * A vehicle is **one shape**: a badge carrying the line number, with a
 * directional tail growing straight out of the badge's own outline on the
 * heading side. It replaced a badge and a chevron orbiting it at a fixed
 * 32pt radius — two objects the eye had to associate, inside a 64×64 box that
 * was nearly three times the area of anything drawn in it. That box was the
 * marker's hit target on the native surface, so a vehicle stole the taps meant
 * for its neighbours across half a centimetre of empty map.
 *
 * Fusing them is only convincing if the tail actually touches the badge at
 * *every* heading, and a badge is a rounded rectangle, not a circle: the
 * distance from its centre to its outline is 12pt due north and 19pt due east.
 * A tail on a fixed orbit either floats off the short sides or is buried in
 * the long ones. So the distance is solved per heading — `outlineDistance()`
 * is a ray/rounded-rect intersection — and the box is then sized to whatever
 * the rotated tail actually needs, which is how a marker that used to be 64pt
 * square is now roughly 44.
 *
 * The three surfaces (`native-map.tsx`, the Leaflet page in `map-html.ts`, and
 * `server/views/map.html`) all draw the same marker. This module is the
 * authority; `map-html.ts` interpolates these constants into the page it
 * generates, and `server/views/map.html` — which has no build step and cannot
 * import anything — carries a copy that names this file. Change a number here
 * and change it there.
 *
 * The marker described above is what `markerStyle: 'modern'` draws. The badge
 * and chevron it replaced are still selectable — see the classic block at the
 * bottom of this file — so both looks are geometry stated here rather than
 * numbers spread across the surfaces that draw them.
 */

/** Height of the badge body. The line number sets only its width. */
export const BADGE_HEIGHT = 24;

/** A tram's badge is square-shouldered; a bus's is a pill (radius = height/2). */
export const BADGE_RADIUS_TRAM = 6;

/**
 * How much bigger the selected vehicle's badge is, per side.
 *
 * The selection used to be `scale: 1.14` on the badge alone. A transform
 * scales the badge away from the tail that is supposed to be joined to it,
 * which is exactly the seam this marker exists to remove — so the badge grows
 * by real points instead, and the tail is re-solved against the grown outline.
 */
export const BADGE_GROW_SELECTED = 2;

/**
 * The tinted triangle: how far it stands off the badge, and how wide its base.
 *
 * `TAIL_SINK` of it is hidden behind the badge, so what a rider sees is the
 * difference — and at nine points against a 24pt badge that is a direction,
 * not the nub six points gave. Any longer and a fleet at a busy junction is
 * back to spikes crossing each other.
 */
export const TAIL_LENGTH = 12;
export const TAIL_HALF_BASE = 6.5;

/**
 * The white keyline around the tail, matching the badge's own 1.5pt border.
 *
 * Drawn as a second, larger triangle behind the tinted one — a coloured arrow
 * alone disappears over a road drawn in roughly that colour, and over
 * satellite imagery it disappears over everything.
 */
export const TAIL_OUTLINE = 2;

/**
 * How far the tail's base sits *inside* the badge outline.
 *
 * The tail is drawn behind the badge, so this much of it is hidden. Without
 * the overlap the two shapes meet on a mathematically exact line, which
 * antialiasing renders as a hairline gap on a rounded corner.
 */
export const TAIL_SINK = 3;

/** The badge width for a line number of this length. */
export function badgeWidthFor(line: string): number {
  const length = line.length;
  if (length <= 2) return 30;
  if (length === 3) return 34;
  return 38;
}

/**
 * Distance from the badge's centre to its outline, along a unit direction.
 *
 * The outline is a rounded rectangle with half-extents `a`,`b` and corner
 * radius `r`: the set of points exactly `r` away from the inner rectangle
 * `[-a+r, a-r] × [-b+r, b-r]`. A ray from the centre leaves it either through
 * a flat edge or through a corner arc, and which one is decided by where the
 * edge crossing lands. The corner case is the quadratic for a ray hitting a
 * circle of radius `r` centred on that corner.
 */
export function outlineDistance(ux: number, uy: number, a: number, b: number, r: number): number {
  const x = Math.abs(ux);
  const y = Math.abs(uy);
  const flatA = Math.max(0, a - r);
  const flatB = Math.max(0, b - r);

  // Out through a flat edge: the crossing has to fall on the straight part.
  if (x > 0) {
    const t = a / x;
    if (t * y <= flatB) return t;
  }
  if (y > 0) {
    const t = b / y;
    if (t * x <= flatA) return t;
  }

  // Out through a corner arc.
  const along = x * flatA + y * flatB;
  const gap = flatA * flatA + flatB * flatB - r * r;
  return along + Math.sqrt(Math.max(0, along * along - gap));
}

/**
 * A tail, at the size the thing it grows out of can carry.
 *
 * The badge's tail on a 12pt dot is a dart rather than a dot, so the dot tier
 * has its own, and both go through the same solver below.
 */
export type TailSpec = {
  length: number;
  halfBase: number;
  outline: number;
  sink: number;
};

export const BADGE_TAIL: TailSpec = {
  length: TAIL_LENGTH,
  halfBase: TAIL_HALF_BASE,
  outline: TAIL_OUTLINE,
  sink: TAIL_SINK,
};

/**
 * The dot tier's tail: narrower than the badge's, not just shorter.
 *
 * Scaled straight down it was 9pt wide against a 12pt dot, and a tail almost
 * as wide as the thing it grows out of is a blob rather than a direction — the
 * silhouette went lumpy at the diagonals, worst on the tram's square dot. What
 * carries at this size is a long, narrow point.
 */
export const DOT_TAIL_LENGTH = 8;
export const DOT_TAIL_HALF_BASE = 3.5;
export const DOT_TAIL_OUTLINE = 1.5;
export const DOT_TAIL_SINK = 2;

export const DOT_TAIL: TailSpec = {
  length: DOT_TAIL_LENGTH,
  halfBase: DOT_TAIL_HALF_BASE,
  outline: DOT_TAIL_OUTLINE,
  sink: DOT_TAIL_SINK,
};

/** The dot every vehicle gets at district zoom, where none of them are thinned. */
export const DOT_SIZE = 12;

/**
 * How big the one dot that survives a cell is, for the number it stands for.
 *
 * At city zoom a cell keeps a single marker and drops the rest, which draws
 * the shape of the network but says nothing about it: eight trams queued on
 * one junction looked exactly like one bus on an empty street. Sizing the
 * survivor by its cell's count is what makes zooming out mean *where the
 * network is busy* — the thing the tier is for.
 *
 * Four steps rather than a continuous scale, because the size is part of what
 * every surface keys its redraw on: a count that wanders between 3 and 4 every
 * poll would otherwise re-capture the marker every poll. Steps widen as they
 * go, since the difference between one vehicle and two matters and the
 * difference between eleven and twelve does not.
 */
export const DENSITY_SIZES = [7, 9, 11, 13];

export function dotSizeForDensity(count: number): number {
  if (count >= 8) return DENSITY_SIZES[3];
  if (count >= 4) return DENSITY_SIZES[2];
  if (count >= 2) return DENSITY_SIZES[1];
  return DENSITY_SIZES[0];
}

/** A dot is round for a bus and square-shouldered for a tram, at any size. */
export function dotRadiusFor(size: number, tram: boolean): number {
  return tram ? Math.max(2, Math.round(size * 0.25)) : size / 2;
}

export type MarkerBox = {
  /** The marker's box, which on the native surface is also its hit target. */
  boxWidth: number;
  boxHeight: number;
  /**
   * Where the tinted triangle's tip sits inside the box, before the box's
   * rotation layer turns it to the heading. `null` when the vehicle has no
   * heading yet and there is no tail to draw.
   */
  tailTop: number | null;
  /** The same, for the white triangle behind it. */
  outlineTop: number | null;
  /** The heading actually drawn: bucketed, so it matches the redraw key. */
  angle: number;
};

export type VehicleMarkerGeometry = MarkerBox & {
  badgeWidth: number;
  badgeHeight: number;
  badgeRadius: number;
};

export type DotMarkerGeometry = MarkerBox & {
  dotSize: number;
  dotRadius: number;
};

/**
 * Put a tail on an outline, and size the box to hold the result.
 *
 * The box has to contain the rotated tail — Android clips a marker to its own
 * bitmap — and it has to stay symmetric about the centre, or the 0.5/0.5
 * anchor no longer puts the marker on its coordinate. So the tail's three
 * corners go through the same rotation the drawing will apply and the largest
 * excursion on each axis wins.
 */
function place(
  a: number,
  b: number,
  r: number,
  bucket: number | null,
  tail: TailSpec,
  minBox: number,
): MarkerBox {
  if (bucket === null) {
    return {
      boxWidth: Math.max(Math.ceil(a) * 2, minBox),
      boxHeight: Math.max(Math.ceil(b) * 2, minBox),
      tailTop: null,
      outlineTop: null,
      angle: 0,
    };
  }

  const angle = bucket * 15;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // Screen axes: x right, y down, heading 0 = north = (0, -1).
  const base = outlineDistance(sin, -cos, a, b, r) - tail.sink;
  const tip = base + tail.length + tail.outline;
  const halfBase = tail.halfBase + tail.outline;

  let halfWidth = a;
  let halfHeight = b;
  for (const [px, py] of [
    [0, -tip],
    [-halfBase, -base],
    [halfBase, -base],
  ]) {
    halfWidth = Math.max(halfWidth, Math.abs(px * cos - py * sin));
    halfHeight = Math.max(halfHeight, Math.abs(px * sin + py * cos));
  }

  const boxWidth = Math.max(Math.ceil(halfWidth) * 2, minBox);
  const boxHeight = Math.max(Math.ceil(halfHeight) * 2, minBox);

  return {
    boxWidth,
    boxHeight,
    tailTop: boxHeight / 2 - base - tail.length,
    outlineTop: boxHeight / 2 - tip,
    angle,
  };
}

/**
 * Heading, bucketed to 15°.
 *
 * A degree of GPS jitter is not a change anyone can see on a 24pt badge, and
 * every surface keys its redraw on this — so it has to be the angle that gets
 * *drawn* too. The native surface used to rotate by the raw heading while
 * keying on the bucket, which meant the rotation quietly stopped tracking the
 * vehicle: `tracksViewChanges` is false, so a change the key does not notice
 * is never captured to the screen at all.
 */
export function headingBucket(heading: number | null | undefined): number | null {
  return Number.isFinite(heading) ? Math.round((heading as number) / 15) % 24 : null;
}

/** Everything a surface needs to draw one labelled vehicle. */
export function vehicleMarkerGeometry(
  line: string,
  tram: boolean,
  selected: boolean,
  heading: number | null | undefined,
  /** The smallest box a finger can reliably hit: `HitTarget`, in points. */
  minBox: number,
): VehicleMarkerGeometry {
  const grow = selected ? BADGE_GROW_SELECTED : 0;
  const badgeWidth = badgeWidthFor(line) + grow * 2;
  const badgeHeight = BADGE_HEIGHT + grow * 2;
  const badgeRadius = tram ? BADGE_RADIUS_TRAM + grow : badgeHeight / 2;

  return {
    ...place(
      badgeWidth / 2,
      badgeHeight / 2,
      badgeRadius,
      headingBucket(heading),
      BADGE_TAIL,
      minBox,
    ),
    badgeWidth,
    badgeHeight,
    badgeRadius,
  };
}

/**
 * The same, for a vehicle drawn as a dot.
 *
 * The dot keeps a dot-sized box on purpose: a bare marker inside the box a
 * labelled one needs swallows the taps meant for its neighbours at a busy
 * stop, so there is no `HitTarget` floor here.
 *
 * `heading` is `null` at city zoom, where a dot stands for its whole cell and
 * a direction would be a claim about the vehicles it swallowed as much as
 * about itself. At district zoom every vehicle is its own dot and the tail is
 * how the flow of the network reads at all.
 */
export function dotMarkerGeometry(
  tram: boolean,
  size: number,
  heading: number | null | undefined,
  minBox: number,
): DotMarkerGeometry {
  const dotRadius = dotRadiusFor(size, tram);
  return {
    ...place(size / 2, size / 2, dotRadius, headingBucket(heading), DOT_TAIL, minBox),
    dotSize: size,
    dotRadius,
  };
}

/* --- the classic marker ---------------------------------------------------
 *
 * The marker this file's geometry replaced, kept as a choice rather than as
 * history: `preferences.markerStyle` picks between them, and everything above
 * is what `'modern'` draws.
 *
 * `'classic'` is the tile from commit a86981d — a 40pt glossy badge with a
 * chevron orbiting it at a fixed radius, the pair rotated together inside a
 * 58pt box while the line number is counter-rotated back upright. There is
 * nothing to solve here: the orbit is one distance at every heading, which is
 * exactly what the modern marker exists to fix and also exactly what makes
 * this one a handful of constants.
 *
 * Two things about it are not faithful, on purpose. Its palette is the app's
 * (`LINE_COLOR`) rather than the pastels it shipped with — white numbers on
 * those came to about 2.9:1 and every night line was the same blue — and it
 * is a tile at *every* zoom, so the thinning still decides which vehicles are
 * drawn but never turns one into a dot: a bare dot is a shape this look does
 * not have. The cost is real and is what the setting trades: 58pt is bigger
 * than anything drawn in it, and on the native surface that box is also the
 * hit target, so a classic vehicle claims more map than a modern one.
 */

/** The square canvas the badge and its orbiting chevron turn inside. */
export const CLASSIC_BOX = 58;

/** The badge is one size for every line number; the label shrinks instead. */
export const CLASSIC_BADGE = 40;
export const CLASSIC_BADGE_RADIUS = 10.5;
export const CLASSIC_BADGE_BORDER = 2.5;
export const CLASSIC_BADGE_BORDER_SELECTED = 3;

/** The tinted chevron, and the darker one drawn a point behind it. */
export const CLASSIC_ARROW_HALF_BASE = 7;
export const CLASSIC_ARROW_LENGTH = 14;
export const CLASSIC_ARROW_OUTLINE_HALF_BASE = 8;
export const CLASSIC_ARROW_OUTLINE_LENGTH = 16;

/**
 * How far the chevron's top edge sits from the box's centre.
 *
 * Stated as a distance rather than as a `top` inside a 58pt box, because the
 * Leaflet page draws the same marker inside a 64pt one and would otherwise
 * have to know this box's size to place it.
 */
export const CLASSIC_ARROW_RISE = CLASSIC_BOX / 2 - 2;
export const CLASSIC_ARROW_OUTLINE_RISE = CLASSIC_BOX / 2 - 1;

/** The highlight across the top half of the badge. */
export const CLASSIC_SHEEN_HEIGHT = 19;

/** The line number: one size, and a smaller one once it runs past three glyphs. */
export const CLASSIC_LABEL_SIZE = 19;
export const CLASSIC_LABEL_SIZE_LONG = 15;
