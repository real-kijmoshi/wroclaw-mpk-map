/**
 * Every platform of a saved trip's end, not only the ones the rider starred.
 *
 * A trip's ends are *places* (`favourite-trips.ts`), and the server's `?to=`
 * filter only picks the right side of the street if every side is in the
 * request. The new-trip picker offers starred stops as one-tap places, and a
 * starred stop is the platforms the rider happened to star: 'BISKUPIN' starred
 * at the bus loop (1231/565) made a Biskupin → Reja trip that only ever saw the
 * odd 146, while trams 2 and 10 to Reja leave every seven minutes from the
 * other BISKUPIN, 46 m away (1358/1684). The widget then showed 18:22 as the
 * next departure at 09:53.
 *
 * Same name, within `PLACE_RADIUS_METERS` of the place — the radius
 * `groupStopAreas()` uses to call two platforms one place.
 *
 * Import-free on purpose: `server/test/app-pure-modules.test.js` runs it.
 */

export const PLACE_RADIUS_METERS = 150;

type Point = { lat: number; lon: number };

function metresBetween(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * `place`'s ids plus those of every search result that is the same place.
 * Returns `place` itself when nothing was added, so a caller can tell.
 */
export function withAllPlatforms<
  P extends Point & { name: string; ids: string[] },
>(
  place: P,
  stops: (Point & { id: string; name: string; ids?: string[] })[],
): P {
  const name = place.name.toLocaleLowerCase('pl');
  const ids = new Set(place.ids);
  for (const stop of stops) {
    if (stop.name.toLocaleLowerCase('pl') !== name) continue;
    if (!(metresBetween(place, stop) <= PLACE_RADIUS_METERS)) continue;
    ids.add(stop.id);
    for (const id of stop.ids ?? []) ids.add(id);
  }
  return ids.size === place.ids.length ? place : { ...place, ids: [...ids] };
}
