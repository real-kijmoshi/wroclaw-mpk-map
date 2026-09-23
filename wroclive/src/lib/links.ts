import type { Stop } from '@/lib/api';
import { SITE_URL } from '@/lib/config';

/**
 * Links into the app and out of it.
 *
 * Two forms, for two readers. What a rider *shares* is an https link to the
 * browser map, because the person receiving it may not have the app and a
 * `wroclive://` link in a chat is dead text. What the system hands *back* —
 * a tap on the widget or the Live Activity — is the app's own scheme, which
 * `+native-intent.tsx` turns into a map intent. A stop link carries its name
 * and position so it opens without a lookup; a vehicle link is just the id,
 * and a vehicle that has finished its run by the time it is opened is simply
 * not found.
 */

export type LinkTarget =
  | { kind: 'stop'; stop: Stop }
  | { kind: 'vehicle'; id: string };

const stopQuery = (stop: Pick<Stop, 'id' | 'name' | 'lat' | 'lon'>) =>
  new URLSearchParams({
    stop: stop.id,
    name: stop.name,
    lat: stop.lat.toFixed(6),
    lon: stop.lon.toFixed(6),
  }).toString();

export const stopShareUrl = (stop: Pick<Stop, 'id' | 'name' | 'lat' | 'lon'>) =>
  `${SITE_URL}/map.html?${stopQuery(stop)}`;

export const vehicleShareUrl = (id: string) =>
  `${SITE_URL}/map.html?${new URLSearchParams({ vehicle: id })}`;

/** The app's own link to a stop, for the widget and the Live Activity. */
export const stopAppUrl = (stop: Pick<Stop, 'id' | 'name' | 'lat' | 'lon'>) =>
  `wroclive://open?${stopQuery(stop)}`;

export const vehicleAppUrl = (id: string) =>
  `wroclive://open?${new URLSearchParams({ vehicle: id })}`;

/**
 * What a link asks for, or null when it is not one of ours.
 *
 * Accepts the app scheme and the site's map page alike, so the same parser
 * serves a future universal link without a second copy.
 */
export function parseLink(raw: string): LinkTarget | null {
  let url: URL;
  try {
    // The router may hand over the full `wroclive://open?…` or just the path
    // (`/open?…`); a base makes the second parse the same way.
    url = new URL(raw, 'https://wroclive.invalid');
  } catch {
    return null;
  }

  const params = url.searchParams;
  const vehicle = params.get('vehicle');
  if (vehicle) return { kind: 'vehicle', id: vehicle };

  const id = params.get('stop');
  const lat = Number.parseFloat(params.get('lat') ?? '');
  const lon = Number.parseFloat(params.get('lon') ?? '');
  if (id && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { kind: 'stop', stop: { id, name: params.get('name') ?? '', lat, lon } };
  }
  return null;
}
