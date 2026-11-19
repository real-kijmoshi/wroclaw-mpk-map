import {
  favouriteTripsStore,
  type FavouriteTrip,
  type TripPlace,
} from '@/lib/favourite-trips';
import { withAllPlatforms } from '@/lib/place-platforms';
import { searchStops } from '@/lib/stops-api';

/** Widen a place to every platform of it (see `place-platforms.ts`). Never throws. */
export async function completePlace(
  place: TripPlace,
  options: { signal?: AbortSignal } = {},
): Promise<TripPlace> {
  try {
    return withAllPlatforms(place, await searchStops(place.name, options));
  } catch {
    return place;
  }
}

/** Trips already checked this session: one search per end, not one per poll. */
const checked = new Set<string>();

/**
 * Saved trips with every platform of both ends, repairing the stored ones —
 * trips saved from a starred stop before the picker widened them. Runs ahead
 * of each boards fetch, so the widget's background refresh fixes them too.
 */
export async function completeTrips(
  trips: FavouriteTrip[],
  signal?: AbortSignal,
): Promise<FavouriteTrip[]> {
  return Promise.all(
    trips.map(async (trip) => {
      if (checked.has(trip.id)) return trip;
      const [from, to] = await Promise.all([
        completePlace(trip.from, { signal }),
        completePlace(trip.to, { signal }),
      ]);
      if (signal?.aborted) return trip;
      checked.add(trip.id);
      if (from === trip.from && to === trip.to) return trip;
      favouriteTripsStore.setPlaces(trip.id, from, to);
      return { ...trip, from, to };
    }),
  );
}
