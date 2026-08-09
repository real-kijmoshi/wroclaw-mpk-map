/**
 * Splitting a vehicle's route into "already travelled" (dim) and "still ahead"
 * (strong) so the map reads as immediately as it used to require a label.
 *
 * The server hands every surface a compact `[lat, lon]` polyline that has been
 * generalised for size, so a vehicle's GPS fix rarely lies exactly on a vertex.
 * This projects the fix onto the segment it is nearest, in local
 * equirectangular metres — accurate enough for a city the size of Wrocław
 * without pulling in a GIS dependency — and never trusts the server shape index
 * as the position index.
 */

export type Point = [number, number];

export interface RouteProgress {
  /** Segment `i = [points[i], points[i + 1]]` the vehicle projects onto. */
  segmentIndex: number;
  /** 0..1 position along that segment (0 at `points[i]`, 1 at `points[i + 1]`). */
  fraction: number;
  /** Where on the route the vehicle is, as `[lat, lon]`. */
  projectedPoint: Point;
  /** Perpendicular distance from the fix to that segment, in metres. */
  distanceMeters: number;
  /** Distance along the whole route to the projected point, in metres. */
  alongMeters: number;
}

export interface ProgressInput {
  /** Hint: prefer re-projecting near this segment before a full scan. */
  segmentIndex: number;
  /** Distance along the route the previous projection landed at, in metres. */
  alongMeters: number;
}

export interface RouteSplit {
  travelled: Point[];
  remaining: Point[];
}

/** Earth radius used for the local metre conversion. */
const EARTH_R = 6371000;
const DEG2RAD = Math.PI / 180;

/**
 * Fix this far (metres) off the route and it is considered off-route: the
 * surface falls back to the unsplit line so the route never disappears.
 */
export const OFF_ROUTE_METERS = 150;

/**
 * Backwards motion smaller than this is GPS jitter the split is allowed to
 * follow; anything larger is treated as an implausible jump and held.
 */
export const BACKWARD_TOLERANCE_METERS = 80;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Project a latitude/longitude fix onto a route polyline.
 *
 * `previous` biases the search to the segment the last fix landed on, which
 * keeps a jittery position from snapping a long way back along the route. The
 * function still falls back to a full scan when the local window has no
 * reasonable match — e.g. the vehicle moved forward past the window.
 *
 * Returns `null` when the fix is clearly off-route, leaving the caller to draw
 * the unsplit route.
 */
export function projectProgress(
  points: Point[],
  lat: number,
  lon: number,
  previous?: ProgressInput,
): RouteProgress | null {
  const n = points.length;
  if (n < 2) return null;

  const lat0 = points[0][0];
  const lon0 = points[0][1];
  const cosLat0 = Math.cos(lat0 * DEG2RAD);
  const toX = (lonDiff: number) => lonDiff * cosLat0 * EARTH_R * DEG2RAD;
  const toY = (latDiff: number) => latDiff * EARTH_R * DEG2RAD;
  const fromX = (x: number) => lon0 + x / (cosLat0 * EARTH_R * DEG2RAD);
  const fromY = (y: number) => lat0 + y / (EARTH_R * DEG2RAD);

  const local: { x: number; y: number }[] = new Array(n);
  const along = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    local[i] = { x: toX(points[i][1] - lon0), y: toY(points[i][0] - lat0) };
    if (i > 0) {
      along[i] = along[i - 1] + Math.hypot(local[i].x - local[i - 1].x, local[i].y - local[i - 1].y);
    }
  }

  const vx = toX(lon - lon0);
  const vy = toY(lat - lat0);

  const projectSegment = (i: number) => {
    const a = local[i];
    const b = local[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t: number;
    let px: number;
    let py: number;
    if (len2 === 0) {
      // Duplicate consecutive point: collapse the segment to a single vertex.
      t = 0;
      px = a.x;
      py = a.y;
    } else {
      const apx = vx - a.x;
      const apy = vy - a.y;
      t = (apx * abx + apy * aby) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      px = a.x + abx * t;
      py = a.y + aby * t;
    }
    const perp = Math.hypot(vx - px, vy - py);
    const segLen = along[i + 1] - along[i];
    return { i, t, px, py, perp, alongMeters: along[i] + segLen * t };
  };

  // The local window around the previous segment is preferred — that is what
  // keeps a jittery fix from snapping to an earlier, parallel stretch of the
  // route and watching the travelled line shrink backwards.
  let best: ReturnType<typeof projectSegment> | null = null;
  if (previous) {
    const seg = clamp(previous.segmentIndex, 0, n - 2);
    const lo = Math.max(0, seg - 1);
    const hi = Math.min(n - 2, seg + 1);
    for (let i = lo; i <= hi; i++) {
      const r = projectSegment(i);
      if (!best || r.perp < best.perp) best = r;
    }
    // A local match that is clearly off-route is not a match: fall through to a
    // full scan so a vehicle that moved past the window is found again.
    if (!best || best.perp > OFF_ROUTE_METERS) best = null;
  }

  // Full scan for the global nearest as the fallback / starting point.
  if (!best) {
    best = projectSegment(0);
    for (let i = 1; i <= n - 2; i++) {
      const r = projectSegment(i);
      if (r.perp < best.perp) best = r;
    }
  }

  if (!best || best.perp > OFF_ROUTE_METERS) return null;

  return {
    segmentIndex: best.i,
    fraction: best.t,
    projectedPoint: [fromY(best.py), fromX(best.px)],
    distanceMeters: best.perp,
    alongMeters: best.alongMeters,
  };
}

/**
 * Cut a projected progress into two polylines that share the projected point so
 * no visual gap appears where they meet.
 */
export function splitRoute(points: Point[], progress: RouteProgress): RouteSplit {
  const { segmentIndex, projectedPoint } = progress;
  return {
    travelled: points.slice(0, segmentIndex + 1).concat([projectedPoint]),
    remaining: [projectedPoint].concat(points.slice(segmentIndex + 1)),
  };
}
