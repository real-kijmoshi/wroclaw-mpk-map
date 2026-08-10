import Constants from 'expo-constants';

const PRODUCTION_API_URL = 'https://api.wroclive.kijmoshi.xyz';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** The Expo CLI host is the development machine a phone can actually reach. */
const developmentApiUrl = (): string | null => {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return null;

  try {
    const url = new URL(hostUri.includes('://') ? hostUri : `http://${hostUri}`);
    return `http://${url.hostname}:3000`;
  } catch {
    return null;
  }
};

/**
 * Where the API lives.
 *
 * Explicit configuration always wins. During an Expo CLI development session,
 * use that CLI's host on port 3000 so a phone loads the matching local backend;
 * production builds keep using the public HTTPS API.
 */
export const API_URL = trimSlash(
  process.env.EXPO_PUBLIC_API_URL ||
    ((typeof __DEV__ !== 'undefined' && __DEV__) ? developmentApiUrl() : null) ||
    PRODUCTION_API_URL,
);

/** How often each kind of data is re-fetched. Vehicles move; timetables do not. */
export const REFRESH_MS = {
  vehicles: 10_000,
  departures: 30_000,
  alerts: 5 * 60_000,
} as const;
