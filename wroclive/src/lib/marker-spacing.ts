/**
 * Which badges are drawn when every drawn vehicle is a badge (the classic
 * marker). Kept free of runtime imports so `server/test/app-pure-modules.test.js`
 * can run it.
 *
 * A grid cell is not enough here: two vehicles either side of a cell boundary
 * each win their own cell and land a point apart, and the number underneath is
 * neither readable nor tappable. So spacing is measured on screen, between the
 * badges already kept: a vehicle closer than `minSpacing` points to one of them
 * is left out. The input order is the priority — the caller puts the selected
 * vehicle first and the rest in id order, so the same vehicles survive from
 * poll to poll and the map does not twinkle.
 */
export function spaceMarkers<T extends { lat: number; lon: number }>(
  ordered: readonly T[],
  view: { latitudeDelta: number; longitudeDelta: number; width: number; height: number },
  minSpacing: number,
  /** Always kept, whatever it overlaps — the selected vehicle. */
  keep: (item: T) => boolean = () => false,
): T[] {
  const xPerLon = view.width / Math.max(view.longitudeDelta, 1e-9);
  const yPerLat = view.height / Math.max(view.latitudeDelta, 1e-9);
  const minSquared = minSpacing * minSpacing;
  const kept: { item: T; x: number; y: number }[] = [];
  for (const item of ordered) {
    const x = item.lon * xPerLon;
    const y = item.lat * yPerLat;
    const clear = kept.every((other) => (other.x - x) ** 2 + (other.y - y) ** 2 >= minSquared);
    if (clear || keep(item)) kept.push({ item, x, y });
  }
  return kept.map((entry) => entry.item);
}
