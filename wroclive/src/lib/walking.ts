import { Linking } from 'react-native';

import { distanceMeters } from '@/lib/stops-api';

/**
 * How long the walk to a stop takes, and when to set off.
 *
 * An estimate, and labelled as one: straight-line distance stretched by a
 * street-grid detour factor, at an ordinary walking pace. Past a quarter of an
 * hour it is not "the stop round the corner" any more and nothing is claimed.
 */

/** A relaxed adult pace, in m/s — someone carrying a bag, not racing. */
const WALK_SPEED = 1.25;
/** Streets are not straight lines; Wrocław's grid adds about a quarter. */
const DETOUR = 1.25;
/** Time to find the platform and be standing on it, not arriving with the doors. */
const MARGIN_SECONDS = 30;
/** Beyond this the estimate stops being useful and is not shown. */
export const MAX_WALK_SECONDS = 15 * 60;

type Point = { lat: number; lon: number };

export function walkSeconds(from: Point | null, to: Point): number | null {
  if (!from) return null;
  const seconds = (distanceMeters(from.lat, from.lon, to.lat, to.lon) * DETOUR) / WALK_SPEED;
  return seconds <= MAX_WALK_SECONDS ? Math.round(seconds) : null;
}

/**
 * Seconds until the rider should leave to catch a departure `inSeconds` away.
 * Negative means it can no longer be caught on foot.
 */
export const leaveInSeconds = (inSeconds: number, walk: number) => inSeconds - walk - MARGIN_SECONDS;

/** "Wyjdź za 3 min", "Wyjdź teraz", or that this one is gone. */
export function leaveLabel(leaveIn: number): { text: string; missed: boolean } {
  if (leaveIn < -30) return { text: 'Nie zdążysz pieszo', missed: true };
  if (leaveIn < 60) return { text: 'Wyjdź teraz', missed: false };
  return { text: `Wyjdź za ${Math.floor(leaveIn / 60)} min`, missed: false };
}

/** Apple Maps, walking directions to the stop. No permission, no SDK. */
export function openWalkingDirections(stop: Point & { name: string }) {
  const query = new URLSearchParams({
    daddr: `${stop.lat},${stop.lon}`,
    q: stop.name,
    dirflg: 'w',
  });
  void Linking.openURL(`maps://?${query}`).catch(() => {
    // No Maps app (it can be deleted): the web page does the same job.
    void Linking.openURL(`https://maps.apple.com/?${query}`);
  });
}
