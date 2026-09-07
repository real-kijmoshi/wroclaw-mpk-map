import { useMemo } from 'react';

import { usePoll } from '@/hooks/use-poll';
import { getDepartures, type Departure } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourites';

/**
 * The next couple of departures from each pinned stop.
 *
 * A favourites list without times is a list of names — the rider still has to
 * tap through to learn the one thing they opened the app for. So the section
 * carries live minutes, which means a request per stop.
 *
 * That is the whole reason for `BOARDS_LIMIT`. Twelve favourites would be
 * twelve round trips on a phone that has just come out of a pocket, every
 * thirty seconds, for rows that are mostly below the fold. Only the stops
 * actually on screen get boards; the rest are names until they are tapped,
 * which is what they were before.
 */
const BOARDS_LIMIT = 4;

/** Two is a glance. Three is a board, and this is not the board. */
const PER_STOP = 2;

const REFRESH_MS = 30_000;

export type FavouriteBoard = {
  stopId: string;
  departures: Departure[];
};

export function useFavouriteBoards(
  stops: FavouriteStop[],
  { enabled = true }: { enabled?: boolean } = {},
): Map<string, Departure[]> {
  const wanted = useMemo(() => stops.slice(0, BOARDS_LIMIT), [stops]);
  // The key is what tells the poll to start over: pinning a stop must refetch
  // now rather than at the end of the current thirty seconds.
  const key = wanted.map((stop) => stop.id).join(',');

  const poll = usePoll<FavouriteBoard[]>(
    async (signal) => {
      if (!wanted.length) return [];
      const boards = await Promise.all(
        wanted.map(async (stop) => {
          try {
            const board = await getDepartures(stop.id, {
              signal,
              limit: PER_STOP,
              within: 120,
              // A favourites row is a nicety; a still-booting server should
              // leave it blank and let the map get on with loading.
              retryWhileLoading: false,
            });
            return { stopId: stop.id, departures: board.departures };
          } catch {
            // One stop failing must not blank the others.
            return { stopId: stop.id, departures: [] };
          }
        }),
      );
      return boards;
    },
    REFRESH_MS,
    { enabled: enabled && wanted.length > 0, key },
  );

  return useMemo(() => {
    const byStop = new Map<string, Departure[]>();
    for (const board of poll.data ?? []) byStop.set(board.stopId, board.departures);
    return byStop;
  }, [poll.data]);
}
