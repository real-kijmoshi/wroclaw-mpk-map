import { useRouter } from 'expo-router';
import * as QuickActions from 'expo-quick-actions';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import type { FavouriteStop } from '@/lib/favourite-stops';
import { parseLink, stopAppUrl } from '@/lib/links';
import { mapIntentStore } from '@/lib/map-intent';

/**
 * The home-screen long-press menu: the first starred stops, then search.
 *
 * A rider standing at their stop with the app closed gets to its board in
 * two touches instead of four. Items are set at runtime from the favourites,
 * so starring a stop is all it takes; `expo-quick-actions` reads its native
 * module defensively and is a no-op in Expo Go and on the web.
 */

const MAX_STOP_ACTIONS = 3;
const SEARCH = 'search';

type StopAction = QuickActions.Action & { params?: { url?: string } | null };

function handle(action: StopAction | undefined, openSearch: () => void) {
  if (!action) return;
  if (action.id === SEARCH) {
    openSearch();
    return;
  }
  const target = typeof action.params?.url === 'string' ? parseLink(action.params.url) : null;
  if (target?.kind === 'stop') mapIntentStore.openStop(target.stop);
}

export function useQuickActions(favourites: FavouriteStop[]) {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    void QuickActions.setItems<StopAction>([
      ...favourites.slice(0, MAX_STOP_ACTIONS).map((stop) => ({
        id: `stop:${stop.id}`,
        title: stop.name,
        subtitle: 'Odjazdy na żywo',
        icon: 'symbol:star.fill',
        params: { url: stopAppUrl(stop) },
      })),
      { id: SEARCH, title: 'Szukaj', icon: 'search' },
    ]).catch(() => {});
  }, [favourites]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const openSearch = () => router.push('/search');
    // A cold launch from the menu: the action is waiting before any listener.
    handle(QuickActions.initial as StopAction | undefined, openSearch);
    const subscription = QuickActions.addListener<StopAction>((action) => handle(action, openSearch));
    return () => subscription.remove();
  }, [router]);
}
