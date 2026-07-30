import Constants from 'expo-constants';

/**
 * Base URL of the backend.
 *
 * It used to be a plain-HTTP IP address committed to the repo, which both app
 * stores reject (App Transport Security / cleartext traffic) and which broke
 * every time the server moved. It now comes from the Expo config, so it can be
 * set per build profile in eas.json or with API_URL in the shell.
 */
export const API_URL = (
  Constants.expoConfig?.extra?.apiUrl ?? 'https://wroclaw-mpk-api.onrender.com'
).replace(/\/+$/, '');

class ApiError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * GET a JSON endpoint with a timeout and a clear error for every failure mode.
 * Without the timeout a stalled mobile connection leaves the UI spinning
 * forever, because fetch() on React Native never gives up on its own.
 */
export async function apiGet(path, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (response.status === 503) {
      throw new ApiError('Serwer przygotowuje rozkłady jazdy. Spróbuj za chwilę.', {
        status: 503,
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new ApiError(`Błąd serwera (${response.status})`, { status: response.status });
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError('Przekroczono czas oczekiwania na odpowiedź.', { retryable: true });
    }
    throw new ApiError('Brak połączenia z serwerem.', { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const fetchLines = (options) => apiGet('/lines', options);

export const fetchVehicles = (options) => apiGet('/locations', options);

export const fetchAlerts = (options) => apiGet('/alerts', options);

export const fetchShape = (line, { lat, lon, ...options } = {}) => {
  const params = new URLSearchParams({ format: 'compact' });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
  }
  return apiGet(`/shapes/${encodeURIComponent(line)}?${params}`, options);
};

export const fetchDepartures = (stopId, options) =>
  apiGet(`/stop/${encodeURIComponent(stopId)}/departures?limit=8`, options);

export { ApiError };
