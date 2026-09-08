import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The last good answer for a handful of requests, kept on the phone.
 *
 * Wrocław's tram tunnels, the underpasses at Grunwaldzki, a basement flat —
 * this app is used in exactly the places a phone has no signal, and until now
 * losing it meant losing the timetable too. The timetable is the part that
 * does not need the network: it changes once a week and the copy from an hour
 * ago is the same copy.
 *
 * Positions are not cached and must not be. A tram's location from ten minutes
 * ago is not stale data, it is wrong data, and the map already has its own
 * "last known, and it says so" handling for that. What is cached here is what
 * stays true: the line list, stop searches, and departure boards.
 *
 * It is a cache in the strict sense — every read may miss, every write may
 * fail, and nothing observable depends on either.
 */

const PREFIX = 'wroclive.cache.';

/**
 * A cached board older than this is not offered.
 *
 * Long enough to cover a commute underground and a night with no signal;
 * short enough that it cannot survive a timetable change, which happens on
 * dated snapshots roughly weekly.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bigger than this and it is not the kind of payload this is for. */
const MAX_BYTES = 256 * 1024;

type Entry = { cachedAt: number; data: unknown };

const keyFor = (path: string) => `${PREFIX}${path}`;

/** Store one successful response. Failures are silent by design. */
export async function remember(path: string, data: unknown): Promise<void> {
  try {
    const body = JSON.stringify({ cachedAt: Date.now(), data } satisfies Entry);
    if (body.length > MAX_BYTES) return;
    await AsyncStorage.setItem(keyFor(path), body);
  } catch {
    // A cache that cannot be written is a cache that misses later. That is
    // the whole consequence.
  }
}

/** The last good answer for `path`, if there is one and it is not too old. */
export async function recall<T>(path: string): Promise<{ data: T; cachedAt: number } | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(path));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry;
    if (!entry || typeof entry.cachedAt !== 'number') return null;
    if (Date.now() - entry.cachedAt > MAX_AGE_MS) return null;
    return { data: entry.data as T, cachedAt: entry.cachedAt };
  } catch {
    return null;
  }
}

/** Drop everything. Offered in settings beside the other stored data. */
export async function forgetAll(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(PREFIX));
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {
    // Nothing to report: the entries age out on their own.
  }
}
