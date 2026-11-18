import { requireOptionalNativeModule } from 'expo';

import { refreshFavouriteBoards } from '@/lib/favourite-boards';
import { favouriteStopsStore, hydrateFavouriteStops } from '@/lib/favourite-stops';
import { favouriteTripsStore, hydrateFavouriteTrips } from '@/lib/favourite-trips';
import { getIncidents } from '@/lib/api';
import { checkIncidents } from '@/lib/incident-alerts';
import { hydratePreferences, preferencesStore } from '@/lib/preferences';
import { hydrateSelection } from '@/lib/selection';
import { widgetsAvailable } from '@/lib/widgets';

/**
 * Keeps the home-screen widget going while the app is closed.
 *
 * The widget's own timeline runs as far as the last fetched boards reach;
 * after that it can only say "open the app". iOS wakes the app now and then
 * (BGTaskScheduler, via `expo-background-task`) and each wake fetches the
 * starred stops' boards and hands the widget a new timeline. So this makes
 * the widget fresh more often; it cannot make it live, and nothing here may
 * assume it ran.
 *
 * It is an *app refresh* task, not the processing task the package ships:
 * iOS ran that mostly overnight on the charger, so through the day the widget
 * was as old as the last time the app was opened. App refresh runs through the
 * day, as often as iOS judges the rider uses the app — opened daily, a few
 * times a day; never after the app is swiped away in the switcher, nor with
 * Background App Refresh off. `patches/expo-background-task+57.0.22.patch`
 * swaps the request type and `plugins/with-app-refresh.js` the background
 * mode (`fetch` for `processing`); both are native, so a store build.
 *
 * Neither module is in Expo Go, and both resolve their native module at
 * module scope, so they are required only once present — the same guard as
 * `widgets.ios.ts`. The task has to be *defined* at module scope, before the
 * app renders: that is how a cold background launch finds it.
 */

const TASK = 'wroclive.refresh-widget';
/** Minutes. iOS treats it as a floor, and usually waits longer. */
const MINIMUM_INTERVAL = 15;

const available =
  widgetsAvailable &&
  requireOptionalNativeModule('ExpoBackgroundTask') !== null &&
  requireOptionalNativeModule('ExpoTaskManager') !== null;

/* eslint-disable @typescript-eslint/no-require-imports */
const TaskManager: typeof import('expo-task-manager') | null = available ? require('expo-task-manager') : null;
const BackgroundTask: typeof import('expo-background-task') | null = available
  ? require('expo-background-task')
  : null;
/* eslint-enable @typescript-eslint/no-require-imports */

if (TaskManager && BackgroundTask) {
  TaskManager.defineTask(TASK, async () => {
    try {
      // A background launch starts cold: nothing has read storage yet.
      await Promise.all([hydrateFavouriteStops(), hydrateFavouriteTrips(), hydratePreferences(), hydrateSelection()]);
      // Independent jobs: a failed board fetch must not cost the incident
      // check, nor the other way round.
      const [boards] = await Promise.allSettled([
        refreshFavouriteBoards(favouriteStopsStore.getSnapshot(), favouriteTripsStore.getSnapshot()),
        preferencesStore.getSnapshot().incidentAlerts === 'off'
          ? Promise.resolve()
          : getIncidents({ retryWhileLoading: false }).then((response) => checkIncidents(response.incidents)),
      ]);
      return boards.status === 'fulfilled'
        ? BackgroundTask.BackgroundTaskResult.Success
        : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** Ask iOS to schedule the refresh. Idempotent; a refusal costs only freshness. */
export async function registerBackgroundRefresh() {
  if (!TaskManager || !BackgroundTask) return;
  try {
    // Registered options persist across launches and builds, so a phone that
    // registered under an older interval keeps it unless it is re-registered.
    const registered = (await TaskManager.getRegisteredTasksAsync()).find((task) => task.taskName === TASK);
    const interval = (registered?.options as { minimumInterval?: number } | undefined)?.minimumInterval;
    if (registered && interval !== MINIMUM_INTERVAL) await BackgroundTask.unregisterTaskAsync(TASK);
    if (!registered || interval !== MINIMUM_INTERVAL) {
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: MINIMUM_INTERVAL });
    }
  } catch {
    // Background App Refresh switched off, or unavailable: the widget still
    // refreshes whenever the app is opened.
  }
}
