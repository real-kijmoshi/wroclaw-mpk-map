import { useEffect } from 'react';

import { usePoll } from '@/hooks/use-poll';
import { getDeparturesForStops } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { syncDeparturesWidget, widgetsAvailable } from '@/lib/widgets';

/** The widget's timeline covers half an hour; refreshing well inside it keeps it whole. */
const WIDGET_REFRESH_MS = 5 * 60_000;

/**
 * Keeps the home-screen widget showing the first starred stop.
 *
 * The widget cannot fetch, so the app does it for it: on launch, on every
 * return to the foreground (usePoll fires immediately then), and every few
 * minutes while open. Starring or unstarring changes which stop it shows, and
 * unstarring the last one puts the widget back to its "add a favourite" state.
 * Inert where there are no widgets.
 */
export function useWidgetSync(favourites: FavouriteStop[]) {
  const stop = favourites[0] ?? null;

  const board = usePoll(
    (signal) => getDeparturesForStops(stop as FavouriteStop, { signal, retryWhileLoading: false }),
    WIDGET_REFRESH_MS,
    { enabled: widgetsAvailable && stop !== null, key: stop?.id ?? '' },
  );

  useEffect(() => {
    if (!widgetsAvailable) return;
    if (!stop) {
      syncDeparturesWidget(null, null);
      return;
    }
    // Only a board for the stop the widget is about; a stale one from the
    // previously starred stop must not be drawn under the new name.
    if (board.data && board.data.stop.id === stop.id) {
      syncDeparturesWidget(stop, board.data.departures, board.receivedAt ?? Date.now());
    }
  }, [stop, board.data, board.receivedAt]);
}
