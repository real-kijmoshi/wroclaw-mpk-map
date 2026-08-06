import { API_URL } from './config';

/**
 * The only way this app talks to the server.
 *
 * Everything goes through `apiGet` because the server answers 503 with a
 * `{error, state}` body for up to a minute after boot while it ingests the
 * GTFS feed. Parsing that as data is how the line picker used to crash on
 * every cold start, so: retry 503 here, and validate every payload before it
 * reaches component state.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Backoff between 503 retries. The server needs 30–60s on a cold start. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 5000, 5000];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export type GetOptions = {
  signal?: AbortSignal;
  /** Give up on 503 immediately. Used by polls, which will come round again anyway. */
  retryWhileLoading?: boolean;
};

export async function apiGet<T>(path: string, options: GetOptions = {}): Promise<T> {
  const { signal, retryWhileLoading = true } = options;
  let attempt = 0;

  for (;;) {
    const response = await fetch(`${API_URL}${path}`, {
      signal,
      headers: { Accept: 'application/json' },
    });

    // Still ingesting the timetable — not an error, just not yet.
    if (response.status === 503 && retryWhileLoading && attempt < RETRY_DELAYS_MS.length) {
      const header = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
      // The server asks for 15s; clamp it so the first screen is not frozen
      // that long, and so a bad header cannot stall the app.
      const wait = Number.isFinite(header)
        ? Math.min(Math.max(header * 1000, 500), 5000)
        : RETRY_DELAYS_MS[attempt];
      attempt += 1;
      await sleep(wait, signal);
      continue;
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string; state?: string };
        if (body?.error) detail = body.error;
      } catch {
        // A non-JSON error body tells us nothing more than the status did.
      }
      throw new ApiError(detail, response.status);
    }

    return (await response.json()) as T;
  }
}

/* -------------------------------------------------------------------------- */
/* Payload types — mirrors of what server/src/routes.js actually serves.        */
/* -------------------------------------------------------------------------- */

export type LineType =
  | 'tram'
  | 'tramSpecial'
  | 'tramTemporary'
  | 'bus'
  | 'busNight'
  | 'busSuburban'
  | 'busTemporary'
  | 'busZone'
  | 'busExpress'
  | 'busSpecial'
  | 'unknown';

export type Lines = Record<string, string[]> & {
  allTrams: string[];
  allBuses: string[];
};

export type StopRef = {
  id: string;
  name: string;
  etaSeconds?: number | null;
  scheduled?: string | null;
};

export type VehicleTrip = {
  headsign: string | null;
  direction: string | null;
  towards: string | null;
  directionId: number | null;
  shapeId: string | null;
  delaySeconds: number | null;
  tripId: string | null;
  stopsAhead: number;
  atStop: string | null;
  previousStop: { id: string; name: string } | null;
  nextStop: StopRef | null;
};

export type Vehicle = {
  id: string;
  line: string;
  type: LineType;
  lat: number;
  lon: number;
  heading: number | null;
  trip: VehicleTrip | null;
  updatedAt: string;
};

export type Locations = {
  locations: Vehicle[];
  count: number;
  lastUpdated: string | null;
  source: string | null;
  stale: boolean;
};

export type TripStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  sequence: number;
  scheduled: string | null;
  etaSeconds: number | null;
  agoSeconds: number | null;
  distanceMeters: number;
  passed: boolean;
};

export type VehicleTripDetail = {
  line: string;
  shapeId: string | null;
  directionId: number | null;
  headsign: string | null;
  direction: string | null;
  towards: string | null;
  origin: string | null;
  onRoute: boolean;
  progressMeters: number | null;
  routeMeters: number;
  shapeIndex: number | null;
  delaySeconds: number | null;
  scheduleMatched: boolean;
  atStop: { id: string; name: string; distanceMeters: number } | null;
  previousStops: TripStop[];
  previousStop: TripStop | null;
  nextStop: TripStop | null;
  nextStops: TripStop[];
  stopsAhead: number;
  stopCount: number;
};

export type VehicleDetail = {
  vehicle: Vehicle;
  trip: VehicleTripDetail | null;
};

export type ShapeStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  arrival: string | null;
  departure: string | null;
};

/** `/shapes/:line?format=compact` — points are `[lat, lon]` pairs. */
export type Shape = {
  line: string;
  shapeId: string;
  direction: string | null;
  headsign: string | null;
  directionId: number | null;
  tripCount: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  points: [number, number][];
  stops: ShapeStop[];
};

export type Stop = {
  id: string;
  code?: string;
  name: string;
  lat: number;
  lon: number;
  distance?: number;
};

export type Departure = {
  line: string;
  type: LineType;
  headsign: string | null;
  departure: string;
  inSeconds: number;
  tripId: string;
  serviceDay: 'today' | 'yesterday';
};

export type Departures = {
  stop: Stop;
  departures: Departure[];
};

export type Alert = {
  id: string;
  title: string | null;
  content: string;
  url: string | null;
  timestamp: number;
  source: string;
  affected: string[];
  types: Record<string, LineType>;
};

export type Alerts = {
  alerts: Alert[];
  lastRefreshAt: string | null;
};

/* -------------------------------------------------------------------------- */
/* Validation — a payload only becomes state once it looks like what we expect. */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Categories keyed to arrays of line labels. A 503 body (`{error, state}`)
 * fails here rather than being rendered as a category called "error".
 */
export function normaliseLines(payload: unknown): Lines {
  if (!isRecord(payload)) throw new ApiError('Unexpected /lines payload', 0);

  const lines: Record<string, string[]> = {};
  for (const [category, value] of Object.entries(payload)) {
    if (isStringArray(value)) lines[category] = value;
  }

  if (!isStringArray(lines.allTrams) || !isStringArray(lines.allBuses)) {
    throw new ApiError('Unexpected /lines payload', 0);
  }
  return lines as Lines;
}

const isVehicle = (value: unknown): value is Vehicle =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.line === 'string' &&
  Number.isFinite(value.lat) &&
  Number.isFinite(value.lon);

export function normaliseLocations(payload: unknown): Locations {
  if (!isRecord(payload) || !Array.isArray(payload.locations)) {
    throw new ApiError('Unexpected /locations payload', 0);
  }
  const locations = payload.locations.filter(isVehicle);
  return {
    locations,
    count: locations.length,
    lastUpdated: typeof payload.lastUpdated === 'string' ? payload.lastUpdated : null,
    source: typeof payload.source === 'string' ? payload.source : null,
    stale: payload.stale === true,
  };
}

export function normaliseAlerts(payload: unknown): Alerts {
  if (!isRecord(payload) || !Array.isArray(payload.alerts)) {
    throw new ApiError('Unexpected /alerts payload', 0);
  }
  const alerts = payload.alerts.filter(
    (alert): alert is Alert => isRecord(alert) && typeof alert.id === 'string',
  );
  return {
    alerts,
    lastRefreshAt: typeof payload.lastRefreshAt === 'string' ? payload.lastRefreshAt : null,
  };
}

export function normaliseDepartures(payload: unknown): Departures {
  if (!isRecord(payload) || !isRecord(payload.stop) || !Array.isArray(payload.departures)) {
    throw new ApiError('Unexpected departures payload', 0);
  }
  const departures = payload.departures.filter(
    (item): item is Departure =>
      isRecord(item) && typeof item.line === 'string' && Number.isFinite(item.inSeconds),
  );
  return { stop: payload.stop as unknown as Stop, departures };
}

/** Compact shape points only; anything unparseable is dropped, not NaN-rendered. */
export function normaliseShape(payload: unknown): Shape {
  if (!isRecord(payload) || !Array.isArray(payload.points)) {
    throw new ApiError('Unexpected /shapes payload', 0);
  }
  const points = payload.points.filter(
    (point): point is [number, number] =>
      Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (!points.length) throw new ApiError('Route has no geometry', 0);

  return {
    ...(payload as unknown as Shape),
    points,
    stops: Array.isArray(payload.stops) ? (payload.stops as ShapeStop[]) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                    */
/* -------------------------------------------------------------------------- */

export const getLines = async (options?: GetOptions) =>
  normaliseLines(await apiGet<unknown>('/lines', options));

export const getLocations = async (lines: string[] | null, options?: GetOptions) => {
  // The filter runs server-side so a narrow selection is a smaller payload,
  // not the whole fleet thrown away on the phone.
  const query = lines?.length ? `?line=${encodeURIComponent(lines.join(','))}` : '';
  return normaliseLocations(await apiGet<unknown>(`/locations${query}`, options));
};

export const getVehicle = (id: string, options?: GetOptions) =>
  apiGet<VehicleDetail>(`/vehicle/${encodeURIComponent(id)}`, options);

/**
 * The variant a vehicle is actually running.
 *
 * The heading matters: both directions of a line share the street, so position
 * alone picks the opposite direction about half the time — and that means the
 * wrong terminus and a stop list the vehicle never reaches.
 */
export const getShape = async (
  line: string,
  position: { lat?: number; lon?: number; heading?: number | null } = {},
  options?: GetOptions,
) => {
  const query = new URLSearchParams({ format: 'compact' });
  if (Number.isFinite(position.lat) && Number.isFinite(position.lon)) {
    query.set('lat', String(position.lat));
    query.set('lon', String(position.lon));
  }
  if (position.heading !== null && Number.isFinite(position.heading)) {
    query.set('heading', String(position.heading));
  }
  return normaliseShape(
    await apiGet<unknown>(`/shapes/${encodeURIComponent(line)}?${query.toString()}`, options),
  );
};

export const getDepartures = async (stopId: string, options?: GetOptions) =>
  normaliseDepartures(
    await apiGet<unknown>(`/stop/${encodeURIComponent(stopId)}/departures?limit=12`, options),
  );

export const getStopsNear = async (
  lat: number,
  lon: number,
  radius = 700,
  options?: GetOptions,
) => {
  const payload = await apiGet<{ stops: Stop[] }>(
    `/stops/near?lat=${lat}&lon=${lon}&radius=${radius}&limit=40`,
    options,
  );
  return Array.isArray(payload?.stops) ? payload.stops : [];
};

export const getAlerts = async (options?: GetOptions) =>
  normaliseAlerts(await apiGet<unknown>('/alerts', options));
