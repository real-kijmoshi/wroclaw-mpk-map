import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerPush, unregisterPush } from '@/lib/api';

/**
 * The one place that talks to `expo-notifications` — same rule as
 * `updates.ts` next door, and for the same reason: this is the module whose
 * calls throw somewhere.
 *
 * Two features share it, and they are not the same thing:
 *
 *  - **A departure alarm** is *local*. Nothing leaves the phone: the OS is
 *    handed a time and a string. It works in Expo Go, it works with no
 *    network, and it works with the app closed.
 *  - **Disruption alerts** are *remote*. They need an Expo push token, which
 *    needs a real project id and, since SDK 53, a development or store build —
 *    Expo Go has no push credentials of its own on Android. Asking for one
 *    there throws, so `pushAvailable` gates every remote path and the settings
 *    screen says why rather than showing a switch that cannot work.
 *
 * Invariant 15 in AGENTS.md is the rule this has to satisfy: the notification
 * permission in `app.json` maps to this file, and this file is what uses it.
 * The permission is requested when a rider turns something on — never at
 * launch, where it is a question about nothing.
 */

/** Android shows nothing at all without a channel; the id matches the server's. */
const ALERTS_CHANNEL = 'alerts';
const ALARMS_CHANNEL = 'alarms';

/**
 * How long before a departure the alarm fires.
 *
 * Five minutes is the walk to most stops in this city plus the moment it takes
 * to put a coat on. An alarm that fires as the tram arrives is a notification
 * about a tram the rider has already missed.
 */
export const ALARM_LEAD_SECONDS = 5 * 60;

/**
 * A departure less than this away cannot be usefully alarmed: the notification
 * would fire immediately or in the past, which reads as a bug.
 */
const MIN_ALARM_SECONDS = 90;

/**
 * Expo Go cannot obtain a push token (SDK 53+), and neither can a simulator.
 * Both are normal development situations rather than errors, so they disable
 * the feature instead of failing it.
 */
export const pushAvailable =
  Device.isDevice && Constants.executionEnvironment !== 'storeClient';

/** The project the push token is issued against. */
const projectId =
  Constants.expoConfig?.extra?.eas?.projectId ??
  Constants.easConfig?.projectId ??
  null;

let handlerInstalled = false;

/**
 * Show a notification even while the app is open.
 *
 * The default is to stay silent in the foreground, which for this app is
 * exactly wrong: the rider is looking at the map *because* they are about to
 * travel, and "leave now" is the moment it matters most.
 */
export function installNotificationHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Create the Android channels.
 *
 * Two, deliberately: an alarm the rider set for themselves and a disruption
 * the city caused are different things to be woken by, and Android lets people
 * silence one without the other only if they are separate channels.
 */
async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ALARMS_CHANNEL, {
    name: 'Przypomnienia o odjazdach',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
  await Notifications.setNotificationChannelAsync(ALERTS_CHANNEL, {
    name: 'Utrudnienia',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/**
 * Ask for permission, if it has not already been answered.
 *
 * Returns false rather than throwing on a refusal: a rider who says no has
 * given an answer, and the caller's job is to reflect it in the UI.
 */
export async function requestPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) {
      await ensureChannels();
      return true;
    }
    // `canAskAgain` false means the rider has denied it at the system level;
    // asking again does nothing, so the caller is told no and can point at
    // Settings instead.
    if (!existing.canAskAgain) return false;

    const requested = await Notifications.requestPermissionsAsync();
    if (requested.granted) await ensureChannels();
    return requested.granted;
  } catch {
    return false;
  }
}

export type AlarmRequest = {
  line: string;
  headsign: string | null;
  stopName: string;
  /** Seconds from now until the vehicle leaves. */
  inSeconds: number;
  /** Identifies the run, so the same departure cannot be alarmed twice. */
  tripId: string;
};

/** The id an alarm is stored under, so it can be found and cancelled again. */
export const alarmId = (stopId: string, tripId: string) => `alarm:${stopId}:${tripId}`;

/**
 * Set a "leave now" alarm for one departure.
 *
 * @returns the seconds of warning it will actually give, or null if it could
 *   not be set — too soon, or permission refused.
 */
export async function scheduleDepartureAlarm(
  stopId: string,
  request: AlarmRequest,
): Promise<number | null> {
  if (request.inSeconds < MIN_ALARM_SECONDS) return null;
  if (!(await requestPermission())) return null;

  // Fire a lead time before departure, but never in the past: for a departure
  // between the minimum and the lead time, warn as soon as possible instead of
  // refusing outright.
  const fireIn = Math.max(30, Math.round(request.inSeconds - ALARM_LEAD_SECONDS));
  const minutes = Math.round((request.inSeconds - fireIn) / 60);

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: alarmId(stopId, request.tripId),
      content: {
        title: `${request.line} → ${request.headsign ?? request.stopName}`,
        body:
          minutes >= 1
            ? `Odjazd z ${request.stopName} za ${minutes} min. Czas wyjść.`
            : `Odjazd z ${request.stopName} lada moment.`,
        sound: 'default',
        data: { type: 'alarm', stopId, tripId: request.tripId },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: fireIn,
        channelId: ALARMS_CHANNEL,
      },
    });
    return request.inSeconds - fireIn;
  } catch {
    return null;
  }
}

export async function cancelDepartureAlarm(stopId: string, tripId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(alarmId(stopId, tripId));
  } catch {
    // Cancelling an alarm that already fired is not a failure.
  }
}

/** Which alarms are still pending, as `alarmId` keys. */
export async function pendingAlarms(): Promise<Set<string>> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return new Set(
      scheduled
        .map((entry) => entry.identifier)
        .filter((identifier) => identifier.startsWith('alarm:')),
    );
  } catch {
    return new Set();
  }
}

/**
 * Tell the server which lines this phone wants disruption alerts for.
 *
 * An empty list means the whole network, which is what a rider who turned
 * alerts on without pinning anything is asking for. Re-registering replaces
 * the list, so this is called again whenever the pinned lines change.
 *
 * @returns the push token on success, or null with the reason unreported —
 *   the caller shows a switch that did not turn on, which is the honest UI.
 */
export async function enablePushAlerts(lines: string[]): Promise<string | null> {
  if (!pushAvailable || !projectId) return null;
  if (!(await requestPermission())) return null;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await registerPush(token, Platform.OS, lines);
    return token;
  } catch {
    return null;
  }
}

export async function disablePushAlerts(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await unregisterPush(token);
  } catch {
    // The phone has stopped asking for them either way; the server drops the
    // token by itself the first time a send comes back DeviceNotRegistered.
  }
}
