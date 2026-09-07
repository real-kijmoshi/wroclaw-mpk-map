import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Stop } from '@/lib/api';

/**
 * The stops and lines a rider keeps.
 *
 * `recent-stops.ts` next door is deliberately not this: it remembers where you
 * just were, and it forgets. A favourite is a statement — this is my stop,
 * this is my line — and the difference matters at the top of the home sheet,
 * where the first thing on screen should be the board a commuter opens the app
 * for twice a day rather than whatever they last tapped.
 *
 * Same shape as the two stores it sits beside: outside React, one AsyncStorage
 * key, hydrated once at boot. Lines are kept as plain names rather than
 * objects because the line list is rebuilt from the timetable on every launch
 * and a stored copy would go stale against it.
 */

const STORAGE_KEY = 'wroclive.favourites';

/**
 * Enough to be worth pinning, few enough to stay a glance.
 *
 * Past about this many the section stops answering "what do I ride" and
 * becomes a second search screen, which the app already has.
 */
const MAX_STOPS = 12;
const MAX_LINES = 20;

export type FavouriteStop = {
  id: string;
  /** Sibling platform ids, so a favourite board covers both sides of a street. */
  ids?: string[];
  name: string;
  lat: number;
  lon: number;
  code?: string;
};

type State = {
  stops: FavouriteStop[];
  lines: string[];
};

const EMPTY: State = { stops: [], lines: [] };

let state: State = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
    // A favourite that fails to save is not worth interrupting anyone over —
    // it is still pinned for this session, and the next write will retry.
  });
};

const toFavourite = (stop: Stop): FavouriteStop => {
  const favourite: FavouriteStop = {
    id: stop.id,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
  };
  if (stop.ids?.length) favourite.ids = stop.ids;
  if (stop.code) favourite.code = stop.code;
  return favourite;
};

export const favouritesStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,
  isHydrated: () => hydrated,

  isStop(id: string) {
    return state.stops.some((stop) => stop.id === id);
  },

  isLine(line: string) {
    return state.lines.includes(line);
  },

  /**
   * Pin or unpin a stop, and say which it did.
   *
   * One call for both directions because every caller is a single control
   * whose label is "add or remove", and splitting it only moves the `if` into
   * six components.
   */
  toggleStop(stop: Stop): 'added' | 'removed' {
    if (this.isStop(stop.id)) {
      state = { ...state, stops: state.stops.filter((entry) => entry.id !== stop.id) };
      persist();
      emit();
      return 'removed';
    }
    // Newest first, and capped: the cap drops the oldest rather than refusing,
    // because a rider pinning a thirteenth stop means it, and an error message
    // about a limit they never knew existed is a worse answer.
    state = { ...state, stops: [toFavourite(stop), ...state.stops].slice(0, MAX_STOPS) };
    persist();
    emit();
    return 'added';
  },

  toggleLine(line: string): 'added' | 'removed' {
    if (this.isLine(line)) {
      state = { ...state, lines: state.lines.filter((entry) => entry !== line) };
      persist();
      emit();
      return 'removed';
    }
    state = { ...state, lines: [line, ...state.lines].slice(0, MAX_LINES) };
    persist();
    emit();
    return 'added';
  },

  clear() {
    state = EMPTY;
    persist();
    emit();
  },
};

const isFavouriteStop = (value: unknown): value is FavouriteStop => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.lat === 'number' &&
    Number.isFinite(record.lat) &&
    typeof record.lon === 'number' &&
    Number.isFinite(record.lon)
  );
};

/** Read the saved favourites once at startup. */
export async function hydrateFavourites() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const record = (parsed ?? {}) as Record<string, unknown>;
    state = {
      stops: Array.isArray(record.stops)
        ? record.stops.filter(isFavouriteStop).slice(0, MAX_STOPS)
        : [],
      lines: Array.isArray(record.lines)
        ? record.lines
            .filter((line): line is string => typeof line === 'string' && line.length > 0)
            .slice(0, MAX_LINES)
        : [],
    };
  } catch {
    // Corrupt storage costs the pins, never the launch.
    state = EMPTY;
  } finally {
    hydrated = true;
    emit();
  }
}

export function useFavourites(): State {
  return useSyncExternalStore(
    favouritesStore.subscribe,
    favouritesStore.getSnapshot,
    favouritesStore.getSnapshot,
  );
}
