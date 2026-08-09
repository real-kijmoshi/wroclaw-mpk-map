const PRODUCTION_API_URL = 'https://api.wroclive.kijmoshi.xyz';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Where the API lives.
 *
 * The public API is the safe default, including in Expo Go: a packager on the
 * laptop is not necessarily running the matching backend or a current GTFS
 * snapshot. Local backend work remains explicit through EXPO_PUBLIC_API_URL.
 */
export const API_URL = trimSlash(
  process.env.EXPO_PUBLIC_API_URL || PRODUCTION_API_URL,
);

/** How often each kind of data is re-fetched. Vehicles move; timetables do not. */
export const REFRESH_MS = {
  vehicles: 10_000,
  departures: 30_000,
  alerts: 5 * 60_000,
} as const;
