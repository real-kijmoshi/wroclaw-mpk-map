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

module.exports = { boundsOf, distanceMeters, distanceToPolyline, simplify };
