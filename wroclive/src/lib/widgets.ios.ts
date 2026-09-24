import { requireOptionalNativeModule } from 'expo';

import { apiSend } from '@/lib/api';
import { Colors } from '@/constants/theme';
import { arrivalSeconds, departureSeconds, directionsLabel } from '@/lib/departures';
import { stopAppUrl, vehicleAppUrl } from '@/lib/links';
import type { FavouriteStop } from '@/lib/favourite-stops';
import { colorFor } from '@/lib/lines';
import { walkSeconds } from '@/lib/walking';
import type { FavouriteTrip } from '@/lib/favourite-trips';
import type { ArrivalActivityInput, TripActivityInput, TripBoard, WidgetBoard, WidgetInput } from '@/lib/widgets';
import type { DeparturesWidgetProps, DeparturesWidgetStop } from '@/widgets/layouts';

export type { ArrivalActivityInput, TripActivityInput, TripBoard, WidgetBoard, WidgetInput } from '@/lib/widgets';

/**
 * The iOS home-screen widget and the Live Activities.
 *
 * Neither can fetch anything: WidgetKit renders what the app last handed it.
 * So the widget gets a *timeline* — every starred stop's next departures,
 * repeated once a minute for the next half hour, each entry counting from its
 * own date — which keeps it honest for a while after the app is closed. Its
 * last entry is never redrawn, so it shows clock times instead of countdowns
 * that would freeze. The Live Activities get a native countdown that ticks on
 * the lock screen with the app suspended, refreshed on every poll while the
 * app runs, and a stale date so the system greys it out when that stops.
 *
 * Every starred stop goes into the timeline, not just the first few: which one
 * a widget shows is chosen on the widget itself, by name, from the same list
 * (`plugins/with-widget-stop-picker.js` reads `favourites` back out of it).
 *
 * While the app is suspended the server takes over a Live Activity through
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
/** Rows kept per stop per entry: the large widget draws eight. */
const ROWS_PER_STOP = 8;
/** Past its arrival by this much, an un-refreshed activity is marked stale. */
const ACTIVITY_STALE_AFTER_MS = 60_000;

const amber = { amberLight: Colors.light.amber, amberDark: Colors.dark.amber };

const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function widgetRows(departures: WidgetBoard['departures'], now: number) {
  return departures.map((departure) => {
    const at = now + departureSeconds(departure) * 1_000;
    const arrives = arrivalSeconds(departure);
    const arriveAt = arrives === null ? null : now + arrives * 1_000;
    return {
      line: departure.line,
      color: colorFor(departure.type),
      tram: departure.type.startsWith('tram'),
      headsign: departure.headsign ?? '',
      at,
      clock: clock(at),
      live: Boolean(departure.realtime),
      arriveAt,
      arriveClock: arriveAt === null ? null : clock(arriveAt),
    };
  });
}

function widgetStop(
  stop: FavouriteStop,
  board: WidgetBoard | undefined,
  position: { lat: number; lon: number } | null,
  now: number,
): DeparturesWidgetStop {
  const departures = board?.departures ?? [];
  return {
    kind: 'stop',
    id: stop.id,
    name: stop.name,
    label: stop.label ?? null,
    detail: directionsLabel(departures),
    url: stopAppUrl(stop),
    walk: walkSeconds(position, stop),
    rows: widgetRows(departures, now),
  };
}

/** A saved trip, drawn as the board of its origin with only the departures that get there. */
function widgetTrip(
  trip: FavouriteTrip,
  board: TripBoard | undefined,
  position: { lat: number; lon: number } | null,
  now: number,
): DeparturesWidgetStop {
  const origin = { id: trip.from.ids[0], ids: trip.from.ids, name: trip.from.name, lat: trip.from.lat, lon: trip.from.lon };
  return {
    kind: 'trip',
    id: `trip:${trip.id}`,
    name: `${trip.from.name} → ${trip.to.name}`,
    label: trip.label || null,
    detail: `${trip.from.name} → ${trip.to.name}`,
    destination: trip.to.name,
    url: stopAppUrl(origin),
    walk: walkSeconds(position, trip.from),
    rows: board?.supported === false ? [] : widgetRows(board?.departures ?? [], now),
  };
}

/**
 * Hand the widget a fresh timeline for the starred stops and saved trips.
 *
 * `position` is where the rider last was, for the walking estimate; it never
 * leaves the phone. Nothing saved puts the widget back to "star a stop".
 */
export function syncDeparturesWidget(
  { favourites, boards, trips, tripBoards }: WidgetInput,
  position: { lat: number; lon: number } | null,
  now = Date.now(),
) {
  if (!layouts) return;
  try {
    const stops = [
      ...favourites.map((stop) =>
        widgetStop(
          stop,
          boards.find((board) => board.stop.id === stop.id),
          position,
          now,
        ),
      ),
      ...trips.map((trip) =>
        widgetTrip(
          trip,
          tripBoards.find((board) => board.trip.id === trip.id),
          position,
          now,
        ),
      ),
    ];
    const base: DeparturesWidgetProps = {
      ...amber,
      stops,
      favourites: stops.map((stop) => ({
        id: stop.id,
        name: stop.kind === 'trip' ? `Przejazd: ${stop.label || stop.name}` : stop.label || stop.name,
        // The picker's second line: the real name under a label, otherwise
        // where it goes — which is what tells two platforms of one stop apart.
        detail:
          stop.kind === 'trip'
            ? stop.label
              ? stop.detail
              : ''
            : stop.label
              ? [stop.name, stop.detail].filter(Boolean).join(' · ')
              : stop.detail,
      })),
      updatedAt: now,
      final: false,
    };
    if (stops.length === 0) {
      layouts.departuresWidget.updateSnapshot(base);
      return;
    }
    const start = Math.floor(now / 60_000) * 60_000;
    layouts.departuresWidget.updateTimeline(
      Array.from({ length: TIMELINE_MINUTES + 1 }, (_, minute) => {
        const date = start + minute * 60_000;
        return {
          date: new Date(date),
          props: {
            ...base,
            final: minute === TIMELINE_MINUTES,
            // Each entry carries only what has not left by its own minute, so
            // a small widget's three rows are three departures still to come.
            stops: stops.map((stop) => ({
              ...stop,
              rows: stop.rows.filter((row) => row.at >= date - 30_000).slice(0, ROWS_PER_STOP),
            })),
          },
        };
      }),
    );
  } catch {
    // A widget that fails to refresh keeps its last timeline; never the app's problem.
  }
}

type Kind = 'arrival' | 'trip';
type ArrivalHandle = ReturnType<NonNullable<typeof layouts>['arrivalActivity']['start']>;
type TripHandle = ReturnType<NonNullable<typeof layouts>['tripActivity']['start']>;

let activity: {
  kind: Kind;
  vehicleId: string;
  stopId: string;
  handle: ArrivalHandle | TripHandle;
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
function registerPush(
  current: NonNullable<typeof activity>,
  token: string,
  input: ArrivalActivityInput | TripActivityInput,
) {
  if (current.token === token) return;
  if (current.token) void apiSend('DELETE', `/live-activities/${current.token}`);
  current.token = token;
  void apiSend('POST', '/live-activities', {
    token,
    kind: current.kind,
    vehicleId: input.vehicleId,
    stopId: input.stopId,
    view: {
      line: input.line,
      color: input.color,
      towards: input.towards,
      stopName: input.stopName,
      ...('totalStops' in input ? { totalStops: input.totalStops } : null),
      ...amber,
    },
  });
}

function show(kind: Kind, input: ArrivalActivityInput | TripActivityInput) {
  if (!layouts) return;
  const now = Date.now();
  const base = {
    ...amber,
    line: input.line,
    color: input.color,
    towards: input.towards,
    stopName: input.stopName,
    arrivesAt: Math.max(input.arrivesAt, now),
    since: now,
    atStop: input.atStop,
  };
  const props =
    'totalStops' in input
      ? { ...base, stopsAway: input.stopsAway, totalStops: input.totalStops, nextStop: input.nextStop }
      : base;
  const staleDate = new Date(props.arrivesAt + ACTIVITY_STALE_AFTER_MS);
  try {
    if (activity && activity.kind === kind && activity.vehicleId === input.vehicleId && activity.stopId === input.stopId) {
      void (activity.handle as { update: (next: typeof props, stale: Date) => Promise<void> })
        .update(props, staleDate)
        .catch(() => {});
      return;
    }
    endLiveActivity();
    const url = vehicleAppUrl(input.vehicleId);
    const handle =
      kind === 'trip' && 'totalStops' in props
        ? layouts.tripActivity.start(props, url, staleDate)
        : layouts.arrivalActivity.start(base, url, staleDate);
    const current: NonNullable<typeof activity> = {
      kind,
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

export function showArrivalActivity(input: ArrivalActivityInput) {
  show('arrival', input);
}

export function showTripActivity(input: TripActivityInput) {
  show('trip', input);
}

export function endLiveActivity() {
  const current = activity;
  activity = null;
  if (!current) return;
  current.subscription?.remove();
  if (current.token) void apiSend('DELETE', `/live-activities/${current.token}`);
  void current.handle.end('default').catch(() => {});
}
