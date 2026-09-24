import { useEffect, useMemo, useState } from 'react';

import { usePoll } from '@/hooks/use-poll';
import { fetchFavouriteBoards, lastPosition, rememberPosition, type FavouriteBoard, type TripBoard } from '@/lib/favourite-boards';
import type { FavouriteStop } from '@/lib/favourite-stops';
import type { FavouriteTrip } from '@/lib/favourite-trips';
import { syncDeparturesWidget } from '@/lib/widgets';

/** Often enough for the sheet's countdowns; the widget's timeline covers the gaps. */
const REFRESH_MS = 60_000;

/**
 * The starred stops' next departures, for the sheet — and, as a side effect,
 * the home-screen widget, which cannot fetch for itself.
 *
 * Fetches on launch, on every return to the foreground (usePoll fires
 * immediately then) and once a minute while open. Starring or unstarring
 * changes what is fetched; unstarring the last one clears the widget.
 */
export function useFavouriteBoards(
  favourites: FavouriteStop[],
  trips: FavouriteTrip[],
  userPosition: { lat: number; lon: number } | null,
) {
  const shown = favourites;
  // Ids only: renaming or reordering re-syncs the widget below without
  // fetching every board again.
  const key = [...shown.map((stop) => stop.id), ...trips.map((trip) => `trip:${trip.id}`)].sort().join(',');

  const boards = usePoll((signal) => fetchFavouriteBoards(shown, trips, signal), REFRESH_MS, {
    enabled: shown.length + trips.length > 0,
    key,
  });

  // The last position the phone remembers, until the rider locates again —
  // without it an app opened without tapping "locate" would hand the widget
  // no walk, wiping the estimate the background refresh had just drawn.
  const [remembered, setRemembered] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    void lastPosition().then(setRemembered);
  }, []);
  useEffect(() => {
    if (userPosition) void rememberPosition(userPosition);
  }, [userPosition]);
  const position = userPosition ?? remembered;

  // Only boards for the stops currently starred: a poll still in flight from
  // before an unstar must not put the old stop back on the widget.
  const current = useMemo(
    () => (boards.data?.stops ?? []).filter((board) => shown.some((stop) => stop.id === board.stop.id)),
    [boards.data, shown],
  );
  const tripBoards = useMemo(
    () => (boards.data?.trips ?? []).filter((board) => trips.some((trip) => trip.id === board.trip.id)),
    [boards.data, trips],
  );

  useEffect(() => {
    syncDeparturesWidget(
      { favourites: shown, boards: current, trips, tripBoards },
      position,
      boards.receivedAt ?? Date.now(),
    );
  }, [current, shown, trips, tripBoards, position, boards.receivedAt]);

  return { boards: current, tripBoards, receivedAt: boards.receivedAt };
}

export type { FavouriteBoard, TripBoard };
