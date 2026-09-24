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
  return {
    arrived,
    stopsAway: arrived ? 0 : index + 1 - (leavingFirst ? 1 : 0),
    etaSeconds: eta !== null && Number.isFinite(eta) ? eta : null,
    nextStop: (upcoming ?? stops[index]).name ?? '',
  };
}
