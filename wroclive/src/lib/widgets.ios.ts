import { requireOptionalNativeModule } from 'expo';

import type { Departure, Stop } from '@/lib/api';
import { Colors } from '@/constants/theme';
import { stopAppUrl, vehicleAppUrl } from '@/lib/links';
import { colorFor } from '@/lib/lines';
import type { ArrivalActivityInput } from '@/lib/widgets';

export type { ArrivalActivityInput } from '@/lib/widgets';

/**
 * The iOS home-screen widget and the arrival Live Activity.
 *
 * Neither can fetch anything: WidgetKit renders what the app last handed it.
 * So the widget gets a *timeline* — the favourite stop's next departures,
 * repeated once a minute for the next half hour, each entry counting from its
 * own date — which keeps it honest for a while after the app is closed and
 * then says to open the app rather than show departures that have left. The
 * Live Activity gets a native countdown that ticks on the lock screen with
 * the app suspended, refreshed on every poll while the app runs, and a stale
 * date so the system greys it out when that stops.
 *
 * `expo-widgets` is not in Expo Go and resolves its native module at module
 * scope, so the layouts are required only once the module is known to exist —
 * the same guard the `expo-maps` surface uses.
 */

export const widgetsAvailable = requireOptionalNativeModule('ExpoWidgets') !== null;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const layouts: typeof import('@/widgets/layouts') | null = widgetsAvailable ? require('@/widgets/layouts') : null;

/** How far ahead the widget's timeline reaches, one entry a minute. */
const TIMELINE_MINUTES = 30;
/** Past its arrival by this much, an un-refreshed activity is marked stale. */
const ACTIVITY_STALE_AFTER_MS = 60_000;

const amber = { amberLight: Colors.light.amber, amberDark: Colors.dark.amber };

export function syncDeparturesWidget(stop: Stop | null, departures: Departure[] | null, now = Date.now()) {
  if (!layouts) return;
  try {
    const props = {
      ...amber,
      stopName: stop?.name ?? null,
      url: stop ? stopAppUrl(stop) : 'wroclive://',
      rows: (departures ?? []).slice(0, 12).map((departure) => ({
        line: departure.line,
        color: colorFor(departure.type),
        headsign: departure.headsign ?? '',
        at: now + (departure.predictedInSeconds ?? departure.inSeconds) * 1_000,
        realtime: Boolean(departure.realtime),
      })),
    };
    if (!stop) {
      layouts.departuresWidget.updateSnapshot(props);
      return;
    }
    const start = Math.floor(now / 60_000) * 60_000;
    layouts.departuresWidget.updateTimeline(
      Array.from({ length: TIMELINE_MINUTES + 1 }, (_, minute) => ({
        date: new Date(start + minute * 60_000),
        props,
      })),
    );
  } catch {
    // A widget that fails to refresh keeps its last timeline; never the app's problem.
  }
}

let activity: { vehicleId: string; handle: ReturnType<NonNullable<typeof layouts>['arrivalActivity']['start']> } | null =
  null;

export function showArrivalActivity(input: ArrivalActivityInput) {
  if (!layouts) return;
  const now = Date.now();
  const props = {
    ...amber,
    line: input.line,
    color: input.color,
    towards: input.towards,
    stopName: input.stopName,
    arrivesAt: Math.max(input.arrivesAt, now),
    since: now,
    atStop: input.atStop,
  };
  const staleDate = new Date(props.arrivesAt + ACTIVITY_STALE_AFTER_MS);
  try {
    if (activity && activity.vehicleId === input.vehicleId) {
      void activity.handle.update(props, staleDate).catch(() => {});
      return;
    }
    endArrivalActivity();
    activity = {
      vehicleId: input.vehicleId,
      handle: layouts.arrivalActivity.start(props, vehicleAppUrl(input.vehicleId), staleDate),
    };
  } catch {
    // Live Activities switched off in Settings, or the system refused: the
    // notification still arrives, which is what the rider asked for.
    activity = null;
  }
}

export function endArrivalActivity() {
  const current = activity;
  activity = null;
  if (!current) return;
  void current.handle.end('default').catch(() => {});
}
