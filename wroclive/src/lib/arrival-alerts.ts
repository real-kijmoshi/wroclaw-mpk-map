import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

import type { VehicleDetail } from '@/lib/api';
import { ACCENT } from '@/constants/theme';
import { alertFireTime as fireTimeFor, type AlertTiming } from '@/lib/alert-timing';
import { plural } from '@/lib/format';
import { colorFor } from '@/lib/lines';
import { preferencesStore } from '@/lib/preferences';
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
 * A trip holds its final "get off here" state for one minute after the stop is
 * passed, then clears itself. Arrival alerts clear as soon as their vehicle is
 * no longer tracked.
 */

/** Defaults retained for callers and old tests that do not supply preferences. */
export const ARRIVAL_LEAD_SECONDS = 120;
export const TRIP_LEAD_STOPS = 1;
/** A reschedule that moves the alert by less than this is churn, not news. */
const RESCHEDULE_THRESHOLD_SECONDS = 15;

/** A restored trip older than this is not a trip anyone is still taking. */
const MAX_PERSISTED_AGE_MS = 6 * 60 * 60 * 1_000;
/** Keep the in-app arrival instruction long enough to survive the doors opening. */
const COMPLETED_HOLD_MS = 60_000;
const STORAGE_KEY = 'wroclive.arrival-alert.v1';
const ALERT_CHANNEL = 'arrival-alerts';
const TRIP_CHANNEL = 'active-trip';
/** Stable so Android updates one ongoing card instead of stacking a new one per stop. */
const TRIP_NOTIFICATION_ID = 'wroclive-active-trip';

/**
 * Local notifications work on both native platforms. iOS additionally gets
 * the Live Activity; Android gets an ongoing notification on its own quiet
 * channel. The web build has neither and hides the control.
 */
export const arrivalAlertsAvailable = Platform.OS !== 'web';

export type AlertKind = 'arrival' | 'trip';
export type TripPhase = 'active' | 'arrived' | 'completed';

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
  /** Trip only: enough live progress for every in-app surface to say the same thing. */
  phase?: TripPhase;
  arrivesAt?: number | null;
  nextStop?: string;
  nextStopAt?: number | null;
};

type Armed = ArrivalAlert & {
  notificationId: string | null;
  /** Epoch ms the scheduled notification fires at. */
  firesAt: number | null;
  /** The notification has gone out; only the Live Activity is still following. */
  delivered: boolean;
  armedAt: number;
  completedAt: number | null;
};

let armed: Armed | null = null;
let completionTimer: ReturnType<typeof setTimeout> | null = null;
let persistence = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

if (arrivalAlertsAvailable) {
  // Shown while the app is open too: the rider may be looking at the map when
  // their tram is due, and a swallowed alert is the one they asked for.
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => ({
      // The ongoing Android card is updated in place; presenting every refresh
      // as a new heads-up banner would turn a quiet trip status into spam.
      shouldShowBanner: notification.request.identifier !== TRIP_NOTIFICATION_ID,
      shouldShowList: true,
      shouldPlaySound: notification.request.identifier !== TRIP_NOTIFICATION_ID,
      shouldSetBadge: false,
    }),
  });
}

/** Channels are runtime configuration and do not add a remote-push capability. */
async function ensureNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Promise.all([
    Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
      name: 'Powiadomienia o przejeździe',
      description: 'Powiadomienie przed przyjazdem lub przystankiem wysiadania.',
      importance: Notifications.AndroidImportance.HIGH,
      enableVibrate: true,
      sound: 'default',
    }),
    Notifications.setNotificationChannelAsync(TRIP_CHANNEL, {
      name: 'Trwający przejazd',
      description: 'Ciche, bieżące informacje o śledzonym przejeździe.',
      importance: Notifications.AndroidImportance.LOW,
      enableVibrate: false,
      sound: null,
    }),
  ]);
}

const persist = () => {
  const snapshot = armed;
  persistence = persistence
    .then(() =>
      snapshot
        ? AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
        : AsyncStorage.removeItem(STORAGE_KEY),
    )
    .catch(() => {
      // The notification and Live Activity still work for this session. A
      // failed convenience restore must never interrupt the ride itself.
    });
};

const scheduleCompletedClear = () => {
  if (completionTimer) clearTimeout(completionTimer);
  completionTimer = null;
  if (!armed?.completedAt || armed.phase !== 'completed') return;
  const remaining = Math.max(0, armed.completedAt + COMPLETED_HOLD_MS - Date.now());
  completionTimer = setTimeout(() => {
    completionTimer = null;
    if (armed?.phase === 'completed') void arrivalAlertStore.disarm();
  }, remaining);
};

const commit = (next: Armed | null) => {
  armed = next;
  persist();
  scheduleCompletedClear();
  emit();
};

function isStoredArmed(value: unknown): value is Armed {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'arrival' || record.kind === 'trip') &&
    typeof record.vehicleId === 'string' &&
    typeof record.line === 'string' &&
    (typeof record.towards === 'string' || record.towards === null) &&
    typeof record.stopId === 'string' &&
    typeof record.stopName === 'string' &&
    (record.notificationId === null || typeof record.notificationId === 'string') &&
    (record.firesAt === null || typeof record.firesAt === 'number') &&
    typeof record.delivered === 'boolean' &&
    typeof record.armedAt === 'number' &&
    (record.completedAt === null || typeof record.completedAt === 'number')
  );
}

/** Restore the in-app half of a notification/Live Activity after process death. */
export async function hydrateArrivalAlert() {
  if (!arrivalAlertsAvailable) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isStoredArmed(parsed)) {
      if (raw) await AsyncStorage.removeItem(STORAGE_KEY);
      return;
    }
    const expiry = parsed.phase === 'completed' && parsed.completedAt
      ? parsed.completedAt + COMPLETED_HOLD_MS
      : parsed.armedAt + MAX_PERSISTED_AGE_MS;
    if (expiry <= Date.now()) {
      await AsyncStorage.removeItem(STORAGE_KEY);
      return;
    }
    armed = parsed;
    scheduleCompletedClear();
    emit();
    await ensureNotificationChannels();
    await syncOngoingTrip();
  } catch {
    // A corrupt or unavailable preference loses the restore, not the alert
    // already scheduled by the operating system.
  }
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

async function dismissOngoingTrip() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.dismissNotificationAsync(TRIP_NOTIFICATION_ID);
  } catch {
    // It may not have been presented yet, or Android already removed it.
  }
}

/** Android's glanceable counterpart to the iOS Live Activity. */
async function syncOngoingTrip() {
  if (Platform.OS !== 'android' || armed?.kind !== 'trip' || armed.phase === 'completed') return;
  const stops = armed.stopsAway;
  const body =
    armed.phase === 'arrived'
      ? 'Wysiądź tutaj.'
      : stops === 1
        ? 'Następny przystanek — przygotuj się do wyjścia.'
        : [
            armed.nextStop ? `Następny: ${armed.nextStop}` : null,
            typeof stops === 'number'
              ? `jeszcze ${stops} ${plural(stops, ['przystanek', 'przystanki', 'przystanków'])}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ');
  await Notifications.scheduleNotificationAsync({
    identifier: TRIP_NOTIFICATION_ID,
    content: {
      title:
        armed.phase === 'arrived'
          ? `${armed.stopName} — wysiądź tutaj`
          : `Linia ${armed.line} · wysiadasz: ${armed.stopName}`,
      body,
      sound: false,
      color: ACCENT.light,
      sticky: true,
      autoDismiss: false,
    },
    trigger: { channelId: TRIP_CHANNEL },
  });
}

const content = (alert: ArrivalAlert): Notifications.NotificationContentInput => {
  const timing = preferencesStore.getSnapshot();
  return alert.kind === 'trip'
    ? {
        title:
          timing.tripLeadStops === 1
            ? `Wysiadasz na następnym: ${alert.stopName}`
            : `Za ${timing.tripLeadStops} przystanki: ${alert.stopName}`,
        body: `Linia ${alert.line} — przygotuj się do wyjścia.`,
        sound: true,
      }
    : {
        title: `Linia ${alert.line}${alert.towards ? ` → ${alert.towards}` : ''}`,
        body: `Za około ${Math.round(timing.arrivalLeadSeconds / 60)} min na przystanku ${alert.stopName}.`,
        sound: true,
      };
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

/** The alert's fire time under the rider's current settings. */
export const alertFireTime = (
  detail: VehicleDetail,
  alert: Pick<ArrivalAlert, 'kind' | 'stopId'>,
  now: number,
  timing: AlertTiming = preferencesStore.getSnapshot(),
) => fireTimeFor(detail, alert, now, timing);

/** One armed alert across the copies `commit()` makes of it as it is followed. */
const sameAlert = (a: Armed | null, b: Armed) =>
  a !== null &&
  a.armedAt === b.armedAt &&
  a.kind === b.kind &&
  a.vehicleId === b.vehicleId &&
  a.stopId === b.stopId;

/**
 * Overlapping polls each reschedule; run in parallel, both cancel the old
 * notification, both schedule a new one, and the one whose id is overwritten
 * fires anyway — the rider is told twice. So schedules run one at a time.
 */
let scheduling = Promise.resolve();

function schedule(at: number) {
  const run = scheduling.then(() => scheduleNow(at));
  scheduling = run.catch(() => {});
  return run;
}

async function scheduleNow(at: number) {
  const owner = armed;
  if (!owner) return;
  await cancelScheduled();
  if (!sameAlert(armed, owner)) return;
  const seconds = Math.max(1, Math.round((at - Date.now()) / 1_000));
  const id = await Notifications.scheduleNotificationAsync({
    content: content(owner),
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds,
      ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL } : {}),
    },
  });
  const current = armed;
  if (!current || !sameAlert(current, owner)) {
    // Disarmed or replaced while this was scheduling: nothing would ever
    // cancel it, and it would announce a vehicle the rider let go.
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    return;
  }
  commit({ ...current, notificationId: id, firesAt: at });
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
    await ensureNotificationChannels();
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
    await dismissOngoingTrip();
    endLiveActivity();
    const now = Date.now();
    const destination = detail.trip?.nextStops.find((entry) => entry.id === alert.stopId);
    const next: Armed = {
      ...alert,
      ...(progress
        ? {
            stopsAway: progress.stopsAway,
            totalStops: Math.max(progress.stopsAway, 1),
            phase: progress.arrived ? ('arrived' as const) : ('active' as const),
            arrivesAt:
              progress.etaSeconds === null ? null : now + Math.max(0, progress.etaSeconds) * 1_000,
            nextStop: progress.nextStop,
            nextStopAt:
              progress.nextStopEtaSeconds === null
                ? null
                : now + Math.max(0, progress.nextStopEtaSeconds) * 1_000,
          }
        : {
            phase: 'active' as const,
            arrivesAt:
              destination?.etaSeconds === null || destination?.etaSeconds === undefined
                ? null
                : now + Math.max(0, destination.etaSeconds) * 1_000,
          }),
      notificationId: null,
      firesAt: null,
      delivered: false,
      armedAt: now,
      completedAt: null,
    };
    commit(next);
    showActivity(next, detail);
    await schedule(when.at);
    await syncOngoingTrip();
    return 'armed';
  },

  async disarm() {
    if (armed && !armed.delivered) await cancelScheduled();
    await dismissOngoingTrip();
    commit(null);
    endLiveActivity();
  },

  /** The followed vehicle vanished after reaching the destination. */
  async finish() {
    if (!armed) return;
    if (armed.kind !== 'trip' || armed.phase !== 'arrived') {
      await arrivalAlertStore.disarm();
      return;
    }
    const now = Date.now();
    if (!armed.delivered) await cancelScheduled();
    await dismissOngoingTrip();
    endLiveActivity();
    commit({
      ...armed,
      phase: 'completed',
      stopsAway: 0,
      arrivesAt: now,
      notificationId: null,
      firesAt: null,
      delivered: true,
      completedAt: now,
    });
  },

  /**
   * Follow a fresh answer from the server. Called on every detail poll for
   * the armed vehicle; reschedules only when the fire time actually moved.
   */
  async follow(detail: VehicleDetail) {
    if (!armed || detail.vehicle.id !== armed.vehicleId) return;
    if (armed.phase === 'completed') return;
    const now = Date.now();
    if (armed.kind === 'trip') {
      const progress = tripProgress(detail.trip, armed.stopId);
      if (!progress) {
        await arrivalAlertStore.finish();
        return;
      }

      const next: Armed = {
        ...armed,
        phase: progress.arrived ? 'arrived' : 'active',
        stopsAway: progress.stopsAway,
        totalStops: Math.max(armed.totalStops ?? progress.stopsAway, progress.stopsAway, 1),
        arrivesAt: progress.etaSeconds === null ? null : now + Math.max(0, progress.etaSeconds) * 1_000,
        nextStop: progress.nextStop,
        nextStopAt:
          progress.nextStopEtaSeconds === null
            ? null
            : now + Math.max(0, progress.nextStopEtaSeconds) * 1_000,
      };
      const progressChanged =
        next.phase !== armed.phase ||
        next.stopsAway !== armed.stopsAway ||
        next.nextStop !== armed.nextStop;
      if (progress.arrived && !armed.delivered) {
        await cancelScheduled();
        next.notificationId = null;
        next.firesAt = null;
        next.delivered = true;
      }
      commit(next);
      if (progressChanged) await syncOngoingTrip();
      showActivity(next, detail);
      if (progress.arrived) return;
    }

    const when = alertFireTime(detail, armed, now);
    if ('passed' in when) {
      await arrivalAlertStore.disarm();
      return;
    }
    // A trip's activity was already refreshed from its progress above.
    if (armed.kind !== 'trip') showActivity(armed, detail);
    if (armed.firesAt !== null && armed.firesAt <= now) {
      // The banner has gone out; the Live Activity follows on until the stop.
      if (!armed.delivered) commit({ ...armed, delivered: true });
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
