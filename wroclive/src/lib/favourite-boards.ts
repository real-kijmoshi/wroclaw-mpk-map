import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { getDeparturesForStops, getJourneyDepartures } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourite-stops';
import type { FavouriteTrip } from '@/lib/favourite-trips';
import { syncDeparturesWidget, type TripBoard, type WidgetBoard } from '@/lib/widgets';

export type { TripBoard, WidgetBoard as FavouriteBoard } from '@/lib/widgets';

export type SavedBoards = { stops: WidgetBoard[]; trips: TripBoard[] };

/**
 * The departures of every starred stop, and where they go.
 *
 * One fetch serves three readers: the "Ulubione" rows on the sheet, the
 * home-screen widget, and the background refresh that keeps the widget going
 * while the app is closed. Keeping it in one place is what keeps those three
 * from each polling the same boards.
 *
 * All of them, not the first three: which stop a widget shows is picked on the
 * widget by name, so any starred stop can be on one, and a stop whose board was
 * never fetched would be a widget that only ever says "open the app". The list
 * is capped at `MAX_FAVOURITE_STOPS`, so this stays a dozen small requests.
 */

const POSITION_KEY = 'wroclive.lastPosition';

/**
 * The last boards fetched, for screens that only need to *describe* a starred
 * stop — the favourites manager names each platform by where it goes, since
 * three rows all reading "Spółdzielcza" say nothing. Read, never polled: the
 * map's own poll keeps it current.
 */
let latest: SavedBoards = { stops: [], trips: [] };
const latestListeners = new Set<() => void>();
const subscribeLatest = (listener: () => void) => {
  latestListeners.add(listener);
  return () => latestListeners.delete(listener);
};
const getLatest = () => latest;

export function useLatestFavouriteBoards(): SavedBoards {
  return useSyncExternalStore(subscribeLatest, getLatest, getLatest);
}

/**
 * Where the rider last was, for the widget's walking estimate — kept on the
 * phone only, rounded to about ten metres, and never sent anywhere. The
 * background refresh has no location access (the app asks for "while using"
 * only), so this is the only position it can measure a walk from.
 */
export async function rememberPosition(position: { lat: number; lon: number }) {
  const rounded = { lat: Number(position.lat.toFixed(4)), lon: Number(position.lon.toFixed(4)) };
  await AsyncStorage.setItem(POSITION_KEY, JSON.stringify(rounded)).catch(() => {});
}

export async function lastPosition(): Promise<{ lat: number; lon: number } | null> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(POSITION_KEY)) ?? 'null');
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isFinite((parsed as { lat: unknown }).lat) &&
      Number.isFinite((parsed as { lon: unknown }).lon)
    ) {
      return parsed as { lat: number; lon: number };
    }
  } catch {
    // Nothing remembered.
  }
  return null;
}

/**
 * Fetch the boards of every starred stop and every saved trip. One that fails
 * is left out rather than failing the rest.
 */
export async function fetchFavouriteBoards(
  favourites: FavouriteStop[],
  trips: FavouriteTrip[],
  signal?: AbortSignal,
): Promise<SavedBoards> {
  const options = { signal, retryWhileLoading: false };
  const [stops, journeys] = await Promise.all([
    Promise.allSettled(
      favourites.map(async (stop) => ({
        stop,
        departures: (await getDeparturesForStops(stop, options)).departures,
      })),
    ),
    Promise.allSettled(
      trips.map(async (trip) => ({ trip, ...(await getJourneyDepartures(trip.from.ids, trip.to.ids, options)) })),
    ),
  ]);
  const settled = <T,>(results: PromiseSettledResult<T>[]) =>
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const result = { stops: settled(stops), trips: settled(journeys) };
  latest = result;
  for (const listener of latestListeners) listener();
  return result;
}

/** Fetch and hand the widget a new timeline — what the background task runs. */
export async function refreshFavouriteBoards(
  favourites: FavouriteStop[],
  trips: FavouriteTrip[],
  signal?: AbortSignal,
) {
  const boards = await fetchFavouriteBoards(favourites, trips, signal);
  await syncDeparturesWidget({ favourites, boards: boards.stops, trips, tripBoards: boards.trips }, await lastPosition());
  return boards;
}
