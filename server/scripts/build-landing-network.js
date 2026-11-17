'use strict';

/**
 * Bake the tram and city-bus network into `landing/data/network.json`, the
 * drawing the landing page's live map sits on.
 *
 * The landing page draws the fleet over the network itself rather than over
 * map tiles: tiles would be another load on OpenStreetMap's donated servers
 * (invariant 21) for a decorative hero, and the network is the more legible
 * picture of the city anyway. The geometry changes when the timetable does,
 * a few times a year, so it is baked here rather than fetched per visitor.
 *
 *   node scripts/build-landing-network.js [apiBase]
 *
 * Every variant of every tram and daytime bus line is fetched, simplified to
 * ~12 m (Douglas–Peucker), and stored as delta-encoded integers in 1e-5°.
 * Segments shared by several lines are kept: overlapping strokes are what
 * makes the trunk routes read heavier than the branches.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = (process.argv[2] || 'https://api.wroclive.kijmoshi.xyz').replace(/\/+$/, '');
const OUT = path.join(__dirname, '..', '..', 'landing', 'data', 'network.json');
const TOLERANCE_M = 12;
const KINDS = { tram: ['tram', 'tramSpecial'], bus: ['bus', 'busExpress'] };

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((51.11 * Math.PI) / 180);

function perpendicular([lat, lon], [aLat, aLon], [bLat, bLon]) {
  const px = (lon - aLon) * M_PER_DEG_LON;
  const py = (lat - aLat) * M_PER_DEG_LAT;
  const dx = (bLon - aLon) * M_PER_DEG_LON;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / length));
  return Math.hypot(px - t * dx, py - t * dy);
}

function simplify(points) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let worst = 0;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const distance = perpendicular(points[i], points[from], points[to]);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (worst > TOLERANCE_M) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function encode(points) {
  let lastLat = 0;
  let lastLon = 0;
  const out = [];
  for (const [lat, lon] of points) {
    const qLat = Math.round(lat * 1e5);
    const qLon = Math.round(lon * 1e5);
    out.push(qLat - lastLat, qLon - lastLon);
    lastLat = qLat;
    lastLon = qLon;
  }
  return out;
}

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if (response.status !== 503 && response.status !== 429) throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
  }
  throw new Error(`${url}: gave up`);
}

async function main() {
  const lines = await getJson(`${API}/lines`);
  const network = { generatedAt: new Date().toISOString(), scale: 1e5, tram: [], bus: [] };
  for (const [kind, categories] of Object.entries(KINDS)) {
    const wanted = categories.flatMap((category) => lines[category] ?? []);
    for (const line of wanted) {
      let payload;
      try {
        payload = await getJson(`${API}/shapes/${encodeURIComponent(line)}/variants`);
      } catch (error) {
        console.warn(`skip ${line}: ${error.message}`);
        continue;
      }
      for (const variant of payload.variants ?? []) {
        const points = (variant.points ?? []).filter(
          (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
        );
        if (points.length < 2) continue;
        network[kind].push({ line, path: encode(simplify(points)) });
      }
    }
    console.log(`${kind}: ${network[kind].length} variants from ${wanted.length} lines`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(network));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
