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
/** "Dom", "Praca" — a word, not a sentence; it has to fit a lock-screen widget. */
export const MAX_LABEL_LENGTH = 24;

export type FavouriteStop = RecentStop & {
  /**
   * The rider's own name for it. Shown above the stop's real name, never
   * instead of it: "Dom" does not tell anyone which platform to stand at.
   */
  label?: string;
};

/** What a list, the widget and a quick action call a starred stop. */
export const favouriteTitle = (stop: FavouriteStop) => stop.label || stop.name;

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

  get: (id: string) => list.find((item) => item.id === id) ?? null,

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

  remove(id: string) {
    list = list.filter((item) => item.id !== id);
    persist();
    emit();
  },

  /** Name it, or clear the name with an empty string. */
  rename(id: string, label: string) {
    const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
    list = list.map((item) => {
      if (item.id !== id) return item;
      const { label: _previous, ...rest } = item;
      return trimmed ? { ...rest, label: trimmed } : rest;
    });
    persist();
    emit();
  },

  /**
   * Move one place up or down. The order is what the sheet lists, what the
   * quick actions offer first, and what an unconfigured widget falls back to.
   */
  move(id: string, by: -1 | 1) {
    const from = list.findIndex((item) => item.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= list.length) return;
    const next = [...list];
    [next[from], next[to]] = [next[to], next[from]];
    list = next;
    persist();
    emit();
  },
};

const isFavouriteStop = (value: unknown): value is FavouriteStop => {
  if (!isRecentStop(value)) return false;
  const label = (value as { label?: unknown }).label;
  return label === undefined || typeof label === 'string';
};

/** Read the starred stops once at startup. */
export async function hydrateFavouriteStops() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    list = Array.isArray(parsed) ? parsed.filter(isFavouriteStop).slice(0, MAX_FAVOURITE_STOPS) : [];
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
