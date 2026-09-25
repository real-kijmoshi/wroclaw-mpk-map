import type { VehicleTripDetail } from '@/lib/api';

export type TripProgress = {
  /** Standing at the destination: this is where the rider gets off. */
  arrived: boolean;
  /** Stops still to come, the destination included; 0 once there. */
  stopsAway: number;
  /** Seconds to the destination, or null when the server could not say. */
  etaSeconds: number | null;
  /** The next stop the vehicle will reach — what a rider on board reads off the display. */
  nextStop: string;
  /** Seconds until that next stop — when the count above stops being true. */
  nextStopEtaSeconds: number | null;
};

/**
 * Where a rider on board stands relative to the stop they get off at.
 *
 * `nextStops` starts with the stop the vehicle is standing at, when it is
 * standing at one, and that stop is being left rather than still to come — so
 * it is not counted. `null` means the destination is no longer ahead: passed,
 * or the vehicle has turned onto another route.
 *
 * The server has the same function (`tripProgress` in
 * `server/src/live-activities.js`) for the pushes it sends while the app is
 * suspended; both read one payload and must count the same stops, or the lock
 * screen says 3 while the open app says 2.
 */
export function tripProgress(
  trip: Pick<VehicleTripDetail, 'atStop' | 'nextStops'> | null | undefined,
  destinationId: string,
): TripProgress | null {
  const stops = trip?.nextStops ?? [];
  const index = stops.findIndex((entry) => entry.id === destinationId);
  if (index < 0) return null;
  const standingAt = trip?.atStop?.id ?? null;
  const arrived = standingAt === destinationId;
  const leavingFirst = !arrived && standingAt !== null && stops[0]?.id === standingAt;
  const upcoming = leavingFirst ? stops[1] : stops[0];
  const eta = stops[index].etaSeconds;
  const nextEta = (upcoming ?? stops[index]).etaSeconds;
  return {
    arrived,
    stopsAway: arrived ? 0 : index + 1 - (leavingFirst ? 1 : 0),
    etaSeconds: eta !== null && Number.isFinite(eta) ? eta : null,
    nextStop: (upcoming ?? stops[index]).name ?? '',
    nextStopEtaSeconds: nextEta !== null && nextEta !== undefined && Number.isFinite(nextEta) ? nextEta : null,
  };
}

/** Past its arrival by this much, an un-refreshed activity is marked stale. */
const ACTIVITY_STALE_AFTER_MS = 60_000;
/** A stop is passed a little after it is reached: the doors are open for a while. */
const STOP_DWELL_MS = 20_000;

/**
 * When a Live Activity stops being true, as epoch ms — its stale date.
 *
 * An arrival countdown is a native timer and stays right until the vehicle is
 * due. A trip's headline is a *count of stops*, and a count is only true until
 * the next stop is passed; nothing on the phone can change it after that while
 * the app is suspended. The server's pushes can, so with them (`pushed`) a trip
 * lasts as long as an arrival. Without them it goes stale as the next stop is
 * left and the layout trades the count for the clock. Before this the lock
 * screen said "4 stops" for the whole ride, and still said it after the rider
 * had got off.
 */
export function activityStaleAt({
  arrivesAt,
  nextStopAt,
  pushed,
  now,
}: {
  arrivesAt: number;
  nextStopAt: number | null;
  pushed: boolean;
  now: number;
}): number {
  const arrival = arrivesAt + ACTIVITY_STALE_AFTER_MS;
  if (pushed || nextStopAt === null) return arrival;
  return Math.min(arrival, Math.max(nextStopAt, now) + STOP_DWELL_MS);
}
