import type { VehicleDetail } from '@/lib/api';
import type { ArrivalLeadSeconds, TripLeadStops } from '@/lib/preferences';

/**
 * When an arrival or trip alert should fire. Kept free of runtime imports so
 * `server/test/alert-timing.test.js` can run it the way it runs
 * `trip-progress.ts`.
 */
export type AlertTiming = {
  arrivalLeadSeconds: ArrivalLeadSeconds;
  tripLeadStops: TripLeadStops;
};

/**
 * When the alert should fire, given what the server just said — or `passed`
 * once the stop is behind the vehicle.
 *
 * A trip alert fires when the destination reaches the configured number of
 * stops away. The ETA of the last stop before that threshold gives the phone a
 * stable local trigger even after the app is suspended.
 */
export function alertFireTime(
  detail: Pick<VehicleDetail, 'trip'>,
  alert: { kind: 'arrival' | 'trip'; stopId: string },
  now: number,
  timing: AlertTiming,
): { at: number } | { passed: true } {
  const stops = detail.trip?.nextStops ?? [];
  const index = stops.findIndex((entry) => entry.id === alert.stopId);
  const stop = stops[index];
  if (!stop || stop.etaSeconds === null || !Number.isFinite(stop.etaSeconds)) return { passed: true };
  if (alert.kind === 'trip') {
    if (index < timing.tripLeadStops) return { at: now };
    const threshold = stops[index - timing.tripLeadStops]?.etaSeconds;
    const at = threshold !== null && threshold !== undefined && Number.isFinite(threshold) ? threshold : 0;
    return { at: now + at * 1_000 };
  }
  return { at: now + Math.max(0, stop.etaSeconds - timing.arrivalLeadSeconds) * 1_000 };
}
