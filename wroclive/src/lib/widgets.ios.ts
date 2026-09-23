import { requireOptionalNativeModule } from 'expo';

import { apiSend, type Departure } from '@/lib/api';
import { Colors } from '@/constants/theme';
import { stopAppUrl, vehicleAppUrl } from '@/lib/links';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { colorFor } from '@/lib/lines';
import { walkSeconds } from '@/lib/walking';
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
 * While the app is suspended the server takes over the Live Activity through
 * APNs, when it has a key for it (`registerPush` below).
 *
 * `expo-widgets` is not in Expo Go and resolves its native module at module
 * scope, so the layouts are required only once the module is known to exist.
 */

export const widgetsAvailable = requireOptionalNativeModule('ExpoWidgets') !== null;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const layouts: typeof import('@/widgets/layouts') | null = widgetsAvailable ? require('@/widgets/layouts') : null;

/** How far ahead the widget's timeline reaches, one entry a minute. */
const TIMELINE_MINUTES = 30;
/** Past its arrival by this much, an un-refreshed activity is marked stale. */
const ACTIVITY_STALE_AFTER_MS = 60_000;
/** The configuration menu offers three slots (`app.json`). */
export const WIDGET_STOPS = 3;

const amber = { amberLight: Colors.light.amber, amberDark: Colors.dark.amber };

export type WidgetBoard = { stop: FavouriteStop; departures: Departure[] };

/**
 * Hand the widget a fresh timeline for the first starred stops.
 *
 * `position` is where the rider last was, for the walking estimate; it never
 * leaves the phone. An empty list puts the widget back to "add a favourite".
 */
export function syncDeparturesWidget(
  boards: WidgetBoard[],
  position: { lat: number; lon: number } | null,
  now = Date.now(),
) {
  if (!layouts) return;
  try {
    const props = {
      ...amber,
      stops: boards.slice(0, WIDGET_STOPS).map(({ stop, departures }) => ({
        name: stop.name,
        url: stopAppUrl(stop),
        walk: walkSeconds(position, stop),
        rows: departures.slice(0, 12).map((departure) => ({
          line: departure.line,
          color: colorFor(departure.type),
          headsign: departure.headsign ?? '',
          at: now + (departure.predictedInSeconds ?? departure.inSeconds) * 1_000,
        })),
      })),
    };
    if (props.stops.length === 0) {
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

type ActivityHandle = ReturnType<NonNullable<typeof layouts>['arrivalActivity']['start']>;

let activity: {
  vehicleId: string;
  stopId: string;
  handle: ActivityHandle;
  /** The push token registered with the server, so ending can unregister it. */
  token: string | null;
  subscription: { remove: () => void } | null;
} | null = null;

/**
 * Hand the activity to the server so it keeps the countdown right while the
 * app is suspended (`server/src/live-activities.js`). Best-effort: without an
 * APNs key the server answers 503 and the app goes on updating the activity
 * itself while it runs, which is how it works in any case.
 */
function registerPush(current: NonNullable<typeof activity>, token: string, input: ArrivalActivityInput) {
  if (current.token === token) return;
  if (current.token) void apiSend('DELETE', `/live-activities/${current.token}`);
  current.token = token;
  void apiSend('POST', '/live-activities', {
    token,
    vehicleId: input.vehicleId,
    stopId: input.stopId,
    view: {
      line: input.line,
      color: input.color,
      towards: input.towards,
      stopName: input.stopName,
      ...amber,
    },
  });
}

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
    if (activity && activity.vehicleId === input.vehicleId && activity.stopId === input.stopId) {
      void activity.handle.update(props, staleDate).catch(() => {});
      return;
    }
    endArrivalActivity();
    const handle = layouts.arrivalActivity.start(props, vehicleAppUrl(input.vehicleId), staleDate);
    const current: NonNullable<typeof activity> = {
      vehicleId: input.vehicleId,
      stopId: input.stopId,
      handle,
      token: null,
      subscription: null,
    };
    activity = current;
    // iOS may issue the token later, and may rotate it; register each one.
    current.subscription = handle.addPushTokenListener(({ pushToken }) => registerPush(current, pushToken, input));
    void handle
      .getPushToken()
      .then((token) => {
        if (token && activity === current) registerPush(current, token, input);
      })
      .catch(() => {});
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
  current.subscription?.remove();
  if (current.token) void apiSend('DELETE', `/live-activities/${current.token}`);
  void current.handle.end('default').catch(() => {});
}
