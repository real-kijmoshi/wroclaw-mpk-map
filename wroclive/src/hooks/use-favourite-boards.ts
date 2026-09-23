import { useEffect, useMemo } from 'react';

import { usePoll } from '@/hooks/use-poll';
import { fetchFavouriteBoards, rememberPosition, type FavouriteBoard } from '@/lib/favourite-boards';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { syncDeparturesWidget, WIDGET_STOPS } from '@/lib/widgets';

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
  userPosition: { lat: number; lon: number } | null,
) {
  const shown = useMemo(() => favourites.slice(0, WIDGET_STOPS), [favourites]);
  const key = shown.map((stop) => stop.id).join(',');

  const boards = usePoll((signal) => fetchFavouriteBoards(shown, signal), REFRESH_MS, {
    enabled: shown.length > 0,
    key,
  });

  useEffect(() => {
    if (userPosition) void rememberPosition(userPosition);
  }, [userPosition]);

  // Only boards for the stops currently starred: a poll still in flight from
  // before an unstar must not put the old stop back on the widget.
  const current = useMemo(
    () => (boards.data ?? []).filter((board) => shown.some((stop) => stop.id === board.stop.id)),
    [boards.data, shown],
  );

  useEffect(() => {
    syncDeparturesWidget(shown.length ? current : [], userPosition, boards.receivedAt ?? Date.now());
  }, [current, shown.length, userPosition, boards.receivedAt]);

  return { boards: current, receivedAt: boards.receivedAt };
}

export type { FavouriteBoard };
