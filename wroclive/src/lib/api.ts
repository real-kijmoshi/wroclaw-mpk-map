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

/**
 * Last ETag and payload per request path. /locations carries a strong ETag
 * derived from the serialized fleet; sending it back lets the server answer
 * 304 when nothing moved, so an unchanged poll is a few header bytes instead
 * of the whole 10–25 KB payload.
 */
const conditionalCache = new Map<string, { etag: string; data: unknown }>();
const CONDITIONAL_CACHE_MAX = 32;

export async function apiGet<T>(path: string, options: GetOptions = {}): Promise<T> {
  const { signal, retryWhileLoading = true } = options;
  let attempt = 0;

  const cached = conditionalCache.get(path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  for (;;) {
    const response = await fetch(`${API_URL}${path}`, {
      signal,
      headers,
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

    // Nothing changed since the last poll — keep the payload we already hold.
    if (response.status === 304) {
      if (cached) return cached.data as T;
      throw new ApiError('HTTP 304 with no cached copy', 304);
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

    const etag = response.headers.get('ETag');
    const data = (await response.json()) as T;
    if (etag) {
      conditionalCache.set(path, { etag, data });
      if (conditionalCache.size > CONDITIONAL_CACHE_MAX) {
        const oldest = conditionalCache.keys().next().value;
        if (oldest !== undefined) conditionalCache.delete(oldest);
      }
    }
    return data;
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

/**
 * What the vehicle wearing this side number actually is.
 *
 * The server merges two answers into this: the feed's own `vehicle_types.txt`
 * where the timetable ships one, and the roster in `server/src/fleet-roster.json`
 * keyed on the side number where it does not. Which one answered is not the
 * client's problem — what is, is that every field is independently unknown, and
 * `null` means neither said: it must render as "no information", never as "no".
 * A rider who boards expecting a ramp that is not there is worse off than one
 * who was told nothing. The whole block is absent when nothing is known at all.
 */
export type VehicleFleetInfo = {
  model: string | null;
  kind: 'tram' | 'bus' | null;
  lowFloor: 'full' | 'partial' | 'none' | null;
  wheelchair: boolean | null;
  airConditioning: boolean | null;
  years: string | null;
  source: string | null;
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
  /** Optional metadata the server may include for some providers (e.g. Kłosok). */
  operator?: string | null;
  routeId?: string | null;
  tripId?: string | null;
  vehicleLabel?: string | null;
  delaySeconds?: number | null;
  occupancyStatus?: string | null;
  occupancyPercentage?: number | null;
  /** Side number (`Nr_Boczny`); the key the fleet roster below is looked up by. */
  vehicleNumber?: string | null;
  fleet?: VehicleFleetInfo | null;
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
  /**
   * `wheelchair_accessible` from the matched run in the timetable, and null
   * whenever no run matched — the server never borrows another departure's
   * answer, the same rule that keeps it from borrowing another departure's
   * times.
   */
  wheelchairAccessible: boolean | null;
  /**
   * The type the timetable rosters onto this run, when the feed ships a
   * `vehicle_types.txt` to say so. Its attributes are already folded into
   * `vehicle.fleet` by the server — this is the id, for debugging which answer
   * a vehicle got.
   */
  vehicleTypeId: string | null;
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
  /** Platform ids are retained only for legacy map payload compatibility. */
  ids?: string[];
  code?: string;
  name: string;
  lines?: string[];
  lat: number;
  lon: number;
  /**
   * Metres from whatever point the query used — which is *not* always the
   * rider. The stops layer asks around the centre of the map, so only a
   * caller that knows it asked around a person may present this as "how far
   * away it is"; everyone else measures for themselves.
   */
  distance?: number;
};

export type Departure = {
  line: string;
  type: LineType;
  headsign: string | null;
  departure: string;
  inSeconds: number;
  tripId: string;
  serviceDay: 'today' | 'yesterday' | 'tomorrow';
  operator?: string | null;
  platformCode?: string | null;
  realtime?: boolean;
  predictedInSeconds?: number | null;
  vehicleId?: string | null;
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

export type IncidentTimelineEntry = {
  id: string;
  timestamp: number;
  kind: 'reported' | 'diversion' | 'replacement_bus' | 'update' | 'resolved' | 'unknown';
  title: string;
  detail: string | null;
  sourceAlertIds: string[];
};

export type Incident = {
  schemaVersion: number | null;
  id: string;
  status: 'active' | 'resolved' | 'unknown';
  severity: 'minor' | 'moderate' | 'major' | 'unknown';
  title: string;
  locationName: string | null;
  affected: string[];
  types: Record<string, LineType>;
  summary: string;
  shortNotificationTitle: string | null;
  shortNotificationBody: string | null;
  mapHints: {
    stopNames: string[];
    streetNames: string[];
    areaNames: string[];
  };
  timeline: IncidentTimelineEntry[];
  sourceAlertIds: string[];
  firstSeenAt: number;
  lastUpdatedAt: number;
  ai?: {
    generated?: boolean;
    provider?: string | null;
    model?: string | null;
    confidence?: 'low' | 'medium' | 'high' | null;
    error?: string | null;
  };
};

export type IncidentsResponse = {
  incidents: Incident[];
  lastRefreshAt: string | null;
  ai?: {
    enabled?: boolean;
    provider?: string | null;
    model?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
  };
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

const LOW_FLOOR = ['full', 'partial', 'none'] as const;

/**
 * The vehicle's own attributes, read defensively like every other payload here.
 *
 * The distinction that has to survive is `false` versus "not stated": a
 * boolean is kept only when it really is one, and anything else — a missing
 * field, a string, a number the server should not have sent — becomes `null`,
 * which the UI renders as "no information" rather than as "no".
 */
function normaliseFleet(value: unknown): VehicleFleetInfo | null {
  if (!isRecord(value)) return null;
  const triState = (raw: unknown) => (typeof raw === 'boolean' ? raw : null);
  const lowFloor = LOW_FLOOR.find((option) => option === value.lowFloor) ?? null;
  const kind = value.kind === 'tram' || value.kind === 'bus' ? value.kind : null;

  const fleet: VehicleFleetInfo = {
    model: typeof value.model === 'string' && value.model ? value.model : null,
    kind,
    lowFloor,
    wheelchair: triState(value.wheelchair),
    airConditioning: triState(value.airConditioning),
    years: typeof value.years === 'string' && value.years ? value.years : null,
    source: typeof value.source === 'string' && value.source ? value.source : null,
  };

  // A block where every field came back unknown says nothing the absent block
  // does not, so it is dropped and the UI has one empty case to handle.
  const known = Object.values(fleet).some((field) => field !== null);
  return known ? fleet : null;
}

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

const INCIDENT_STATUSES = new Set<Incident['status']>(['active', 'resolved', 'unknown']);
const INCIDENT_SEVERITIES = new Set<Incident['severity']>([
  'minor',
  'moderate',
  'major',
  'unknown',
]);
const TIMELINE_KINDS = new Set<IncidentTimelineEntry['kind']>([
  'reported',
  'diversion',
  'replacement_bus',
  'update',
  'resolved',
  'unknown',
]);

const stringsOnly = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const normaliseTimelineEntry = (value: unknown): IncidentTimelineEntry | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  if (!Number.isFinite(value.timestamp) || typeof value.title !== 'string') return null;
  if (!TIMELINE_KINDS.has(value.kind as IncidentTimelineEntry['kind'])) return null;
  return {
    id: value.id,
    timestamp: value.timestamp as number,
    kind: value.kind as IncidentTimelineEntry['kind'],
    title: value.title,
    detail: typeof value.detail === 'string' ? value.detail : null,
    sourceAlertIds: stringsOnly(value.sourceAlertIds),
  };
};

/** Grouped incident timelines; malformed candidates are omitted independently. */
export function normaliseIncidents(payload: unknown): IncidentsResponse {
  if (!isRecord(payload) || !Array.isArray(payload.incidents)) {
    throw new ApiError('Unexpected /incidents payload', 0);
  }

  const incidents = payload.incidents.flatMap((value): Incident[] => {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return [];
    if (typeof value.title !== 'string' || typeof value.summary !== 'string') return [];
    if (!INCIDENT_STATUSES.has(value.status as Incident['status'])) return [];
    if (!INCIDENT_SEVERITIES.has(value.severity as Incident['severity'])) return [];
    if (!Number.isFinite(value.firstSeenAt) || !Number.isFinite(value.lastUpdatedAt)) return [];

    const mapHints = isRecord(value.mapHints) ? value.mapHints : {};
    const ai: Incident['ai'] = isRecord(value.ai)
      ? {
          generated: typeof value.ai.generated === 'boolean' ? value.ai.generated : undefined,
          provider: optionalString(value.ai.provider),
          model: optionalString(value.ai.model),
          confidence:
            value.ai.confidence === 'low' ||
            value.ai.confidence === 'medium' ||
            value.ai.confidence === 'high'
              ? value.ai.confidence
              : null,
          error: optionalString(value.ai.error),
        }
      : undefined;

    return [{
      schemaVersion: Number.isFinite(value.schemaVersion) ? (value.schemaVersion as number) : null,
      id: value.id,
      status: value.status as Incident['status'],
      severity: value.severity as Incident['severity'],
      title: value.title,
      locationName: typeof value.locationName === 'string' ? value.locationName : null,
      affected: stringsOnly(value.affected),
      // Line types are server-owned display metadata. Preserve the record while
      // rejecting non-record containers that could poison badge lookups.
      types: isRecord(value.types) ? { ...value.types } as Record<string, LineType> : {},
      summary: value.summary,
      shortNotificationTitle:
        typeof value.shortNotificationTitle === 'string' ? value.shortNotificationTitle : null,
      shortNotificationBody:
        typeof value.shortNotificationBody === 'string' ? value.shortNotificationBody : null,
      mapHints: {
        stopNames: stringsOnly(mapHints.stopNames),
        streetNames: stringsOnly(mapHints.streetNames),
        areaNames: stringsOnly(mapHints.areaNames),
      },
      timeline: Array.isArray(value.timeline)
        ? value.timeline.flatMap((entry) => {
            const timelineEntry = normaliseTimelineEntry(entry);
            return timelineEntry ? [timelineEntry] : [];
          }).sort((left, right) => left.timestamp - right.timestamp)
        : [],
      sourceAlertIds: stringsOnly(value.sourceAlertIds),
      firstSeenAt: value.firstSeenAt as number,
      lastUpdatedAt: value.lastUpdatedAt as number,
      ai,
    }];
  });

  const responseAi = isRecord(payload.ai)
    ? {
        enabled: typeof payload.ai.enabled === 'boolean' ? payload.ai.enabled : undefined,
        provider: optionalString(payload.ai.provider),
        model: optionalString(payload.ai.model),
        lastSuccessAt: optionalString(payload.ai.lastSuccessAt),
        lastError: optionalString(payload.ai.lastError),
      }
    : undefined;

  return {
    incidents,
    lastRefreshAt: typeof payload.lastRefreshAt === 'string' ? payload.lastRefreshAt : null,
    ai: responseAi,
  };
}

/**
 * One stop record, field by field.
 *
 * Every endpoint that serves stops — search, nearby, a line's stop list —
 * comes through here, so a 503 body cannot arrive as a stop called "error" and
 * a missing coordinate cannot reach the map as `NaN`. `lines` is optional
 * because only some endpoints carry it, but it is what lets a nearby list and
 * a map marker say anything about a stop beyond its name.
 */
export function normaliseStop(value: unknown): Stop | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === 'string' && value.id ? value.id : null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const lat = Number.isFinite(value.lat) ? (value.lat as number) : null;
  const lon = Number.isFinite(value.lon) ? (value.lon as number) : null;
  if (!id || !name || lat === null || lon === null) return null;

  const stop: Stop = { id, name, lat, lon };

  const code = optionalString(value.code);
  if (code) stop.code = code;
  if (Number.isFinite(value.distance)) stop.distance = value.distance as number;

  const ids = Array.isArray(value.ids)
    ? value.ids.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  if (ids.length) stop.ids = ids;

  const lines = Array.isArray(value.lines)
    ? value.lines.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  if (lines.length) stop.lines = lines;

  return stop;
}

/** A `{stops: [...]}` body, with every unusable record dropped rather than kept. */
export function normaliseStopList(payload: unknown, endpoint: string): Stop[] {
  if (!isRecord(payload) || !Array.isArray(payload.stops)) {
    throw new ApiError(`Unexpected ${endpoint} payload`, 0);
  }
  return payload.stops.flatMap((item) => {
    const stop = normaliseStop(item);
    return stop ? [stop] : [];
  });
}

/** Only the MPK departure shape is served: `{departure, inSeconds, serviceDay}`. */
export function normaliseDepartures(payload: unknown): Departures {
  if (!isRecord(payload) || !isRecord(payload.stop) || !Array.isArray(payload.departures)) {
    throw new ApiError('Unexpected departures payload', 0);
  }
  const departures = payload.departures.flatMap((item): Departure[] => {
    if (!isRecord(item) || typeof item.line !== 'string') return [];
    if (!Number.isFinite(item.inSeconds)) return [];
    return [
      {
        line: item.line,
        type: item.type as LineType,
        headsign: typeof item.headsign === 'string' ? item.headsign : null,
        departure: typeof item.departure === 'string' ? item.departure : '',
        inSeconds: item.inSeconds as number,
        tripId: typeof item.tripId === 'string' ? item.tripId : '',
        serviceDay:
          item.serviceDay === 'yesterday'
            ? 'yesterday'
            : item.serviceDay === 'tomorrow'
              ? 'tomorrow'
              : 'today',
        operator: optionalString(item.operator),
        platformCode: optionalString(item.platformCode),
        realtime: item.realtime === true,
        predictedInSeconds:
          item.realtime === true && Number.isFinite(item.predictedInSeconds)
            ? (item.predictedInSeconds as number)
            : null,
        vehicleId:
          typeof item.vehicleId === 'string' && item.vehicleId
            ? item.vehicleId
            : null,
      },
    ];
  });
  const stop = payload.stop as unknown as Stop;
  const rawLines = (payload.stop as Record<string, unknown>).lines;
  if (Array.isArray(rawLines)) {
    stop.lines = rawLines.filter((line: unknown): line is string => typeof line === 'string');
  }
  return {
    stop,
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
    // Open Data serves the side number as a number and Kłosok as a slice of
    // its vehicle label, so both shapes arrive here and both read as text.
    vehicleNumber:
      typeof record.vehicleNumber === 'string' && record.vehicleNumber
        ? record.vehicleNumber
        : Number.isFinite(record.vehicleNumber)
          ? String(record.vehicleNumber)
          : undefined,
    fleet: normaliseFleet(record.fleet),
  };
}

/** `/vehicle/:id` — the MPK/Kłosok detail payload: `{vehicle, trip: VehicleTripDetail}`. */
export function normaliseVehicleDetail(payload: unknown): VehicleDetail {
  if (!isRecord(payload) || !isRecord(payload.vehicle)) {
    throw new ApiError('Unexpected /vehicle payload', 0);
  }
  const vehicle = normaliseVehicle(payload.vehicle);
  const rawTrip = payload.trip;
  if (!isRecord(rawTrip)) return { vehicle, trip: null };

  if (!Array.isArray(rawTrip.nextStops)) {
    throw new ApiError('Unexpected /vehicle trip payload', 0);
  }

  return { vehicle, trip: rawTrip as unknown as VehicleTripDetail };
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

/** A one-shot fleet snapshot used by the vehicle search. */
export const getAllLocations = async (options?: GetOptions) => getLocations(null, options);

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
    await apiGet<unknown>(`/stop/${encodeURIComponent(stopId)}/departures?limit=12&within=1440`, options),
  );

/** Merge only GTFS records that search identified as one physical platform. */
export const getDeparturesForStops = async (stop: Stop, options?: GetOptions): Promise<Departures> => {
  const ids = [...new Set([stop.id, ...(stop.ids ?? [])])];
  const boards = await Promise.all(ids.map((id) => getDepartures(id, options)));
  const seen = new Set<string>();
  const departures = boards
    .flatMap((board) => board.departures)
    .filter((departure) => {
      const key = `${departure.tripId}|${departure.line}|${departure.departure}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.inSeconds - b.inSeconds)
    .slice(0, 12);
  return { stop: boards[0]?.stop ?? stop, departures };
};

/**
 * Stops around a point.
 *
 * Used both for "near me" and for the stops inside the map's viewport, which is
 * why the radius and the cap are callers' business: a locate button wants a
 * short walk's worth, a zoomed-in map wants everything it can see.
 */
export const getStopsNear = async (
  lat: number,
  lon: number,
  radius = 700,
  options?: GetOptions & { limit?: number },
) =>
  normaliseStopList(
    await apiGet<unknown>(
      `/stops/near?lat=${lat}&lon=${lon}&radius=${Math.round(radius)}&limit=${options?.limit ?? 40}`,
      options,
    ),
    '/stops/near',
  );

export const getAlerts = async (options?: GetOptions) =>
  normaliseAlerts(await apiGet<unknown>('/alerts', options));

export const getIncidents = async (
  options?: GetOptions & { line?: string; status?: string },
) => {
  const query = new URLSearchParams();
  if (options?.line) query.set('line', options.line);
  if (options?.status) query.set('status', options.status);
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return normaliseIncidents(await apiGet<unknown>(`/incidents${suffix}`, options));
};
