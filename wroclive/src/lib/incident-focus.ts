/**
 * Where the camera goes for a disruption's stops. Kept free of runtime imports
 * so `server/test/incident-focus.test.js` can run it.
 *
 * The centre is the middle of the stops' bounding box rather than their mean,
 * so five platforms of one junction cannot drag it off a lone stop across
 * town, and the zoom follows how far apart they are. A stop without usable
 * coordinates is ignored; with none left there is nowhere honest to go, and
 * the caller leaves the camera where it is rather than centring on 0,0.
 */
export function incidentFocusView(
  stops: readonly { lat: number; lon: number }[],
): { lat: number; lon: number; zoom: number } | null {
  const placed = stops.filter(
    (stop) =>
      Number.isFinite(stop.lat) &&
      Number.isFinite(stop.lon) &&
      Math.abs(stop.lat) <= 90 &&
      Math.abs(stop.lon) <= 180,
  );
  if (!placed.length) return null;
  const lats = placed.map((stop) => stop.lat);
  const lons = placed.map((stop) => stop.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  const metresPerDegree = 111_320;
  const span = Math.max(
    (maxLat - minLat) * metresPerDegree,
    (maxLon - minLon) * metresPerDegree * Math.cos((lat * Math.PI) / 180),
  );
  const zoom = span < 600 ? 16 : span < 1_500 ? 15 : span < 3_500 ? 14 : span < 8_000 ? 13 : 12;
  return { lat, lon, zoom };
}
