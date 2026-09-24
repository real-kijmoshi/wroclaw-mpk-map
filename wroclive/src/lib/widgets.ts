import type { Departure } from '@/lib/api';
import type { FavouriteStop } from '@/lib/favourite-stops';
import type { FavouriteTrip } from '@/lib/favourite-trips';

/**
 * Home-screen widget and Live Activities — not on this platform.
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

/** A rider on board; `stopId` and `stopName` are where they get off. */
export type TripActivityInput = ArrivalActivityInput & {
  stopsAway: number;
  totalStops: number;
  nextStop: string;
};

export type WidgetBoard = { stop: FavouriteStop; departures: Departure[] };
/** A saved trip's departures: only those that reach its destination, each with its arrival. */
export type TripBoard = { trip: FavouriteTrip; departures: Departure[]; supported: boolean };

/** Everything the widget can be set to show. */
export type WidgetInput = {
  favourites: FavouriteStop[];
  boards: WidgetBoard[];
  trips: FavouriteTrip[];
  tripBoards: TripBoard[];
};

export const widgetsAvailable = false;

export function syncDeparturesWidget(
  _input: WidgetInput,
  _position: { lat: number; lon: number } | null,
  _now?: number,
) {}

export function showArrivalActivity(_input: ArrivalActivityInput) {}

export function showTripActivity(_input: TripActivityInput) {}

export function endLiveActivity() {}
