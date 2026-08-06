import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * Settings the rider chose. Small enough to live outside React, like the line
 * filter it sits next to.
 */

const STORAGE_KEY = 'wroclive.preferences';

/**
 * Which map to draw on.
 *
 * `auto` means the platform's own map where there is one — MapKit on iOS —
 * and OpenStreetMap everywhere else. `osm` pins the OpenStreetMap surface on
 * every platform, which is also the one that behaves identically everywhere.
 */
export type MapProvider = 'auto' | 'osm';

export type Preferences = {
  mapProvider: MapProvider;
  /** Draw stops near the rider when nothing else is selected. */
  showNearbyStops: boolean;
  /** Keep the selected vehicle centred and fit its route into view. */
  followSelectedVehicle: boolean;
};

const DEFAULTS: Preferences = {
  mapProvider: 'auto',
  showNearbyStops: true,
  followSelectedVehicle: false,
};

let preferences: Preferences = DEFAULTS;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)).catch(() => {
    // A setting that fails to persist is not worth interrupting anyone over.
  });
};

export const preferencesStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => preferences,

  set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (preferences[key] === value) return;
    preferences = { ...preferences, [key]: value };
    persist();
    emit();
  },
};

export async function hydratePreferences() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      // Merged over the defaults so a stored blob written by an older build
      // cannot leave a new setting undefined.
      preferences = { ...DEFAULTS, ...(parsed as Partial<Preferences>) };
    }
  } catch {
    preferences = DEFAULTS;
  } finally {
    emit();
  }
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getSnapshot,
    preferencesStore.getSnapshot,
  );
}
