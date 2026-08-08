'use strict';

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
const distanceMeters = (lat1, lon1, lat2, lon2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Perpendicular distance from a point to a segment, in degrees scaled so that
 * longitude is comparable to latitude at Wrocław's latitude. Good enough for
 * polyline simplification and far cheaper than a full geodesic computation.
 */
const LON_SCALE = Math.cos(toRadians(51.11));

const perpendicularDistance = (lat, lon, aLat, aLon, bLat, bLon) => {
  const ax = aLon * LON_SCALE;
  const ay = aLat;
  const bx = bLon * LON_SCALE;
  const by = bLat;
  const px = lon * LON_SCALE;
  const py = lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);

  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * Ramer–Douglas–Peucker simplification over an interleaved [lat, lon, ...]
 * Float64Array. GTFS shapes trace every curve of the track; at map zoom levels
 * a few metres of tolerance removes most points with no visible difference.
 *
 * @param {Float64Array} points interleaved lat/lon
 * @param {number} toleranceMeters
 * @returns {Float64Array}
 */
const simplify = (points, toleranceMeters) => {
  const count = points.length / 2;
  if (count < 3 || toleranceMeters <= 0) return points;

  // ~111 km per degree of latitude.
  const tolerance = toleranceMeters / 111_320;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;

  // Iterative RDP — a recursive version overflows the stack on long shapes.
  const stack = [[0, count - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start < 2) continue;

    let maxDistance = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = perpendicularDistance(
        points[i * 2],
        points[i * 2 + 1],
        points[start * 2],
        points[start * 2 + 1],
        points[end * 2],
        points[end * 2 + 1],
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    if (maxIndex !== -1 && maxDistance > tolerance) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }

  let kept = 0;
  for (let i = 0; i < count; i += 1) kept += keep[i];

  const result = new Float64Array(kept * 2);
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    if (!keep[i]) continue;
    result[cursor * 2] = points[i * 2];
    result[cursor * 2 + 1] = points[i * 2 + 1];
    cursor += 1;
  }
  return result;
};

/** Axis-aligned bounds of an interleaved [lat, lon, ...] array. */
const boundsOf = (points) => {
  if (!points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const lat = points[i];
    const lon = points[i + 1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
};

/** Shortest distance in metres from a point to any vertex of a polyline. */
const distanceToPolyline = (lat, lon, points) => {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const distance = distanceMeters(lat, lon, points[i], points[i + 1]);
    if (distance < best) best = distance;
  }
  return best;
};

/** Compass bearing in degrees from one position to another. */
const bearingDegrees = (fromLat, fromLon, toLat, toLon) => {
  const dLon = toRadians(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRadians(toLat));
  const x =
    Math.cos(toRadians(fromLat)) * Math.sin(toRadians(toLat)) -
    Math.sin(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

/** Smallest angle between two compass bearings, 0–180. */
const angleBetween = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Distance along the polyline at every vertex, in metres.
 *
 * Computed once per route variant so a vehicle's position can be turned into
 * "x metres into the route", which is what the stop and time interpolation
 * downstream is expressed in.
 *
 * @param {Float64Array} points interleaved [lat, lon, ...]
 * @returns {Float64Array} one entry per vertex
 */
const cumulativeDistances = (points) => {
  const count = points.length / 2;
  const cumulative = new Float64Array(count);
  for (let i = 1; i < count; i += 1) {
    cumulative[i] =
      cumulative[i - 1] +
      distanceMeters(points[(i - 1) * 2], points[(i - 1) * 2 + 1], points[i * 2], points[i * 2 + 1]);
  }
  return cumulative;
};

/**
 * Nearest point on a polyline to a position.
 *
 * Projects onto every *segment*, not just the vertices: shapes are simplified
 * to 4 m before they are stored, so a vehicle sitting halfway down a 300 m
 * straight is nowhere near either end of it, and a vertex-only search reports
 * it as 150 m off route.
 *
 * Distances are computed in a local metre plane (longitude scaled by the
 * cosine of the latitude), which is accurate to well under a metre across a
 * city and far cheaper than a geodesic per segment.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Float64Array} points interleaved [lat, lon, ...]
 * @param {{ cumulative?: Float64Array, fromIndex?: number, toIndex?: number }} options
 *   `fromIndex` / `toIndex` restrict the search to a range of segment indices,
 *   which is how stops are matched in order along a route that doubles back on
 *   itself, and how a tracked vehicle is re-projected only around where it was
 *   last seen. Both clamp to the polyline's own range.
 * @returns {{ distance: number, along: number, index: number, t: number,
 *   lat: number, lon: number, bearing: number|null } | null}
 */
const projectToPolyline = (lat, lon, points, { cumulative = null, fromIndex = 0, toIndex = null } = {}) => {
  const count = points.length / 2;
  if (!count || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  if (count === 1) {
    return {
      distance: distanceMeters(lat, lon, points[0], points[1]),
      along: 0,
      index: 0,
      t: 0,
      lat: points[0],
      lon: points[1],
      bearing: null,
    };
  }

  const lonScale = Math.cos(toRadians(lat)) * METERS_PER_DEGREE_LAT;
  const px = lon * lonScale;
  const py = lat * METERS_PER_DEGREE_LAT;

  const start = Math.max(0, Math.min(fromIndex, count - 2));
  const end = Math.min(toIndex ?? count - 2, count - 2);
  let best = null;
  for (let i = start; i <= end; i += 1) {
    const ax = points[i * 2 + 1] * lonScale;
    const ay = points[i * 2] * METERS_PER_DEGREE_LAT;
    const bx = points[i * 2 + 3] * lonScale;
    const by = points[i * 2 + 2] * METERS_PER_DEGREE_LAT;

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (best && distance >= best.distance) continue;
    best = { distance, index: i, t };
  }

  const { index, t } = best;
  const aLat = points[index * 2];
  const aLon = points[index * 2 + 1];
  const bLat = points[index * 2 + 2];
  const bLon = points[index * 2 + 3];

  const segmentLength = cumulative
    ? cumulative[index + 1] - cumulative[index]
    : distanceMeters(aLat, aLon, bLat, bLon);

  return {
    distance: best.distance,
    along: (cumulative ? cumulative[index] : 0) + t * segmentLength,
    index,
    t,
    lat: aLat + (bLat - aLat) * t,
    lon: aLon + (bLon - aLon) * t,
    bearing: segmentLength > 0 ? bearingDegrees(aLat, aLon, bLat, bLon) : null,
  };
};

module.exports = {
  angleBetween,
  bearingDegrees,
  boundsOf,
  cumulativeDistances,
  distanceMeters,
  distanceToPolyline,
  projectToPolyline,
  simplify,
};
