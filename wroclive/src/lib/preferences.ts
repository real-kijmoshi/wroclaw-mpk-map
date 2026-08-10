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

/**
 * MapKit base map style on iOS when the system map is selected.
 * Only consulted when `mapProvider` is `'auto'`; OSM keeps the standard
 * base and tiles over it regardless.
 */
export type AppleMapType = 'standard' | 'satellite' | 'hybrid';

/** The app's colour scheme: light, dark, or follow the system. */
export type ColorScheme = 'light' | 'dark' | 'system';

export type Preferences = {
  mapProvider: MapProvider;
  /** Base map style for the system (MapKit) surface on iOS. */
  appleMapType: AppleMapType;
  /**
   * Draw the stops layer.
   *
   * The key is historical — it used to mean "stops around the rider, after the
   * locate button" — and is kept so a stored choice survives the upgrade. What
   * it now controls is the layer that follows the map's viewport.
   */
  showNearbyStops: boolean;
  /** Keep the selected vehicle centred and fit its route into view. */
  followSelectedVehicle: boolean;
  /** Light, dark, or follow the system colour scheme. */
  colorScheme: ColorScheme;
};

const DEFAULTS: Preferences = {
  mapProvider: 'auto',
  appleMapType: 'standard',
  showNearbyStops: true,
  followSelectedVehicle: false,
  colorScheme: 'system',
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
