import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

import type { VehicleDetail } from '@/lib/api';
import { colorFor } from '@/lib/lines';
import { tripProgress } from '@/lib/trip-progress';
import { endLiveActivity, showArrivalActivity, showTripActivity } from '@/lib/widgets';

/**
 * "Tell me when my tram is two minutes from this stop" — and its other half,
 * "tell me before I have to get off".
 *
 * Two kinds, one at a time:
 *
 * - **arrival** — the rider is waiting at a stop for this vehicle. The alert
 *   fires two minutes before it gets there.
 * - **trip** — the rider is on board and the stop is where they get off. The
 *   Live Activity counts the stops down, and the alert fires when the next
 *   stop is theirs.
 *
 * Both are *local* notifications, scheduled on the phone from the ETAs the
 * server already serves — no push service, no server state, no token. That is
 * why they exist without a backend dependency, and also their one limit: the
 * phone reschedules on every poll while the app runs, and once the app is
 * suspended the last schedule stands. A tram that loses time after that is
 * announced a little early, never silently dropped. The Live Activity, where
 * the server has an APNs key, keeps following the vehicle while suspended.
 *
 * It disarms itself when the stop is passed or the vehicle stops being
 * tracked, and outlives the notification: the tram is still two minutes out
 * when the banner has gone.
 */

/** How long before the arrival an arrival alert fires. */
export const ARRIVAL_LEAD_SECONDS = 120;
/**
 * A trip alert fires when the destination is the next stop — but never later
 * than this before it, because between two stops a long way apart "next stop"
 * arrives too late to stand up and make for the door.
 */
export const TRIP_LEAD_SECONDS = 90;
/** A reschedule that moves the alert by less than this is churn, not news. */
const RESCHEDULE_THRESHOLD_SECONDS = 15;

/**
 * iOS only for now. Android would need its own notification channel and a
 * small icon, and the web build has no local notifications; both hide the
 * control rather than offer something that cannot arrive.
 */
export const arrivalAlertsAvailable = Platform.OS === 'ios';

export type AlertKind = 'arrival' | 'trip';

export type ArrivalAlert = {
  kind: AlertKind;
  vehicleId: string;
  line: string;
  towards: string | null;
  /** The stop waited at (arrival), or got off at (trip). */
  stopId: string;
  stopName: string;
  /** Trip only: stops left, and how many there were when it was started. */
  stopsAway?: number;
  totalStops?: number;
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

async function cancelScheduled() {
  const id = armed?.notificationId;
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already delivered or already gone — either way it will not fire twice.
  }
}

const content = (alert: ArrivalAlert): Notifications.NotificationContentInput =>
  alert.kind === 'trip'
    ? {
        title: `Wysiadasz na następnym: ${alert.stopName}`,
        body: `Linia ${alert.line} — przygotuj się do wyjścia.`,
        sound: true,
      }
    : {
        title: `Linia ${alert.line}${alert.towards ? ` → ${alert.towards}` : ''}`,
        body: `Za około 2 min na przystanku ${alert.stopName}.`,
        sound: true,
      };

/** Refresh the lock-screen countdown from a fresh answer. */
function showActivity(alert: ArrivalAlert, detail: VehicleDetail) {
  const stop = detail.trip?.nextStops.find((entry) => entry.id === alert.stopId);
  if (!stop) return;
  const input = {
    vehicleId: alert.vehicleId,
    stopId: alert.stopId,
    line: alert.line,
    color: colorFor(detail.vehicle.type),
    towards: alert.towards,
    stopName: alert.stopName,
    arrivesAt: Date.now() + (stop.etaSeconds ?? 0) * 1_000,
    atStop: detail.trip?.atStop?.id === alert.stopId,
  };
  if (alert.kind === 'trip') {
    const progress = tripProgress(detail.trip, alert.stopId);
    if (!progress) return;
    showTripActivity({
      ...input,
      stopsAway: progress.stopsAway,
      totalStops: Math.max(alert.totalStops ?? progress.stopsAway, progress.stopsAway, 1),
      nextStop: progress.nextStop,
      nextStopAt: progress.nextStopEtaSeconds === null ? null : Date.now() + progress.nextStopEtaSeconds * 1_000,
    });
    return;
  }
  showArrivalActivity(input);
}

/**
 * When the alert should fire, given what the server just said — or `passed`
 * once the stop is behind the vehicle.
 *
 * A trip alert fires as the vehicle leaves the stop before the rider's — the
 * moment "next stop" becomes true — or `TRIP_LEAD_SECONDS` before arriving,
 * whichever is later. Either way, when it fires the next stop is theirs.
 */
export function alertFireTime(
  detail: VehicleDetail,
  alert: Pick<ArrivalAlert, 'kind' | 'stopId'>,
  now: number,
): { at: number } | { passed: true } {
  const stops = detail.trip?.nextStops ?? [];
  const index = stops.findIndex((entry) => entry.id === alert.stopId);
  const stop = stops[index];
  if (!stop || stop.etaSeconds === null || !Number.isFinite(stop.etaSeconds)) return { passed: true };
  if (alert.kind === 'trip') {
    const previous = index > 0 ? stops[index - 1].etaSeconds : null;
    const leaving = previous !== null && Number.isFinite(previous) ? previous : 0;
    const at = Math.max(leaving, stop.etaSeconds - TRIP_LEAD_SECONDS, 0);
    return { at: now + at * 1_000 };
  }
  return { at: now + Math.max(0, stop.etaSeconds - ARRIVAL_LEAD_SECONDS) * 1_000 };
}

async function schedule(at: number) {
  if (!armed) return;
  await cancelScheduled();
  const seconds = Math.max(1, Math.round((at - Date.now()) / 1_000));
  const id = await Notifications.scheduleNotificationAsync({
    content: content(armed),
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
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
   * Arm an alert for one stop of one vehicle, replacing whatever was armed.
   * Asks for permission the first time — at the moment the rider asked for
   * an alert, never at launch.
   */
  async arm(
    alert: Omit<ArrivalAlert, 'stopsAway' | 'totalStops'>,
    detail: VehicleDetail,
  ): Promise<'armed' | 'denied' | 'passed'> {
    if (!arrivalAlertsAvailable) return 'denied';
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return 'denied';

    const when = alertFireTime(detail, alert, Date.now());
    if ('passed' in when) return 'passed';
    const progress = alert.kind === 'trip' ? tripProgress(detail.trip, alert.stopId) : null;
    if (alert.kind === 'trip' && !progress) return 'passed';

    await cancelScheduled();
    endLiveActivity();
    armed = {
      ...alert,
      ...(progress ? { stopsAway: progress.stopsAway, totalStops: Math.max(progress.stopsAway, 1) } : null),
      notificationId: null,
      firesAt: null,
      delivered: false,
    };
    emit();
    showActivity(armed, detail);
    await schedule(when.at);
    return 'armed';
  },

  async disarm() {
    if (armed && !armed.delivered) await cancelScheduled();
    armed = null;
    endLiveActivity();
    emit();
  },

  /**
   * Follow a fresh answer from the server. Called on every detail poll for
   * the armed vehicle; reschedules only when the fire time actually moved.
   */
  async follow(detail: VehicleDetail) {
    if (!armed || detail.vehicle.id !== armed.vehicleId) return;
    const now = Date.now();
    const when = alertFireTime(detail, armed, now);
    if ('passed' in when) {
      await arrivalAlertStore.disarm();
      return;
    }
    if (armed.kind === 'trip') {
      const progress = tripProgress(detail.trip, armed.stopId);
      if (progress && progress.stopsAway !== armed.stopsAway) {
        armed = { ...armed, stopsAway: progress.stopsAway };
        emit();
      }
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
