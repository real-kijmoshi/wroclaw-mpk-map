import type { Departure, Stop } from '@/lib/api';

/**
 * Home-screen widget and Live Activity — not on this platform.
 *
 * `widgets.ios.ts` is the real module. Android widgets exist in `expo-widgets`
 * only behind an experimental flag, and the web has neither, so everywhere
 * else these are no-ops and the callers need no platform checks.
 */

export type ArrivalActivityInput = {
  vehicleId: string;
  line: string;
  color: string;
  towards: string | null;
  stopName: string;
  arrivesAt: number;
  atStop: boolean;
};

export const widgetsAvailable = false;

export function syncDeparturesWidget(_stop: Stop | null, _departures: Departure[] | null, _now?: number) {}

export function showArrivalActivity(_input: ArrivalActivityInput) {}

export function endArrivalActivity() {}
