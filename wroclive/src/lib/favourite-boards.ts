import AsyncStorage from '@react-native-async-storage/async-storage';

import { getDeparturesForStops } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { syncDeparturesWidget, type WidgetBoard } from '@/lib/widgets';

export type { WidgetBoard as FavouriteBoard } from '@/lib/widgets';

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

/** Fetch the boards; a stop whose board fails is left out rather than failing the rest. */
export async function fetchFavouriteBoards(
  favourites: FavouriteStop[],
  signal?: AbortSignal,
): Promise<WidgetBoard[]> {
  const results = await Promise.allSettled(
    favourites.map(async (stop) => ({
        stop,
      departures: (await getDeparturesForStops(stop, { signal, retryWhileLoading: false })).departures,
    })),
  );
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/** Fetch and hand the widget a new timeline — what the background task runs. */
export async function refreshFavouriteBoards(favourites: FavouriteStop[], signal?: AbortSignal) {
  const boards = await fetchFavouriteBoards(favourites, signal);
  syncDeparturesWidget(favourites, boards, await lastPosition());
  return boards;
}
