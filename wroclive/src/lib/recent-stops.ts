import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Stop } from '@/lib/api';

/**
 * The last few stops a rider opened a departure board for.
 *
 * Small enough to live outside React, like the line filter it sits next to:
 * the search screen reads it for its empty-state, and the map will too. It is
 * not a favourites list — just a quick way back to a stop you looked up a
 * minute ago without searching again.
 */

const STORAGE_KEY = 'wroclive.recentStops';
const MAX = 6;
let hydrated = false;

export type RecentStop = {
  id: string;
  ids?: string[];
  name: string;
  lat: number;
  lon: number;
  code?: string;
};

let list: RecentStop[] = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list)).catch(() => {
    // A stop that fails to remember is not worth interrupting anyone over —
    // the search still works, it just forgets the last one.
  });
};

export const recentStopsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => list,
  isHydrated: () => hydrated,

  add(stop: Stop) {
    const recent: RecentStop = {
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    };
    if (stop.ids?.length) recent.ids = stop.ids;
    if (stop.code) recent.code = stop.code;

    // Newest first; opening the same stop again just moves it to the top
    // rather than stacking a duplicate.
    list = [recent, ...list.filter((item) => item.id !== stop.id)].slice(0, MAX);
    persist();
    emit();
  },

  clear() {
    list = [];
    persist();
    emit();
  },
};

/** Read the saved stops once at startup. */
export async function hydrateRecentStops() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    list = Array.isArray(parsed) ? parsed.filter(isRecentStop).slice(0, MAX) : [];
  } catch {
    // Corrupt storage just means an empty recent list.
    list = [];
  } finally {
    hydrated = true;
    emit();
  }
}

function isRecentStop(value: unknown): value is RecentStop {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.lat === 'number' &&
    Number.isFinite(record.lat) &&
    typeof record.lon === 'number' &&
    Number.isFinite(record.lon) &&
    (record.ids === undefined || (Array.isArray(record.ids) && record.ids.every((id) => typeof id === 'string')))
  );
}

export function useRecentStops(): RecentStop[] {
  return useSyncExternalStore(
    recentStopsStore.subscribe,
    recentStopsStore.getSnapshot,
    recentStopsStore.getSnapshot,
  );
}
