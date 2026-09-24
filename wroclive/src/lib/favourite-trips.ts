import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * Journeys a rider makes again and again: "Szkoła" is Biskupin → Reja.
 *
 * A starred stop answers "when does something leave"; a saved trip answers
 * the question a regular actually has — "which of my trams do I take, and
 * when am I there". Both ends are *places*, every platform included: the
 * server keeps only the trips that go on to the destination
 * (`/stop/:id/departures?to=`), and that is what picks the right side of the
 * street, so the rider never has to.
 */

const STORAGE_KEY = 'wroclive.favouriteTrips';
export const MAX_FAVOURITE_TRIPS = 6;
export const MAX_TRIP_LABEL_LENGTH = 24;

export type TripPlace = {
  name: string;
  /** Every platform of the place. */
  ids: string[];
  lat: number;
  lon: number;
};

export type FavouriteTrip = {
  id: string;
  /** "Szkoła", "Do pracy" — what the widget and the list lead with. */
  label: string;
  from: TripPlace;
  to: TripPlace;
};

let list: FavouriteTrip[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const persist = () => {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list)).catch(() => {
    // Kept for this session; it only fails to survive a restart.
  });
};

/** "Biskupin → Reja", or the label when there is one. */
export const tripTitle = (trip: FavouriteTrip) => trip.label || `${trip.from.name} → ${trip.to.name}`;

export const favouriteTripsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => list,

  /** Returns the saved trip, or null when the list is full. */
  add(from: TripPlace, to: TripPlace, label: string): FavouriteTrip | null {
    if (list.length >= MAX_FAVOURITE_TRIPS) return null;
    const trip: FavouriteTrip = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label: label.trim().slice(0, MAX_TRIP_LABEL_LENGTH),
      from,
      to,
    };
    list = [...list, trip];
    persist();
    emit();
    return trip;
  },

  remove(id: string) {
    list = list.filter((trip) => trip.id !== id);
    persist();
    emit();
  },

  rename(id: string, label: string) {
    const trimmed = label.trim().slice(0, MAX_TRIP_LABEL_LENGTH);
    list = list.map((trip) => (trip.id === id ? { ...trip, label: trimmed } : trip));
    persist();
    emit();
  },
};

const isPlace = (value: unknown): value is TripPlace => {
  if (!value || typeof value !== 'object') return false;
  const place = value as Record<string, unknown>;
  return (
    typeof place.name === 'string' &&
    Array.isArray(place.ids) &&
    place.ids.length > 0 &&
    place.ids.every((id) => typeof id === 'string') &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lon)
  );
};

const isTrip = (value: unknown): value is FavouriteTrip => {
  if (!value || typeof value !== 'object') return false;
  const trip = value as Record<string, unknown>;
  return typeof trip.id === 'string' && typeof trip.label === 'string' && isPlace(trip.from) && isPlace(trip.to);
};

export async function hydrateFavouriteTrips() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    list = Array.isArray(parsed) ? parsed.filter(isTrip).slice(0, MAX_FAVOURITE_TRIPS) : [];
  } catch {
    list = [];
  } finally {
    emit();
  }
}

export function useFavouriteTrips(): FavouriteTrip[] {
  return useSyncExternalStore(favouriteTripsStore.subscribe, favouriteTripsStore.getSnapshot, favouriteTripsStore.getSnapshot);
}
