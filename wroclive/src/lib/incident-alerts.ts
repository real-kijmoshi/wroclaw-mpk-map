import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Incident } from '@/lib/api';
import { plural } from '@/lib/format';
import {
  planIncidentAlerts,
  type IncidentAlertMode,
} from '@/lib/incident-alert-plan';
import { incidentPushActive } from '@/lib/incident-push';
import { preferencesStore } from '@/lib/preferences';
import { selectionStore } from '@/lib/selection';

/**
 * Opt-in notifications about new disruptions.
 *
 * Local notifications, like the arrival alert: the app announces what it has
 * just fetched — on every incidents poll while it runs, and from the iOS
 * background refresh while it does not. That second path runs when iOS
 * decides, so this is "you will hear about it", never "you will hear about it
 * the minute it happens". The timely path is the server's push
 * (`incident-push.ts`); while the server has accepted this phone's token,
 * this module only keeps the seen-set current and announces nothing, so the
 * same closure never arrives twice. Without a push server it is the only path.
 *
 * What gets announced is decided by `planIncidentAlerts()`; this module only
 * keeps its state and talks to the operating system.
 */

const STORAGE_KEY = 'wroclive.incident-alerts.v1';
const CHANNEL = 'incident-alerts';

export const incidentAlertsAvailable = Platform.OS !== 'web';

type Stored = { enabledAt: number | null; seen: Record<string, number> };

let state: Stored = { enabledAt: null, seen: {} };
let hydrated: Promise<void> | null = null;
/** Checks run one at a time: two at once would both announce the same incident. */
let queue = Promise.resolve();

const isStored = (value: unknown): value is Stored =>
  Boolean(value) &&
  typeof value === 'object' &&
  ((value as Stored).enabledAt === null || typeof (value as Stored).enabledAt === 'number') &&
  typeof (value as Stored).seen === 'object' &&
  (value as Stored).seen !== null;

function hydrate() {
  hydrated ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (isStored(parsed)) state = parsed;
    })
    .catch(() => {
      // Unreadable state costs only the memory of what was announced; the
      // opt-in date falls back to now when it is next switched on.
    });
  return hydrated;
}

async function save(next: Stored) {
  state = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not remembering what was announced risks one repeat, never a crash.
  }
}

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Utrudnienia',
    description: 'Nowe utrudnienia w komunikacji.',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * Switch the notifications on or off. Permission is asked here — when the
 * rider chooses this — and never at launch. Answers whether the mode stuck.
 */
export function setIncidentAlertMode(mode: IncidentAlertMode): Promise<'ok' | 'denied'> {
  return enqueue(async () => {
    await hydrate();
    if (mode === 'off' || !incidentAlertsAvailable) {
      preferencesStore.set('incidentAlerts', 'off');
      await save({ enabledAt: null, seen: state.seen });
      return 'ok';
    }
    await ensureChannel();
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) {
      preferencesStore.set('incidentAlerts', 'off');
      return 'denied';
    }
    // Switching between "mine" and "all" keeps the opt-in date: it is when
    // the rider started listening, not when they last changed the scope.
    await save({ enabledAt: state.enabledAt ?? Date.now(), seen: state.seen });
    preferencesStore.set('incidentAlerts', mode);
    return 'ok';
  });
}

/** Announce what is new in a fresh incidents payload. Never throws. */
export function checkIncidents(incidents: readonly Incident[]): Promise<void> {
  if (!incidentAlertsAvailable) return Promise.resolve();
  return enqueue(async () => {
    try {
      await hydrate();
      const mode = preferencesStore.getSnapshot().incidentAlerts;
      // Switched on, but the opt-in date was lost with this file: listen from
      // now rather than stay silent under a setting that says "on".
      if (mode !== 'off' && state.enabledAt === null) {
        await save({ ...state, enabledAt: Date.now() });
      }
      const plan = planIncidentAlerts(
        incidents,
        { mode, enabledAt: state.enabledAt, seen: state.seen },
        selectionStore.getSnapshot(),
        Date.now(),
      );
      // The server is pushing these: remember them, announce nothing.
      if ((plan.separate.length || plan.summarised) && (await incidentPushActive())) {
        await save({ ...state, seen: plan.seen });
        return;
      }
      if (plan.separate.length || plan.summarised) {
        // Permission can be withdrawn in Settings at any time; a refusal now
        // means stay quiet, not ask again from a background wake.
        const permission = await Notifications.getPermissionsAsync();
        if (!permission.granted) {
          await save({ ...state, seen: plan.seen });
          return;
        }
        await ensureChannel();
        for (const incident of plan.separate) await announce(incident);
        if (plan.summarised) await announceSummary(plan.summarised, mode);
      }
      // Saved after announcing: a crash in between repeats one notice
      // rather than losing it.
      await save({ ...state, seen: plan.seen });
    } catch {
      // A failed announcement is a missed notice; the incidents screen still
      // has it.
    }
  });
}

const channel = () => (Platform.OS === 'android' ? { channelId: CHANNEL } : null);

async function announce(incident: Incident) {
  const lines = incident.affected.slice(0, 4).join(', ');
  const title =
    incident.shortNotificationTitle?.trim() ||
    (lines ? `Utrudnienia: ${incident.affected.length > 1 ? 'linie' : 'linia'} ${lines}` : 'Utrudnienia w komunikacji');
  const body = incident.shortNotificationBody?.trim() || incident.title;
  await Notifications.scheduleNotificationAsync({
    identifier: `incident:${incident.id}`,
    content: { title, body, sound: true, data: { kind: 'incident', incidentId: incident.id } },
    trigger: channel(),
  });
}

async function announceSummary(count: number, mode: IncidentAlertMode) {
  const noun = plural(count, ['nowe utrudnienie', 'nowe utrudnienia', 'nowych utrudnień']);
  await Notifications.scheduleNotificationAsync({
    identifier: 'incident:summary',
    content: {
      title: `${count} ${noun}`,
      body: mode === 'mine' ? 'Na wybranych liniach. Szczegóły w aplikacji.' : 'Szczegóły w aplikacji.',
      sound: true,
      data: { kind: 'incident' },
    },
    trigger: channel(),
  });
}
