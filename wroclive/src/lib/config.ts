import Constants from 'expo-constants';
import { Platform } from 'react-native';

const DEFAULT_PORT = 3000;
const PRODUCTION_API_URL = 'https://api.wroclive.kijmoshi.xyz';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * The dev server's host, so a phone on the same Wi-Fi reaches the API without
 * anyone editing a file. `localhost` is the device itself once the bundle is
 * off the laptop, which is the classic "works in the simulator only" bug.
 */
function fromDevServer(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older Expo Go payloads carry it here instead.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;

  const host = hostUri?.split(':')[0];
  if (!host) return null;

  return `http://${host}:${DEFAULT_PORT}`;
}

/**
 * Where the API lives.
 *
 * `EXPO_PUBLIC_API_URL` wins so a build can be pointed at production; without
 * it the app follows whatever machine served the bundle.
 */
export const API_URL = trimSlash(
  process.env.EXPO_PUBLIC_API_URL ||
    (__DEV__
      ? fromDevServer() ||
        (Platform.OS === 'web'
          ? `http://localhost:${DEFAULT_PORT}`
          : `http://127.0.0.1:${DEFAULT_PORT}`)
      : PRODUCTION_API_URL),
);

/** How often each kind of data is re-fetched. Vehicles move; timetables do not. */
export const REFRESH_MS = {
  vehicles: 10_000,
  departures: 30_000,
  alerts: 5 * 60_000,
} as const;
