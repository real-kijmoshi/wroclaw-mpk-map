import * as Updates from 'expo-updates';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Over-the-air updates: the one place that talks to `expo-updates`.
 *
 * An update carries JS and assets — never native code. `runtimeVersion` in
 * `app.json` uses the fingerprint policy, so changing a native dependency
 * changes the fingerprint and binaries already on phones stop matching the new
 * bundles entirely. That is the interlock, not a fault: it is what makes it
 * impossible to ship JS calling a native API the installed binary lacks, which
 * would crash on launch with no way to push a fix afterwards.
 *
 * Nothing here may run in Expo Go or a dev client — `expo-updates` is inert
 * there and every call throws. `updatesEnabled` is the single guard.
 */

/**
 * Outcome of a check the user asked for, phrased for the settings screen.
 *
 * Named `Outcome`, not `Result`, because `expo-updates` exports its own
 * `UpdateCheckResult` type and two of those in one file read as one.
 */
export type UpdateCheckOutcome =
  | 'unavailable'
  | 'current'
  | 'downloaded'
  | 'failed';

/**
 * A reload tears the map down — camera, followed vehicle, open sheet, the lot.
 * Never worth it mid-glance, so a downloaded update waits for a gap this long
 * before it is allowed to interrupt. Below it, the update still boots on the
 * next cold start, which for this app is usually minutes away anyway.
 */
const RELOAD_AFTER_BACKGROUND_MS = 5 * 60_000;

export const updatesEnabled = Updates.isEnabled && !__DEV__;

/**
 * Set when a bundle has been fetched and is waiting for a restart.
 *
 * Tracked here rather than read from the library: SDK 57 exposes
 * `isUpdatePending` only through the `useUpdates()` hook, and this module is
 * deliberately callable from outside React. Session-scoped is enough — a
 * pending bundle is applied by the next cold start, so the flag cannot
 * meaningfully outlive the process.
 */
let fetchedUpdatePending = false;

export function updateIsPending(): boolean {
  return updatesEnabled && fetchedUpdatePending;
}

/**
 * Ask the update server, and download anything newer.
 *
 * Failures are silent by design: no network at a tram stop is the normal case
 * here, not an error worth a message. The bundle in hand keeps running.
 */
export async function checkForUpdate(): Promise<UpdateCheckOutcome> {
  if (!updatesEnabled) return 'unavailable';

  try {
    const { isAvailable } = await Updates.checkForUpdateAsync();
    if (!isAvailable) return 'current';

    // A roll back to the embedded bundle reports `isNew: false` — it is the
    // lever for undoing a bad publish, and it needs a restart just like a new
    // bundle does. Treating it as "nothing to do" would strand people on the
    // very build being rolled back.
    const fetched = await Updates.fetchUpdateAsync();
    const pending = fetched.isNew || fetched.isRollBackToEmbedded;

    fetchedUpdatePending = fetchedUpdatePending || pending;
    return pending ? 'downloaded' : 'current';
  } catch {
    return 'failed';
  }
}

/**
 * Boot-time check. Deliberately not awaited by the caller: the splash screen
 * hides on hydration, and an update must never be between the user and the map
 * (`fallbackToCacheTimeout` is 0 in `app.json` for the same reason).
 */
export function syncUpdates(): void {
  if (!updatesEnabled) return;
  void checkForUpdate();
}

/**
 * Apply a pending update when the app comes back from a long enough absence,
 * and look for new ones on every return.
 *
 * Returns its own teardown so the root layout can hand it straight to
 * `useEffect`.
 */
export function watchForUpdatesOnResume(): () => void {
  if (!updatesEnabled) return () => {};

  let leftAt: number | null = null;

  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state !== 'active') {
      // 'inactive' precedes 'background' on iOS; keep the first timestamp so a
      // pull-down of the notification shade does not reset the clock.
      leftAt = leftAt ?? Date.now();
      return;
    }

    const awayMs = leftAt === null ? 0 : Date.now() - leftAt;
    leftAt = null;
    void resume(awayMs);
  });

  return () => subscription.remove();
}

async function resume(awayMs: number): Promise<void> {
  if (awayMs >= RELOAD_AFTER_BACKGROUND_MS && updateIsPending()) {
    try {
      await Updates.reloadAsync();
      return;
    } catch {
      // Fall through: the pending bundle launches on the next cold start.
    }
  }

  void checkForUpdate();
}

/**
 * What the running bundle actually is, for the settings screen.
 *
 * The store version alone cannot answer "which build is this person on" once
 * updates ship independently of it, so a bug report needs the channel and the
 * update id too.
 */
export function describeRunningUpdate(): string {
  if (!updatesEnabled) return 'Wersja ze sklepu';

  const id = Updates.updateId;
  if (!id) return 'Wersja wbudowana';

  const channel = Updates.channel ?? 'bez kanału';
  return `${channel} · ${id.slice(0, 8)}`;
}
