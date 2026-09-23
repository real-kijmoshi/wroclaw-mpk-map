import { requireOptionalNativeModule } from 'expo';

import { refreshFavouriteBoards } from '@/lib/favourite-boards';
import { favouriteStopsStore, hydrateFavouriteStops } from '@/lib/favourite-stops';
import { widgetsAvailable } from '@/lib/widgets';

/**
 * Keeps the home-screen widget going while the app is closed.
 *
 * The widget's own timeline covers half an hour; after that it can only say
 * "open the app". iOS will wake the app now and then (BGTaskScheduler, via
 * `expo-background-task`) — how often is the system's call, typically when
 * the phone is idle and charged, never on a schedule — and each wake fetches
 * the starred stops' boards and hands the widget a new timeline. So this makes
 * the widget fresh more often; it cannot make it live, and nothing here may
 * assume it ran.
 *
 * Neither module is in Expo Go, and both resolve their native module at
 * module scope, so they are required only once present — the same guard as
 * `widgets.ios.ts`. The task has to be *defined* at module scope, before the
 * app renders: that is how a cold background launch finds it.
 */

const TASK = 'wroclive.refresh-widget';
/** Minutes. iOS treats it as a floor, and usually waits longer. */
const MINIMUM_INTERVAL = 30;

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
      await hydrateFavouriteStops();
      await refreshFavouriteBoards(favouriteStopsStore.getSnapshot());
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** Ask iOS to schedule the refresh. Idempotent; a refusal costs only freshness. */
export async function registerBackgroundRefresh() {
  if (!TaskManager || !BackgroundTask) return;
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(TASK))) {
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: MINIMUM_INTERVAL });
    }
  } catch {
    // Background App Refresh switched off, or unavailable: the widget still
    // refreshes whenever the app is opened.
  }
}
