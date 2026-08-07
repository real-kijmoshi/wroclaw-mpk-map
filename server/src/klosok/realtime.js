'use strict';

const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const config = require('../config');

/**
 * GTFS-RT processing for PT KŁOSOK's live bus positions.
 *
 * Kłosok is a subcontractor running suburban bus lines (911, 921, 931, …) in
 * Wrocław and the surrounding gminy. Unlike KD it publishes no timetable of
 * its own — its one public protobuf feed carries only VehiclePosition and
 * TripUpdate entities, and the matching to routes/trips/shapes happens
 * against the Wrocław GTFS in `GtfsStore` (see `resolveEnrichment`). The
 * feed is decoded with the official gtfs-realtime-bindings, so the schema
 * cannot drift from what this parses.
 *
 * Positions that cannot be trusted are dropped, never guessed at: a missing
 * or absurd coordinate, a 0,0, a missing timestamp, or one older than
 * KLOSOK_MAX_AGE_MS (or in the future) means the vehicle is not published
 * right now. `position.speed` is NOT trusted — raw samples from this feed
 * read in the tens of thousands, which is nonsense m/s — so it is never
 * emitted and never used in logic; it is only counted for diagnostics.
 */

/**
 * A Kłosok bus does not sit inside the MPK bounding box — the network covers
 * Długołęka and the other gminy north and east of Wrocław. This is a sanity
 * box, not a filter: it only exists to throw out 0,0 and parse failures.
 */
const BOUNDS = { minLat: 50.8, maxLat: 51.5, minLon: 16.4, maxLon: 17.8 };

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const toSeconds = (value) => {
  // Protobuf timestamps are int64, which decode into a Long object.
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Normalise a bearing into 0..360, null when absent or garbage. */
const normaliseBearing = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
};

/**
 * Decode a GTFS-RT buffer into normalised vehicles and trip updates.
 *
 * @param {Buffer} buffer raw protobuf
 * @param {{ now?: Date }} options
 * @returns {{ vehicles: object[], tripUpdates: Map<string, object>, headerTimestamp: number|null, stale: boolean, stats: object }}
 */
const parseRealtime = (buffer, { now = new Date() } = {}) => {
  const feed = rt.FeedMessage.decode(buffer);

  const headerTimestamp = toSeconds(feed.header?.timestamp);
  const nowMs = now.getTime();
  const maxAgeMs = config.klosok.maxAgeMs;
  const futureSkewMs = 10_000;

  /** @type {Map<string, object>} vehicle id -> normalised vehicle */
  const vehicles = new Map();
  /** @type {Map<string, object>} startDate|tripId -> trip update */
  const tripUpdates = new Map();
  const stats = {
    entities: feed.entity?.length ?? 0,
    vehiclePositions: 0,
    tripUpdatesCount: 0,
    freshPositions: 0,
    vehiclesWithSpeed: 0,
  };

  const processTripUpdate = (raw) => {
    if (!raw?.trip?.tripId) return;
    stats.tripUpdatesCount += 1;
    const tripId = raw.trip.tripId;
    const startDate = raw.trip.startDate ?? null;
    const key = startDate ? `${startDate}|${tripId}` : tripId;

    const delay = Object.hasOwn(raw, 'delay') ? toSeconds(raw.delay) : null;
    const stopTimeUpdates = (raw.stopTimeUpdate ?? []).map((update) => {
      const arrivalDelay = update.arrival && Object.hasOwn(update.arrival, 'delay')
        ? toSeconds(update.arrival.delay)
        : null;
      const departureDelay = update.departure && Object.hasOwn(update.departure, 'delay')
        ? toSeconds(update.departure.delay)
        : null;
      const arrivalTime = update.arrival && Object.hasOwn(update.arrival, 'time')
        ? toSeconds(update.arrival.time)
        : null;
      const departureTime = update.departure && Object.hasOwn(update.departure, 'time')
        ? toSeconds(update.departure.time)
        : null;
      return {
        stopId: update.stopId ?? null,
        stopSequence: update.stopSequence ?? null,
        arrivalDelay,
        departureDelay,
        arrivalTime,
        departureTime,
      };
    });

    tripUpdates.set(key, {
      tripId,
      startDate,
      routeId: raw.trip.routeId ?? null,
      scheduleRelationship: raw.trip.scheduleRelationship ?? null,
      delay,
      stopTimeUpdates,
      timestamp: Object.hasOwn(raw, 'timestamp') ? toSeconds(raw.timestamp) : null,
    });
  };

  const processVehicle = (entityId, raw) => {
    if (!raw) return;
    stats.vehiclePositions += 1;
    // Only a diagnostic count — raw speeds from this feed are nonsense values
    // in the tens of thousands and are never shown or used anywhere.
    if (Object.hasOwn(raw.position ?? {}, 'speed')) stats.vehiclesWithSpeed += 1;

    const position = raw.position;
    const lat = Number(position?.latitude);
    const lon = Number(position?.longitude);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return;
    if (lat === 0 && lon === 0) return;
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) return;

    // Kłosok positions carry their own timestamp; one that is missing, stale
    // or in the future is not a live vehicle.
    const timestamp = toSeconds(raw.timestamp);
    if (timestamp === null) return;
    const positionMs = timestamp * 1000;
    if (positionMs > nowMs + futureSkewMs) return;
    if (positionMs < nowMs - maxAgeMs) return;
    stats.freshPositions += 1;

    const trip = raw.trip;
    const vehicle = raw.vehicle;
    const tripId = trip?.tripId ?? null;
    const startDate = trip?.startDate ?? null;
    const rawVehicleId = vehicle?.id ?? null;

    // Stable across polls: the vehicle's own id when the feed publishes one,
    // else the entity id, which GTFS-RT guarantees is stable for the trip.
    const id = rawVehicleId ? `klosok:${rawVehicleId}` : `klosok:${entityId}`;

    vehicles.set(id, {
      id,
      operator: null, // filled from GTFS agency.txt by the service
      type: 'bus',
      line: null, // filled from GTFS routes by the service
      routeId: trip?.routeId ?? null,
      tripId,
      startDate,
      vehicleId: rawVehicleId,
      vehicleLabel: vehicle?.label ?? null,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      heading: normaliseBearing(position?.bearing),
      destination: null, // filled from GTFS trips by the service
      delaySeconds: tripDelay(raw, tripUpdates, tripId, startDate),
      currentStopSequence: raw.currentStopSequence ?? null,
      positionUpdatedAt: new Date(positionMs).toISOString(),
      source: 'klosok-gtfs-rt',
    });
  };

  // Two passes: trip updates first so vehicles can join them for delaySeconds.
  for (const entity of feed.entity ?? []) processTripUpdate(entity.tripUpdate);
  for (const entity of feed.entity ?? []) processVehicle(entity.id, entity.vehicle);

  const stale = headerTimestamp !== null && headerTimestamp * 1000 < nowMs - maxAgeMs;

  return {
    vehicles: [...vehicles.values()],
    tripUpdates,
    headerTimestamp,
    stale,
    stats,
  };
};

/**
 * How late a vehicle is, from the strongest signal the feed offers:
 * 1. the trip update's own delay, when sensible;
 * 2. the delay of the next stop time update, else the last, else the first;
 * 3. nothing — never a made-up value.
 */
const tripDelay = (vehicle, tripUpdates, tripId, startDate) => {
  const update = findTripUpdate(tripUpdates, tripId, startDate);
  if (!update) return null;
  if (update.delay !== null) return update.delay;

  const updates = update.stopTimeUpdates;
  if (!updates.length) return null;

  const currentSequence = vehicle.currentStopSequence ?? null;
  let best = null;
  for (const stop of updates) {
    if (currentSequence !== null && stop.stopSequence !== null && stop.stopSequence >= currentSequence) {
      best = stop;
      break;
    }
  }
  if (!best) {
    for (const stop of [...updates].reverse()) {
      if (stop.arrivalDelay !== null || stop.departureDelay !== null) {
        best = stop;
        break;
      }
    }
  }
  if (!best) best = updates[0];

  const delay = best.departureDelay ?? best.arrivalDelay;
  return delay === null || Number.isFinite(delay) ? delay : null;
};

/**
 * Look up a trip update by startDate+tripId, falling back to tripId alone
 * when the feed omits start dates (never by routeId, which would join a
 * vehicle to a whole day's runs).
 */
const findTripUpdate = (tripUpdates, tripId, startDate) => {
  if (tripId === null) return null;
  if (startDate) {
    const exact = tripUpdates.get(`${startDate}|${tripId}`);
    if (exact) return exact;
  }
  return tripUpdates.get(tripId);
};

/** The same instant, read as a wall clock in Wrocław. */
const inWarsaw = (date) => new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));

const secondsOfDay = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

/**
 * Which of the trips a vehicle/bridge identifier points at is running right
 * now. A brigade runs a sequence of trips through the day, so the identifier
 * alone names too many; "active" narrows it to the trip whose schedule window
 * contains this moment. Exactly one such trip is a confident match; two or
 * more (or none, e.g. a bus between runs) means the run cannot be told apart
 * from a guess, and the answer is no trip.
 */
const pickActiveTrip = (gtfs, indices, now) => {
  const local = inWarsaw(now);
  const yesterday = new Date(local);
  yesterday.setDate(yesterday.getDate() - 1);
  // A night service is a past-midnight trip on the previous service day, so
  // a run that started yesterday is still "running now" at 00:20 today.
  const frames = [
    { seconds: secondsOfDay(local), date: local },
    { seconds: secondsOfDay(local) + 86_400, date: yesterday },
  ];

  let best = null;
  for (const index of indices) {
    const trip = gtfs.trips[index];
    const start = gtfs.tripStart[index];
    const end = gtfs.tripEnd[index];
    if (start < 0) continue;
    for (const frame of frames) {
      if (!gtfs.isServiceActive(trip.serviceId, frame.date)) continue;
      if (frame.seconds < start || frame.seconds > end) continue;
      if (best !== null) return null; // two trips running now — don't guess
      best = index;
    }
  }
  return best ?? null;
};

/**
 * Decode a Kłosok vehicle label into its parts.
 *
 * The live labels carry more than a number: `9003/91112/KMINKOWA` is vehicle
 * 9003, line 911 with brigade 12, heading to KMINKOWA, and a vehicle between
 * runs publishes `9047/12144` — line 121, brigade 44, no destination yet. The
 * second segment is usually `line`+`brigade` run together (both three and two
 * digits, brigade zero-padded), but some runs print just the brigade (`911/12`),
 * so a segment that names a known brigade on its own wins.
 *
 * @param {string|null} label
 * @param {{ hasLine: (line: string) => boolean, hasBrigade: (brigade: string) => boolean }} gtfs
 * @returns {{ vehicleNumber: string|null, line: string|null, brigade: string|null, destination: string|null }}
 */
const parseLabel = (label, gtfs) => {
  if (!label) return { vehicleNumber: null, line: null, brigade: null, destination: null };

  const [vehicleNumber, middle, destination] = label.split('/');
  if (!middle) return { vehicleNumber: vehicleNumber || null, line: null, brigade: null, destination: destination || null };

  // A plain brigade: the timetable says a brigade 12 exists, so `911/12` is
  // vehicle 911, brigade 12 — not line 911 with an empty brigade.
  if (gtfs.hasBrigade(middle)) {
    return { vehicleNumber: vehicleNumber || null, line: null, brigade: middle, destination: destination || null };
  }

  // `line`+`brigade` run together. Kłosok lines are all three digits, so the
  // split is fixed; the line is re-verified against the timetable so a label
  // in some other format cannot be misread as a line.
  const line = middle.slice(0, 3);
  const brigade = middle.slice(3);
  if (brigade && gtfs.hasLine(line) && gtfs.hasBrigade(brigade)) {
    return { vehicleNumber: vehicleNumber || null, line, brigade, destination: destination || null };
  }

  return { vehicleNumber: vehicleNumber || null, line: null, brigade: null, destination: destination || null };
};

/**
 * Attach the Wrocław timetable to a Kłosok vehicle. The strongest signal wins,
 * and a signal that would have to be a guess resolves to nothing:
 *
 *   1. tripId → trips.txt → route/headsign/shape/brigade/vehicle →
 *      routes.txt → line/agency;
 *   2. the vehicle's own id against `trips.vehicle_id`;
 *   3. the brigade in the label (`911/12` or `91112`) against
 *      `trips.brigade_id`;
 *   4. failing a trip, the route id, verified against routes.txt, names at
 *      least the line and operator.
 *
 * Steps 2 and 3 need the run currently in service, and a genuinely ambiguous
 * identifier resolves to no trip rather than a guess. A vehicle on a known
 * line whose exact run cannot be named is still served (route-id match) — the
 * label's own destination stands in for the trip headsign.
 *
 * @param {import('../gtfs/store').GtfsStore} gtfs
 * @param {object} vehicle a vehicle from `parseRealtime`
 * @param {{ now?: Date }} options
 * @returns {object|null} `{ how, trip, line, headsign, destination, shapeId, tripId, brigade, vehicleId, agencyName }`
 */
const resolveEnrichment = (gtfs, vehicle, { now = new Date() } = {}) => {
  const tripId = vehicle.tripId ?? null;
  const routeId = vehicle.routeId ?? null;

  const describeTrip = (index) => {
    const trip = gtfs.trips[index];
    const route = trip?.routeId ? gtfs.routesById?.get(trip.routeId) : null;
    const agency = route?.agencyId ? gtfs.agencies?.get(route.agencyId) : null;
    return {
      trip,
      line: trip?.line ?? route?.line ?? null,
      headsign: trip?.headsign ?? null,
      destination: trip?.headsign ?? null,
      shapeId: trip?.shapeId ?? null,
      tripId: trip?.id ?? null,
      brigade: trip?.blockId ?? null,
      vehicleId: trip?.vehicleId ?? null,
      agencyName: agency?.name ?? null,
    };
  };

  if (tripId) {
    const index = gtfs.tripIndexById?.get(tripId);
    if (index !== undefined) return { how: 'tripId', ...describeTrip(index) };
  }

  const label = parseLabel(vehicle.vehicleLabel, {
    hasLine: (line) => gtfs.hasLine(line),
    hasBrigade: (brigade) => (gtfs.tripsByBrigade?.get(brigade)?.length ?? 0) > 0,
  });

  const route = routeId ? gtfs.routesById?.get(routeId) : null;
  const routeLine = route?.line ?? label.line ?? null;

  // A trip-level match must agree with the route id when the feed supplies
  // both — a brigade number is shared across the operator's fleet and must
  // not move a bus onto another line's run.
  const agreesWithRoute = (trip) => !routeId || !trip?.line || trip.line === routeLine;

  if (vehicle.vehicleId !== null && vehicle.vehicleId !== undefined) {
    const indices = gtfs.tripsByVehicleId?.get(String(vehicle.vehicleId)) ?? [];
    if (indices.length) {
      const index = pickActiveTrip(gtfs, indices, now);
      if (index !== null && index !== undefined && agreesWithRoute(gtfs.trips[index])) {
        return { how: 'vehicleId', ...describeTrip(index) };
      }
    }
  }

  if (label.brigade) {
    const indices = gtfs.tripsByBrigade?.get(String(label.brigade)) ?? [];
    if (indices.length) {
      const index = pickActiveTrip(gtfs, indices, now);
      if (index !== null && index !== undefined && agreesWithRoute(gtfs.trips[index])) {
        return { how: 'brigadeId', ...describeTrip(index) };
      }
    }
  }

  if (route) {
    const agency = route.agencyId ? gtfs.agencies?.get(route.agencyId) : null;
    return {
      how: 'routeId',
      trip: null,
      line: route.line,
      headsign: null,
      destination: label.destination ?? null,
      shapeId: null,
      tripId: null,
      brigade: null,
      vehicleId: null,
      agencyName: agency?.name ?? null,
    };
  }

  return null;
};

module.exports = {
  BOUNDS,
  findTripUpdate,
  parseLabel,
  parseRealtime,
  pickActiveTrip,
  resolveEnrichment,
  tripDelay,
};
