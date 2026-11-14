import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { apiSend } from '@/lib/api';
import { preferencesStore } from '@/lib/preferences';
import { selectionStore } from '@/lib/selection';

/**
 * Disruption notifications pushed by the server, so they arrive with the app
 * closed (`server/src/incident-push.js`).
 *
 * The local notifications in `incident-alerts.ts` can only announce what the
 * app itself fetched, and with the app closed that is whenever iOS runs the
 * background task — rarely, and long after a quarter-hour closure is over.
 * So when the rider switches disruption notifications on, the app hands the
 * server its device token and the scope it chose; the server then pushes each
 * new incident over APNs. While the server has accepted that, the local
 * announcements stand down (`incidentPushActive()`), or a rider with the app
 * open would hear about the same closure twice.
 *
 * Inert where it cannot work: iOS only (Android has no push service set up),
 * and a server without an APNs key answers 503, which leaves the local
 * announcements in charge exactly as before. No native change is needed: the
 * push entitlement is already in every build for the Live Activity pushes,
 * and `expo-notifications` registers for the token through its autolinked
 * app-delegate subscriber.
 */

const STORAGE_KEY = 'wroclive.incident-push.v1';
/**
 * How long an accepted registration silences the local announcements. The app
 * registers again on every launch, so this only matters for a phone that has
 * not opened the app in a week — after which the local path takes over again
 * rather than trusting a registration the server may have dropped.
 */
const TRUST_MS = 7 * 24 * 60 * 60 * 1_000;
/** Selection taps come in bursts; one registration after they settle. */
const DEBOUNCE_MS = 2_000;

export const incidentPushAvailable = Platform.OS === 'ios';

type Stored = { token: string; acceptedAt: number | null };

let stored: Stored | null = null;
let hydrated: Promise<void> | null = null;
let queue = Promise.resolve();
const listeners = new Set<() => void>();

function hydrate() {
  hydrated ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Stored).token === 'string'
      ) {
        stored = parsed as Stored;
      }
    })
    .catch(() => {
      // Nothing remembered: the next sync registers from scratch.
    });
  return hydrated;
}

async function save(next: Stored | null) {
  stored = next;
  for (const listener of listeners) listener();
  try {
    if (next) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembering costs one repeated registration, never a crash.
  }
}

/** Settings' footer: whether disruptions arrive by push right now, so the copy can say so. */
export function useIncidentPushActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void hydrate().then(listener);
      return () => listeners.delete(listener);
    },
    () => incidentPushAvailable && stored?.acceptedAt != null && Date.now() - stored.acceptedAt < TRUST_MS,
  );
}

/** Whether the server is pushing disruptions to this phone, so the local path should stay quiet. */
export async function incidentPushActive(now = Date.now()): Promise<boolean> {
  if (!incidentPushAvailable) return false;
  await hydrate();
  return stored?.acceptedAt != null && now - stored.acceptedAt < TRUST_MS;
}

/** What the server is told: the mode, and the lines only when they matter. */
const currentScope = () => {
  const mode = preferencesStore.getSnapshot().incidentAlerts;
  const lines = mode === 'mine' ? [...selectionStore.getSnapshot()] : [];
  return { mode, lines, key: `${mode}|${[...lines].sort().join(',')}` };
};

/**
 * Bring the server's registration in line with Settings: register the token
 * and scope when disruption notifications are on, remove it when they are off.
 * Never throws; serialised, so a burst of changes cannot interleave.
 */
export function syncIncidentPush(): Promise<void> {
  if (!incidentPushAvailable) return Promise.resolve();
  const run = queue.then(async () => {
    try {
      await hydrate();
      const { mode, lines } = currentScope();
      if (mode === 'off') {
        if (stored) void apiSend('DELETE', `/incident-push/${stored.token}`);
        await save(null);
        return;
      }
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) {
        await save(stored ? { ...stored, acceptedAt: null } : null);
        return;
      }
      const token = String((await Notifications.getDevicePushTokenAsync()).data ?? '');
      if (!/^[0-9a-f]{32,256}$/i.test(token)) return;
      // An empty selection is the map showing every line; the server reads
      // "mine" with no lines the same way.
      if (stored && stored.token !== token) void apiSend('DELETE', `/incident-push/${stored.token}`);
      const accepted = await apiSend('POST', '/incident-push', { token, mode, lines });
      await save({ token, acceptedAt: accepted ? Date.now() : null });
    } catch {
      // No token (a simulator, push refused by the system): the local
      // announcements carry on, which is how this worked before.
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

let debounce: ReturnType<typeof setTimeout> | null = null;
const syncSoon = () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void syncIncidentPush();
  }, DEBOUNCE_MS);
};

/**
 * Register now, then again whenever the scope or the token changes. Call once
 * the stores are hydrated; returns the unsubscribe.
 */
export function watchIncidentPush(): () => void {
  if (!incidentPushAvailable) return () => {};
  void syncIncidentPush();
  let lastScope = currentScope().key;
  const onChange = () => {
    // Line taps matter only to "mine"; other preference changes not at all.
    const next = currentScope().key;
    if (next === lastScope) return;
    lastScope = next;
    syncSoon();
  };
  const unsubscribePreferences = preferencesStore.subscribe(onChange);
  const unsubscribeSelection = selectionStore.subscribe(onChange);
  const tokenSubscription = Notifications.addPushTokenListener(() => syncSoon());
  return () => {
    unsubscribePreferences();
    unsubscribeSelection();
    tokenSubscription.remove();
    if (debounce) clearTimeout(debounce);
  };
}
