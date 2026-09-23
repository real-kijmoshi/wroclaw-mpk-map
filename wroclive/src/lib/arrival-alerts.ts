import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

import type { VehicleDetail } from '@/lib/api';
import { colorFor } from '@/lib/lines';
import { endArrivalActivity, showArrivalActivity } from '@/lib/widgets';

/**
 * "Tell me when my tram is two minutes from this stop."
 *
 * A *local* notification, scheduled on the phone from the ETA the server
 * already serves — no push service, no server state, no token. That is the
 * whole reason it can exist without a backend change, and also its one limit:
 * the phone reschedules it on every poll while the app is running, and once
 * the app is suspended the last schedule stands. A tram that loses time after
 * that is announced a little early, never silently dropped.
 *
 * One alert at a time. It is armed from a stop row in the vehicle sheet and
 * disarms itself when the stop is passed or the vehicle stops being tracked.
 * On iOS it also drives a Live Activity — the same countdown on the lock
 * screen and in the Dynamic Island — which is why it outlives the
 * notification: the tram is still two minutes out when the banner has gone.
 */

/** How long before the arrival the alert fires. */
export const ARRIVAL_LEAD_SECONDS = 120;
/** A reschedule that moves the alert by less than this is churn, not news. */
const RESCHEDULE_THRESHOLD_SECONDS = 15;
const ANDROID_CHANNEL = 'arrivals';

/** Local notifications are a native feature; the web build hides the control. */
export const arrivalAlertsAvailable = Platform.OS === 'ios' || Platform.OS === 'android';

export type ArrivalAlert = {
  vehicleId: string;
  line: string;
  towards: string | null;
  stopId: string;
  stopName: string;
};

type Armed = ArrivalAlert & {
  notificationId: string | null;
  /** Epoch ms the scheduled notification fires at. */
  firesAt: number | null;
  /** The notification has gone out; only the Live Activity is still following. */
  delivered: boolean;
};

let armed: Armed | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

if (arrivalAlertsAvailable) {
  // Shown while the app is open too: the rider may be looking at the map when
  // their tram is due, and a swallowed alert is the one they asked for.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

let channelReady = false;
async function ensureChannel() {
  if (Platform.OS !== 'android' || channelReady) return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: 'Przyjazdy',
    importance: Notifications.AndroidImportance.HIGH,
  });
  channelReady = true;
}

async function cancelScheduled() {
  const id = armed?.notificationId;
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already delivered or already gone — either way it will not fire twice.
  }
}

const content = (alert: ArrivalAlert): Notifications.NotificationContentInput => ({
  title: `Linia ${alert.line}${alert.towards ? ` → ${alert.towards}` : ''}`,
  body: `Za około 2 min na przystanku ${alert.stopName}.`,
  sound: true,
});

/** Refresh the lock-screen countdown from a fresh answer. */
function showActivity(alert: ArrivalAlert, detail: VehicleDetail) {
  const stop = detail.trip?.nextStops.find((entry) => entry.id === alert.stopId);
  if (!stop) return;
  showArrivalActivity({
    vehicleId: alert.vehicleId,
    line: alert.line,
    color: colorFor(detail.vehicle.type),
    towards: alert.towards,
    stopName: alert.stopName,
    arrivesAt: Date.now() + (stop.etaSeconds ?? 0) * 1_000,
    atStop: detail.trip?.atStop?.id === alert.stopId,
  });
}

/** When the alert should fire, given what the server just said, or null if the stop is behind. */
export function alertFireTime(
  detail: VehicleDetail,
  stopId: string,
  now: number,
): { at: number } | { passed: true } {
  const stop = detail.trip?.nextStops.find((entry) => entry.id === stopId);
  if (!stop || !Number.isFinite(stop.etaSeconds)) return { passed: true };
  return { at: now + Math.max(0, (stop.etaSeconds as number) - ARRIVAL_LEAD_SECONDS) * 1_000 };
}

async function schedule(at: number) {
  if (!armed) return;
  await cancelScheduled();
  await ensureChannel();
  const seconds = Math.max(1, Math.round((at - Date.now()) / 1_000));
  const id = await Notifications.scheduleNotificationAsync({
    content: content(armed),
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
      channelId: Platform.OS === 'android' ? ANDROID_CHANNEL : undefined,
    },
  });
  if (armed) {
    armed = { ...armed, notificationId: id, firesAt: at };
    emit();
  }
}

export const arrivalAlertStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): ArrivalAlert | null => armed,

  /**
   * Arm an alert for one stop of one vehicle. Asks for permission the first
   * time — at the moment the rider asked for an alert, never at launch.
   */
  async arm(alert: ArrivalAlert, detail: VehicleDetail): Promise<'armed' | 'denied' | 'passed'> {
    if (!arrivalAlertsAvailable) return 'denied';
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return 'denied';

    const when = alertFireTime(detail, alert.stopId, Date.now());
    if ('passed' in when) return 'passed';

    await cancelScheduled();
    armed = { ...alert, notificationId: null, firesAt: null, delivered: false };
    emit();
    showActivity(alert, detail);
    await schedule(when.at);
    return 'armed';
  },

  async disarm() {
    if (armed && !armed.delivered) await cancelScheduled();
    armed = null;
    endArrivalActivity();
    emit();
  },

  /**
   * Follow a fresh answer from the server. Called on every detail poll for
   * the armed vehicle; reschedules only when the fire time actually moved.
   */
  async follow(detail: VehicleDetail) {
    if (!armed || detail.vehicle.id !== armed.vehicleId) return;
    const now = Date.now();
    const when = alertFireTime(detail, armed.stopId, now);
    if ('passed' in when) {
      await arrivalAlertStore.disarm();
      return;
    }
    showActivity(armed, detail);
    if (armed.firesAt !== null && armed.firesAt <= now) {
      // The banner has gone out; the Live Activity follows on until the stop.
      if (!armed.delivered) armed = { ...armed, delivered: true };
      return;
    }
    if (
      armed.firesAt === null ||
      Math.abs(when.at - armed.firesAt) > RESCHEDULE_THRESHOLD_SECONDS * 1_000
    ) {
      await schedule(when.at);
    }
  },
};

export function useArrivalAlert(): ArrivalAlert | null {
  return useSyncExternalStore(
    arrivalAlertStore.subscribe,
    arrivalAlertStore.getSnapshot,
    arrivalAlertStore.getSnapshot,
  );
}
