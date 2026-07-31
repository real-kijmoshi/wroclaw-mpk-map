import Constants from "expo-constants";

/**
 * Shared API client.
 *
 * Two things this exists to prevent, both of which already happened:
 *
 * The backend answers 503 for up to a minute after boot while it ingests the
 * GTFS feed. Callers parsed that body as if it were data — `/lines` returned
 * `{error, retryAfter}` and the app set it as the line list, which crashed the
 * picker on every cold start. So: real status checks, a bounded retry on 503,
 * and validation before anything reaches state.
 *
 * And a hung socket used to leave a spinner up forever, because fetch() in
 * React Native never times out on its own.
 *
 * Do not call fetch directly from a component.
 */

const DEFAULT_TIMEOUT = 12000;

/**
 * Base URL of the backend.
 *
 * It used to be a plain-HTTP IP address committed to the repo, which both app
 * stores reject and which broke every time the server moved. It comes from the
 * Expo config now, so it is set per build profile in eas.json.
 */
export const API_URL = (
  Constants.expoConfig?.extra?.apiUrl ?? "https://wroclaw-mpk-api.onrender.com"
).replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

/**
 * GET a JSON endpoint, retrying while the server is still starting up.
 *
 * @param {string} path
 * @param {{ signal?: AbortSignal, timeout?: number, retries?: number }} options
 */
export async function apiGet(path, { signal, timeout = DEFAULT_TIMEOUT, retries = 3 } = {}) {
  let attempt = 0;

  for (;;) {
    const timer = AbortSignal.timeout(timeout);
    const composed = signal && AbortSignal.any ? AbortSignal.any([signal, timer]) : signal || timer;

    try {
      const response = await fetch(`${API_URL}${path}`, {
        signal: composed,
        headers: { accept: "application/json" },
      });

      // Still ingesting the feed — worth waiting for, unlike a 4xx.
      if (response.status === 503 && attempt < retries) {
        attempt += 1;
        await sleep(Math.min(2000 * attempt, 8000), signal);
        continue;
      }

      if (!response.ok) {
        throw new ApiError(`${path} responded ${response.status}`, response.status);
      }

      return await response.json();
    } catch (error) {
      const retryable =
        error.name !== "AbortError" && !(error instanceof ApiError) && attempt < retries;
      if (!retryable) throw error;
      attempt += 1;
      await sleep(Math.min(2000 * attempt, 8000), signal);
    }
  }
}

/** The line index, or null when the payload is not the shape we expect. */
export function normaliseLines(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const lines = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) lines[key] = value;
  }
  return Object.keys(lines).length ? lines : null;
}

/**
 * Shape points, tolerant of every wire format this server has emitted.
 *
 * It has served raw GTFS column names (`shape_pt_lat`/`shape_pt_lon`), objects
 * (`{lat, lon}`) and now compact `[lat, lon]` pairs. Reading only one of them
 * produced NaN for every point, the filter dropped them all, and `<Polyline>`
 * silently rendered nothing — a blank map with no error. If the format changes
 * again, change it here and nowhere else.
 */
export function toCoordinates(points) {
  if (!Array.isArray(points)) return [];

  return points
    .map((point) => {
      if (Array.isArray(point)) {
        return { latitude: Number(point[0]), longitude: Number(point[1]) };
      }
      return {
        latitude: Number(point?.lat ?? point?.latitude ?? point?.shape_pt_lat),
        longitude: Number(point?.lon ?? point?.longitude ?? point?.shape_pt_lon),
      };
    })
    .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
}

/** Stops along a route, flattened for rendering, tolerant of both formats. */
export function toStops(stops) {
  if (!Array.isArray(stops)) return [];

  return stops
    .map((entry) => {
      const stop = entry?.stop ?? entry;
      return {
        id: stop?.id ?? stop?.stop_id,
        name: stop?.name ?? stop?.stop_name,
        latitude: Number(stop?.lat ?? stop?.stop_lat),
        longitude: Number(stop?.lon ?? stop?.stop_lon),
        departure: entry?.departure ?? entry?.departure_time,
      };
    })
    .filter(
      (stop) =>
        stop.id != null && Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude),
    );
}

export const fetchLines = (options) => apiGet("/lines", options);

export const fetchVehicles = (options) => apiGet("/locations", options);

export const fetchAlerts = (options) => apiGet("/alerts", options);

export const fetchShape = (line, { lat, lon, ...options } = {}) => {
  const params = new URLSearchParams({ format: "compact" });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
  }
  return apiGet(`/shapes/${encodeURIComponent(line)}?${params}`, options);
};

export const fetchDepartures = (stopId, options) =>
  apiGet(`/stop/${encodeURIComponent(stopId)}/departures?limit=8`, options);

export const fetchStopsNear = (lat, lon, options) =>
  apiGet(`/stops/near?lat=${lat}&lon=${lon}&radius=600`, options);
