import { apiGet, normaliseStopList, type Stop } from '@/lib/api';

/** Raw GTFS records that share a pole/platform are normally within a few metres. */
const SAME_PLATFORM_RADIUS_METERS = 12;

/**
 * How far apart the two directions of one stop can be and still be one place.
 *
 * A street's two platforms sit either side of the road, or a tram stop's two
 * are staggered along it — tens of metres, not hundreds. Two genuinely
 * different stops that happen to share a name (Wrocław has several "Rynek"-ish
 * repeats across the city) are kilometres apart, so this separates them without
 * needing the feed to carry a parent station.
 */
const SAME_AREA_RADIUS_METERS = 150;

/**
 * A normal, server-validated stop search.
 *
 * The /stops endpoint is the case-sensitive, diacritic-insensitive lookup the
 * timetable store builds at load time — it is not the near-position search that
 * powers the locate button. Publishers sometimes repeat the same physical
 * platform once per served pattern; those records are merged only when their
 * coordinates are effectively identical. Opposite directions remain separate.
 */
export async function searchStops(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<Stop[]> {
  const needle = query.trim();
  const direct = normaliseStopList(
    await apiGet<unknown>(`/stops?q=${encodeURIComponent(needle)}&limit=100`, options),
    '/stops',
  );
  if (direct.length || needle.length < 2) return groupSamePlatform(direct);

  // Older deployed servers do not fold ł into l. Probe with a short prefix
  // they do understand, then make the final diacritic-insensitive comparison
  // locally. This path disappears once every server has the current index.
  const prefix = foldSearchText(needle).slice(0, 2);
  if (!prefix) return [];
  const fallback = normaliseStopList(
    await apiGet<unknown>(`/stops?q=${encodeURIComponent(prefix)}&limit=100`, options),
    '/stops',
  ).filter((stop) => foldSearchText(stop.name).includes(foldSearchText(needle)));
  return groupSamePlatform(fallback);
}

export function foldSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[łŁ]/g, 'l')
    .toLocaleLowerCase('pl-PL')
    .trim();
}

/**
 * One place a rider would name, gathered from its platforms.
 *
 * `platforms` keeps every record so a departure board can still be opened for
 * the right side of the street; everything else is the merged view a list
 * should show.
 */
export type StopArea = {
  /** The nearest platform — what a tap opens, and where the coordinates come from. */
  primary: Stop;
  name: string;
  platforms: Stop[];
  /** Distance to the nearest platform, when the source carried one. */
  distance?: number;
  /** Every line calling at any platform of the area. */
  lines: string[];
};

/**
 * Group nearby platforms into the places they belong to.
 *
 * `/stops/near` returns raw GTFS records, and a street's stop is two or three
 * of them: the list read "Spółdzielcza 10 m / Spółdzielcza 10 m / Spółdzielcza
 * 40 m", which tells a rider nothing and buries the next real stop below the
 * fold. Grouping by name *and* proximity keeps two same-named stops in
 * different districts apart — the name alone is not unique in this feed.
 *
 * Input order is preserved: `/stops/near` sorts by distance, so the first
 * platform seen for an area is the nearest one, and the areas come out in the
 * same order.
 */
export function groupStopAreas(stops: Stop[]): StopArea[] {
  const areas: StopArea[] = [];

  for (const stop of stops) {
    const area = areas.find(
      (candidate) =>
        candidate.name === stop.name &&
        distanceMeters(candidate.primary.lat, candidate.primary.lon, stop.lat, stop.lon) <=
          SAME_AREA_RADIUS_METERS,
    );

    if (!area) {
      areas.push({
        primary: stop,
        name: stop.name,
        platforms: [stop],
        distance: stop.distance,
        lines: [...(stop.lines ?? [])],
      });
      continue;
    }

    // A publisher repeats a physical boarding point once per pattern it serves,
    // and `/stops/near` hands those back unmerged — which turned Rynek's
    // platforms into "8 stanowisk". `sameBoardingArea` is the same test the
    // search path has always used, so both routes into a stop list now count
    // boarding points the same way.
    if (!area.platforms.some((platform) => sameBoardingArea(platform, stop))) {
      area.platforms.push(stop);
    }

    if (stop.distance !== undefined && (area.distance === undefined || stop.distance < area.distance)) {
      area.distance = stop.distance;
      area.primary = stop;
    }
    for (const line of stop.lines ?? []) {
      if (!area.lines.includes(line)) area.lines.push(line);
    }
  }

  for (const area of areas) area.lines.sort(compareLineLabels);
  return areas;
}

/** "4" before "10", letters after numbers — the order a badge row is read in. */
function compareLineLabels(a: string, b: string) {
  const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
  const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
  if (aNum !== null && bNum !== null) return aNum - bNum;
  if (aNum !== null) return -1;
  if (bNum !== null) return 1;
  return a.localeCompare(b, 'pl');
}

/**
 * One boarding point can have several GTFS records, while the two directions
 * of a stop often have the same name. A broad same-name radius would join the
 * directions and show a misleading board; a 12m anchor radius only removes
 * coincident duplicate records from the same platform.
 */
function groupSamePlatform(stops: Stop[]): Stop[] {
  const groups: Stop[] = [];
  for (const stop of stops) {
    const platform = groups.find(
      (candidate) => sameBoardingArea(candidate, stop),
    );
    if (!platform) {
      groups.push({ ...stop, ids: [...new Set([stop.id, ...(stop.ids ?? [])])] });
      continue;
    }
    platform.ids = [...new Set([...(platform.ids ?? [platform.id]), stop.id])];
  }
  return groups.map((stop) => ({
    ...stop,
    ids: stop.ids && stop.ids.length > 1 ? stop.ids : undefined,
  }));
}

function sameBoardingArea(a: Stop, b: Stop) {
  if (a.name !== b.name) return false;
  const aArea = stopAreaCode(a.code);
  const bArea = stopAreaCode(b.code);
  if (aArea && bArea) return aArea === bArea;
  return distanceMeters(a.lat, a.lon, b.lat, b.lon) <= SAME_PLATFORM_RADIUS_METERS;
}

function stopAreaCode(code: string | undefined) {
  const value = code?.trim() ?? '';
  return /^\d{5,}$/.test(value) ? value.slice(0, -2) : null;
}

export function distanceMeters(latA: number, lonA: number, latB: number, lonB: number): number {
  const radians = Math.PI / 180;
  const aLat = latA * radians;
  const bLat = latB * radians;
  const dLat = (latB - latA) * radians;
  const dLon = (lonB - lonA) * radians;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
