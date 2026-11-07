import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

import type { Departure } from '@/lib/api';
import { departureSeconds } from '@/lib/departures';
import type { FavouriteTrip } from '@/lib/favourite-trips';
import type { TripBoard } from '@/lib/widgets';
import { followLeaveAlert } from '@/lib/leave-timing';
import { leaveInSeconds } from '@/lib/walking';

/** A one-shot reminder to leave home for one departure of a saved journey. */
export type LeaveAlert = {
  favouriteTripId: string;
  favouriteTripTitle: string;
  departureTripId: string;
  departureClock: string;
  serviceDay: Departure['serviceDay'];
  line: string;
  originName: string;
  destinationName: string;
  /** Epoch milliseconds. */
  departureAt: number;
  /** Epoch milliseconds. */
  firesAt: number;
  walkSeconds: number;
  notificationId: string;
  armedAt: number;
};

const STORAGE_KEY = 'wroclive.leave-alert.v1';
const CHANNEL = 'leave-alerts';
const MAX_RESTORE_AGE_MS = 8 * 60 * 60 * 1_000;

export const leaveAlertsAvailable = Platform.OS !== 'web';

let armed: LeaveAlert | null = null;
/**
 * Bumped by every arm and disarm. An operation that awaited across one of
 * those is stale: committing its result would undo what the rider just did,
 * and its notification would belong to nobody.
 */
let generation = 0;
let persistence = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

const commit = (next: LeaveAlert | null) => {
  armed = next;
  const snapshot = next;
  persistence = persistence
    .then(() =>
      snapshot
        ? AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
        : AsyncStorage.removeItem(STORAGE_KEY),
    )
    .catch(() => {
      // The scheduled operating-system notification still works this session.
    });
  emit();
};

const isStored = (value: unknown): value is LeaveAlert => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.favouriteTripId === 'string' &&
    typeof record.favouriteTripTitle === 'string' &&
    typeof record.departureTripId === 'string' &&
    typeof record.departureClock === 'string' &&
    (record.serviceDay === 'today' || record.serviceDay === 'yesterday' || record.serviceDay === 'tomorrow') &&
    typeof record.line === 'string' &&
    typeof record.originName === 'string' &&
    typeof record.destinationName === 'string' &&
    typeof record.departureAt === 'number' &&
    typeof record.firesAt === 'number' &&
    typeof record.walkSeconds === 'number' &&
    typeof record.notificationId === 'string' &&
    typeof record.armedAt === 'number'
  );
};

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Czas wyjść',
    description: 'Przypomnienie, kiedy wyjść na zapisany przejazd.',
    importance: Notifications.AndroidImportance.HIGH,
    enableVibrate: true,
    sound: 'default',
  });
}

async function cancel(alert = armed) {
  if (!alert?.notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(alert.notificationId);
  } catch {
    // It may already have fired or been removed by the operating system.
  }
}

async function schedule(
  trip: FavouriteTrip,
  departure: Departure,
  receivedAt: number,
  walkSeconds: number,
): Promise<LeaveAlert> {
  const seconds = departureSeconds(departure);
  const departureAt = receivedAt + seconds * 1_000;
  const firesAt = receivedAt + Math.max(0, leaveInSeconds(seconds, walkSeconds)) * 1_000;
  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: `Czas wyjść na ${trip.from.name}`,
      body: `Linia ${departure.line} do ${trip.to.name} odjeżdża o ${departure.departure}.`,
      sound: true,
      data: { favouriteTripId: trip.id },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: Math.max(1, Math.round((firesAt - Date.now()) / 1_000)),
      ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
    },
  });
  return {
    favouriteTripId: trip.id,
    favouriteTripTitle: trip.label || `${trip.from.name} → ${trip.to.name}`,
    departureTripId: departure.tripId,
    departureClock: departure.departure,
    serviceDay: departure.serviceDay,
    line: departure.line,
    originName: trip.from.name,
    destinationName: trip.to.name,
    departureAt,
    firesAt,
    walkSeconds,
    notificationId,
    armedAt: Date.now(),
  };
}

export async function hydrateLeaveAlert() {
  if (!leaveAlertsAvailable) return;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isStored(parsed) || parsed.departureAt <= Date.now() || parsed.armedAt + MAX_RESTORE_AGE_MS <= Date.now()) {
      if (raw) await AsyncStorage.removeItem(STORAGE_KEY);
      return;
    }
    armed = parsed;
    emit();
    await ensureChannel();
  } catch {
    // A failed restore never affects a notification already held by the OS.
  }
}

export const leaveAlertStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): LeaveAlert | null => armed,

  async arm(
    trip: FavouriteTrip,
    departure: Departure,
    receivedAt: number,
    walkSeconds: number,
  ): Promise<'armed' | 'denied' | 'passed'> {
    if (!leaveAlertsAvailable) return 'denied';
    const leaveIn = leaveInSeconds(departureSeconds(departure), walkSeconds);
    if (leaveIn < -30) return 'passed';
    await ensureChannel();
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return 'denied';
    const mine = ++generation;
    await cancel();
    const next = await schedule(trip, departure, receivedAt, walkSeconds);
    if (mine !== generation) {
      await cancel(next);
      return 'armed';
    }
    commit(next);
    return 'armed';
  },

  async disarm() {
    generation += 1;
    const current = armed;
    commit(null);
    await cancel(current);
  },

  /** Keep a pending reminder aligned with live departure predictions. */
  async follow(board: TripBoard, receivedAt: number) {
    const current = armed;
    const mine = generation;
    if (!current || board.trip.id !== current.favouriteTripId) return;
    const departure = board.departures.find(
      (item) =>
        item.tripId === current.departureTripId &&
        item.departure === current.departureClock &&
        item.serviceDay === current.serviceDay,
    );
    const live = departure
      ? {
          departureAt: receivedAt + departureSeconds(departure) * 1_000,
          firesAt:
            receivedAt +
            Math.max(0, leaveInSeconds(departureSeconds(departure), current.walkSeconds)) * 1_000,
        }
      : null;
    const next = followLeaveAlert(current, live, Date.now());
    if (next.action === 'drop') {
      await leaveAlertStore.disarm();
      return;
    }
    if (next.action === 'keep' || !departure) return;
    await cancel(current);
    // Disarmed or replaced while that was in flight: do not bring it back.
    if (mine !== generation || armed !== current) return;
    const rescheduled = await schedule(board.trip, departure, receivedAt, current.walkSeconds);
    if (mine !== generation || armed !== current) {
      await cancel(rescheduled);
      return;
    }
    commit(rescheduled);
  },
};

export function useLeaveAlert(): LeaveAlert | null {
  return useSyncExternalStore(
    leaveAlertStore.subscribe,
    leaveAlertStore.getSnapshot,
    leaveAlertStore.getSnapshot,
  );
}
