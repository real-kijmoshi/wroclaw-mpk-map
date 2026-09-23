import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Stop } from '@/lib/api';
import { isRecentStop, type RecentStop } from '@/lib/recent-stops';

/**
 * Stops a rider has starred: the home stop, the one by work.
 *
 * Unlike the recent list this is chosen, so it is never trimmed behind the
 * rider's back and keeps the order stops were starred in. It is what the sheet
 * shows above "Blisko Ciebie" and what the home-screen widget reads, so a
 * regular's first question — when is my tram — is answered without searching.
 * Each entry is a specific boarding point, like a recent stop, because the
 * platform is what picks the direction.
 */

const STORAGE_KEY = 'wroclive.favouriteStops';
/** Past this the list is a directory, not a shortcut. */
export const MAX_FAVOURITE_STOPS = 12;

export type FavouriteStop = RecentStop;

let list: FavouriteStop[] = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list)).catch(() => {
    // The star stays lit for this session; it only fails to survive a restart.
  });
};

const toFavourite = (stop: Stop): FavouriteStop => {
  const favourite: FavouriteStop = { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon };
  if (stop.ids?.length) favourite.ids = stop.ids;
  if (stop.code) favourite.code = stop.code;
  return favourite;
};

export const favouriteStopsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => list,

  has: (id: string) => list.some((item) => item.id === id),

  /** Star or unstar. Returns whether the stop is a favourite afterwards. */
  toggle(stop: Stop): boolean {
    if (favouriteStopsStore.has(stop.id)) {
      list = list.filter((item) => item.id !== stop.id);
    } else {
      if (list.length >= MAX_FAVOURITE_STOPS) return false;
      list = [...list, toFavourite(stop)];
    }
    persist();
    emit();
    return favouriteStopsStore.has(stop.id);
  },
};

/** Read the starred stops once at startup. */
export async function hydrateFavouriteStops() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    list = Array.isArray(parsed) ? parsed.filter(isRecentStop).slice(0, MAX_FAVOURITE_STOPS) : [];
  } catch {
    list = [];
  } finally {
    emit();
  }
}

export function useFavouriteStops(): FavouriteStop[] {
  return useSyncExternalStore(
    favouriteStopsStore.subscribe,
    favouriteStopsStore.getSnapshot,
    favouriteStopsStore.getSnapshot,
  );
}
