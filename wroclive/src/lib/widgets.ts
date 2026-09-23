import type { Departure } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourite-stops';

/**
 * Home-screen widget and Live Activity — not on this platform.
 *
 * `widgets.ios.ts` is the real module. Android widgets exist in `expo-widgets`
 * only behind an experimental flag, and the web has neither, so everywhere
 * else these are no-ops and the callers need no platform checks.
 */

export type ArrivalActivityInput = {
  vehicleId: string;
  stopId: string;
  line: string;
  color: string;
  towards: string | null;
  stopName: string;
  arrivesAt: number;
  atStop: boolean;
};

export type WidgetBoard = { stop: FavouriteStop; departures: Departure[] };

export const widgetsAvailable = false;
export const WIDGET_STOPS = 3;

export function syncDeparturesWidget(
  _boards: WidgetBoard[],
  _position: { lat: number; lon: number } | null,
  _now?: number,
) {}

export function showArrivalActivity(_input: ArrivalActivityInput) {}

export function endArrivalActivity() {}
