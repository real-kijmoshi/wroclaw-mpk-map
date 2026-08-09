import { apiGet, type Stop, ApiError } from '@/lib/api';

/** Raw GTFS records that share a pole/platform are normally within a few metres. */
const SAME_PLATFORM_RADIUS_METERS = 12;

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
  const payload = await apiGet<unknown>(`/stops?q=${encodeURIComponent(needle)}&limit=100`, options);
  const direct = normaliseStops(payload);
  if (direct.length || needle.length < 2) return groupSamePlatform(direct);

  // Older deployed servers do not fold ł into l. Probe with a short prefix
  // they do understand, then make the final diacritic-insensitive comparison
  // locally. This path disappears once every server has the current index.
  const prefix = foldSearchText(needle).slice(0, 2);
  if (!prefix) return [];
  const fallbackPayload = await apiGet<unknown>(`/stops?q=${encodeURIComponent(prefix)}&limit=100`, options);
  const fallback = normaliseStops(fallbackPayload).filter(
    (stop) => foldSearchText(stop.name).includes(foldSearchText(needle)),
  );
  return groupSamePlatform(fallback);
}

function foldSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[łŁ]/g, 'l')
    .toLocaleLowerCase('pl-PL')
    .trim();
}

/**
 * /stops returns `{ query, stops }` — but `query` is only echoed back for
 * debugging, and the array is plain objects. Validate every field rather than
 * trusting the shape: a 503 body would otherwise read as a list of stops called
 * "error".
 */
function normaliseStops(payload: unknown): Stop[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ApiError('Unexpected /stops payload', 0);
  }

  const record = payload as Record<string, unknown>;
  const raw = record.stops;
  if (!Array.isArray(raw)) throw new ApiError('Unexpected /stops payload', 0);

  const stops: Stop[] = [];
  for (const item of raw) {
    const stop = toStop(item);
    if (stop) stops.push(stop);
  }
  return stops;
}

function toStop(value: unknown): Stop | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === 'string' && record.id ? record.id : null;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const lat = toFinite(record.lat);
  const lon = toFinite(record.lon);
  if (!id || !name || lat === null || lon === null) return null;

  const code = toStringField(record.code);
  const distance = toFinite(record.distance);
  const ids = Array.isArray(record.ids)
    ? record.ids.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
    : [];

  const stop: Stop = { id, name, lat, lon };
  if (code !== undefined) stop.code = code;
  if (distance != null) stop.distance = distance;
  if (ids.length) stop.ids = ids;
  return stop;
}

const toFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toStringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

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

function distanceMeters(latA: number, lonA: number, latB: number, lonB: number): number {
  const radians = Math.PI / 180;
  const aLat = latA * radians;
  const bLat = latB * radians;
  const dLat = (latB - latA) * radians;
  const dLon = (lonB - lonA) * radians;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
