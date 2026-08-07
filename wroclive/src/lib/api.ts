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
  | 'train'
  | 'unknown';

export type Lines = Record<string, string[]> & {
  allTrams: string[];
  allBuses: string[];
  /** Present only when KD trains are enabled on the server. */
  allTrains?: string[];
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
  /** KD-only fields. The server adds them conditionally, so they are optional. */
  operator?: string | null;
  routeId?: string | null;
  tripId?: string | null;
  vehicleLabel?: string | null;
  delaySeconds?: number | null;
  occupancyStatus?: string | null;
  occupancyPercentage?: number | null;
};

/** The deliberately small vehicle record repeated on every map refresh. */
export type FleetVehicle = Omit<Vehicle, 'trip' | 'updatedAt'> & {
  trip: Pick<VehicleTrip, 'headsign' | 'towards'> | null;
};

export type Locations = {
  locations: FleetVehicle[];
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
  operator?: string | null;
  platformCode?: string | null;
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

const isFleetVehicle = (value: unknown): value is FleetVehicle =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.line === 'string' &&
  Number.isFinite(value.lat) &&
  Number.isFinite(value.lon);

const optionalString = (value: unknown): string | null | undefined =>
  typeof value === 'string' ? value : undefined;
const optionalNumber = (value: unknown): number | null | undefined =>
  Number.isFinite(value) ? (value as number) : undefined;

export function normaliseLocations(payload: unknown): Locations {
  if (!isRecord(payload) || !Array.isArray(payload.locations)) {
    throw new ApiError('Unexpected /locations payload', 0);
  }
  const locations = payload.locations.filter(isFleetVehicle).map((vehicle) => ({
    id: vehicle.id,
    line: vehicle.line,
    type: vehicle.type,
    lat: vehicle.lat,
    lon: vehicle.lon,
    heading: Number.isFinite(vehicle.heading) ? vehicle.heading : null,
    trip: isRecord(vehicle.trip)
      ? {
          headsign: typeof vehicle.trip.headsign === 'string' ? vehicle.trip.headsign : null,
          towards: typeof vehicle.trip.towards === 'string' ? vehicle.trip.towards : null,
        }
      : null,
    operator: optionalString(vehicle.operator),
    routeId: optionalString(vehicle.routeId),
    tripId: optionalString(vehicle.tripId),
    vehicleLabel: optionalString(vehicle.vehicleLabel),
    delaySeconds: optionalNumber(vehicle.delaySeconds),
    occupancyStatus: optionalString(vehicle.occupancyStatus),
    occupancyPercentage: optionalNumber(vehicle.occupancyPercentage),
  }));
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

/** Seconds after midnight, in Europe/Warsaw — the same clock the server uses. */
function warsawSecondsNow(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: 'hour' | 'minute' | 'second') =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  return (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
}

/**
 * Departures come in two shapes: MPK's `{departure, inSeconds, serviceDay}`
 * and KD's `{scheduledDeparture, departureSeconds, operator}`. Both become
 * the one `Departure` the board knows how to render.
 */
export function normaliseDepartures(payload: unknown): Departures {
  if (!isRecord(payload) || !isRecord(payload.stop) || !Array.isArray(payload.departures)) {
    throw new ApiError('Unexpected departures payload', 0);
  }
  const secondsNow = warsawSecondsNow();
  const departures = payload.departures.flatMap((item): Departure[] => {
    if (!isRecord(item) || typeof item.line !== 'string') return [];
    const hasMpkTime = Number.isFinite(item.inSeconds);
    const hasKdTime = Number.isFinite(item.departureSeconds);
    if (!hasMpkTime && !hasKdTime) return [];
    return [
      {
        line: item.line,
        type: item.type as LineType,
        headsign: typeof item.headsign === 'string' ? item.headsign : null,
        departure:
          typeof item.departure === 'string'
            ? item.departure
            : typeof item.scheduledDeparture === 'string'
              ? item.scheduledDeparture
              : '',
        inSeconds: hasMpkTime
          ? (item.inSeconds as number)
          : (item.departureSeconds as number) - secondsNow,
        tripId: typeof item.tripId === 'string' ? item.tripId : '',
        serviceDay: item.serviceDay === 'yesterday' ? 'yesterday' : 'today',
        operator: optionalString(item.operator),
        platformCode: optionalString(item.platformCode),
      },
    ];
  });
  return {
    stop: payload.stop as unknown as Stop,
    departures: departures.slice(0, 12),
  };
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

/** One `Vehicle` in the app's shape, from either provider's wire format. */
function normaliseVehicle(value: unknown): Vehicle {
  const record = isRecord(value) ? value : {};
  return {
    id: typeof record.id === 'string' ? record.id : '',
    line: typeof record.line === 'string' && record.line ? record.line : '?',
    type: (record.type as LineType) ?? 'unknown',
    lat: Number.isFinite(record.lat) ? (record.lat as number) : 0,
    lon: Number.isFinite(record.lon) ? (record.lon as number) : 0,
    heading: Number.isFinite(record.heading) ? (record.heading as number) : null,
    trip: isRecord(record.trip)
      ? {
          headsign: typeof record.trip.headsign === 'string' ? record.trip.headsign : null,
          direction: typeof record.trip.direction === 'string' ? record.trip.direction : null,
          towards: typeof record.trip.towards === 'string' ? record.trip.towards : null,
          directionId: Number.isFinite(record.trip.directionId)
            ? (record.trip.directionId as number)
            : null,
          shapeId: typeof record.trip.shapeId === 'string' ? record.trip.shapeId : null,
          delaySeconds: Number.isFinite(record.trip.delaySeconds)
            ? (record.trip.delaySeconds as number)
            : null,
          tripId: typeof record.trip.tripId === 'string' ? record.trip.tripId : null,
          stopsAhead: Number.isFinite(record.trip.stopsAhead)
            ? (record.trip.stopsAhead as number)
            : 0,
          atStop:
            typeof record.trip.atStop === 'string'
              ? record.trip.atStop
              : isRecord(record.trip.atStop) && typeof record.trip.atStop.name === 'string'
                ? record.trip.atStop.name
                : null,
          previousStop: isRecord(record.trip.previousStop)
            ? {
                id: typeof record.trip.previousStop.id === 'string' ? record.trip.previousStop.id : '',
                name:
                  typeof record.trip.previousStop.name === 'string'
                    ? record.trip.previousStop.name
                    : '',
              }
            : null,
          nextStop: isRecord(record.trip.nextStop)
            ? {
                id: typeof record.trip.nextStop.id === 'string' ? record.trip.nextStop.id : '',
                name: typeof record.trip.nextStop.name === 'string' ? record.trip.nextStop.name : '',
                etaSeconds: Number.isFinite(record.trip.nextStop.etaSeconds)
                  ? (record.trip.nextStop.etaSeconds as number)
                  : null,
                scheduled: typeof record.trip.nextStop.scheduled === 'string'
                  ? record.trip.nextStop.scheduled
                  : null,
              }
            : null,
        }
      : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    operator: optionalString(record.operator),
    routeId: optionalString(record.routeId),
    tripId: optionalString(record.tripId),
    vehicleLabel: optionalString(record.vehicleLabel),
    delaySeconds: optionalNumber(record.delaySeconds),
    occupancyStatus: optionalString(record.occupancyStatus),
    occupancyPercentage: optionalNumber(record.occupancyPercentage),
  };
}

/**
 * A KD stop from the trip detail into the app's `TripStop`. Trains have no
 * shape geometry, so `lat`/`lon` are 0 and there is no ETA projection — the
 * schedule column is honest about that instead of inventing running time.
 */
function kdStopToTripStop(stop: Record<string, unknown>, passed: boolean): TripStop {
  const name =
    typeof stop.name === 'string'
      ? stop.name
      : typeof stop.stopId === 'string'
        ? stop.stopId
        : '?';
  const platformCode = typeof stop.platformCode === 'string' ? stop.platformCode : null;
  const scheduled =
    (typeof stop.predictedDeparture === 'string' ? stop.predictedDeparture : null) ??
    (typeof stop.predictedArrival === 'string' ? stop.predictedArrival : null) ??
    (typeof stop.scheduledDeparture === 'string' ? stop.scheduledDeparture : null) ??
    (typeof stop.scheduledArrival === 'string' ? stop.scheduledArrival : null);
  return {
    id: typeof stop.stopId === 'string' ? stop.stopId : '',
    name: platformCode ? `${name} (peron ${platformCode})` : name,
    lat: 0,
    lon: 0,
    sequence: Number.isFinite(stop.sequence) ? (stop.sequence as number) : 0,
    scheduled,
    etaSeconds: null,
    agoSeconds: null,
    distanceMeters: 0,
    passed,
  };
}

/**
 * `/vehicle/:id` in two shapes: MPK's `{vehicle, trip: VehicleTripDetail}`
 * and KD's `{vehicle, trip: {stopsAhead: KDStop[]}}`. Both end up as the one
 * `VehicleDetail` the vehicle screen renders.
 */
export function normaliseVehicleDetail(payload: unknown): VehicleDetail {
  if (!isRecord(payload) || !isRecord(payload.vehicle)) {
    throw new ApiError('Unexpected /vehicle payload', 0);
  }
  const vehicle = normaliseVehicle(payload.vehicle);
  const rawTrip = payload.trip;
  if (!isRecord(rawTrip)) return { vehicle, trip: null };

  // MPK's detail already matches the app's shape.
  if (Array.isArray(rawTrip.nextStops)) {
    return { vehicle, trip: rawTrip as unknown as VehicleTripDetail };
  }

  // KD's detail.
  const stopsAhead = Array.isArray(rawTrip.stopsAhead)
    ? rawTrip.stopsAhead.filter(isRecord)
    : [];
  const previousStop = isRecord(rawTrip.previousStop)
    ? kdStopToTripStop(rawTrip.previousStop, true)
    : null;
  const nextStops = stopsAhead.map((stop) => kdStopToTripStop(stop, false));
  const delaySeconds = Number.isFinite(rawTrip.delaySeconds)
    ? (rawTrip.delaySeconds as number)
    : null;
  return {
    vehicle,
    trip: {
      line: typeof rawTrip.routeName === 'string' && rawTrip.routeName ? rawTrip.routeName : vehicle.line,
      shapeId: null,
      directionId: null,
      headsign: typeof rawTrip.headsign === 'string' ? rawTrip.headsign : null,
      direction: null,
      towards: null,
      origin: null,
      onRoute: true,
      progressMeters: null,
      routeMeters: 0,
      shapeIndex: null,
      delaySeconds,
      scheduleMatched: delaySeconds !== null,
      atStop: null,
      previousStops: previousStop ? [previousStop] : [],
      previousStop,
      nextStop: nextStops[0] ?? null,
      nextStops,
      stopsAhead: nextStops.length,
      stopCount: nextStops.length + (previousStop ? 1 : 0),
    },
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
  const query = new URLSearchParams({ format: 'map' });
  if (lines?.length) query.set('line', lines.join(','));
  return normaliseLocations(await apiGet<unknown>(`/locations?${query}`, options));
};

export const getVehicle = async (id: string, options?: GetOptions) =>
  normaliseVehicleDetail(
    await apiGet<unknown>(`/vehicle/${encodeURIComponent(id)}`, options),
  );

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
