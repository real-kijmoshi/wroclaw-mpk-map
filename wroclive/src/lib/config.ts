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

/**
 * How often each kind of data is re-fetched. Vehicles move; timetables do not.
 *
 * The vehicle poll is deliberately as fast as the server's own upstream poll
 * (`vehicles.pollIntervalMs`), because every step of the chain adds its whole
 * interval to how far behind the marker sits: at 10s each, a fix was on average
 * ten seconds old before it reached the screen and up to twenty at the worst
 * alignment — a hundred-odd metres of city street, which is what "the bus is
 * ahead of its marker" actually is. Asking this often is close to free: an
 * unchanged fleet answers 304 against the ETag `apiGet()` sends back, so a poll
 * that lands between two server polls costs a few header bytes and no payload.
 *
 * Kept in step with `VEHICLE_REFRESH_MS` in `server/views/map.html` and with
 * `stats.clientPollIntervalMs`, which reads one map poll as one client-poll
 * interval of watching and would otherwise double its audience estimate.
 */
export const REFRESH_MS = {
  vehicles: 5_000,
  departures: 30_000,
  alerts: 5 * 60_000,
} as const;
