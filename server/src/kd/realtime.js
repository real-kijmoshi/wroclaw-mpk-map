'use strict';

const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const config = require('../config');
const { OPERATOR } = require('./static');

/**
 * GTFS-RT processing for Koleje Dolnośląskie.
 *
 * The KD realtime feed is protobuf, decoded with gtfs-realtime-bindings
 * (the official bindings, so the schema cannot drift from what this parses).
 * Two entity kinds matter: VehiclePosition (where a train is) and TripUpdate
 * (how its departure times move). They arrive as separate entities and are
 * joined by trip — on startDate + tripId when the feed supplies both, since a
 * trip_id alone repeats once a day.
 *
 * Positions that cannot be trusted are dropped, never guessed at: a missing or
 * absurd coordinate, a 0,0, or a timestamp older than KD_GTFS_RT_MAX_AGE_MS (or
 * in the future) means the vehicle is not published right now. A vehicle with
 * no trip is still shown — it is real even if the timetable cannot name it.
 */

/**
 * A KD vehicle does not sit inside the Wrocław bounding box MPK vehicles use —
 * the network runs across Lower Silesia and into Dresden, Berlin and beyond.
 * This is a sanity box, not a filter: it only exists to throw out 0,0 and
 * parse failures.
 */
const BOUNDS = { minLat: 48.5, maxLat: 55.5, minLon: 11.0, maxLon: 21.5 };

const OCCUPANCY = rt.VehiclePosition.OccupancyStatus;
const OCCUPANCY_NAMES = Object.fromEntries(
  Object.entries(OCCUPANCY).map(([name, value]) => [String(value), name]),
);

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const toSeconds = (value) => {
  // Protobuf timestamps are int64, which decode into a Long object.
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Enum value -> stable string, or null for a value the spec does not define. */
const occupancyName = (value) => {
  if (value === undefined || value === null) return null;
  return OCCUPANCY_NAMES[value] ?? null;
};/** Normalise a bearing into 0..360, null when absent or garbage. */
const normaliseBearing = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
};

const toKmh = (metersPerSecond) => {
  const n = Number(metersPerSecond);
  return Number.isFinite(n) ? Math.round(n * 3.6) : null;
};

/**
 * Decode a GTFS-RT buffer into normalised vehicles and trip updates.
 *
 * @param {Buffer} buffer raw protobuf
 * @param {{ now?: Date }} options
 * @returns {{ vehicles: object[], tripUpdates: Map<string, object>, headerTimestamp: number|null, stale: boolean }}
 */
const parseRealtime = (buffer, { now = new Date() } = {}) => {
  const feed = rt.FeedMessage.decode(buffer);

  const headerTimestamp = toSeconds(feed.header?.timestamp);
  const nowMs = now.getTime();
  const maxAgeMs = config.kd.realtimeMaxAgeMs;
  const futureSkewMs = 10_000;

  /** @type {Map<string, object>} vehicle id -> normalised vehicle */
  const vehicles = new Map();
  /** @type {Map<string, object>} startDate|tripId -> trip update */
  const tripUpdates = new Map();

  const processVehicle = (entityId, raw) => {
    if (!raw) return;

    const position = raw.position;
    const lat = Number(position?.latitude);
    const lon = Number(position?.longitude);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return;
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) return;

    // Prefer the per-vehicle timestamp; fall back to the feed header (marked
    // on the record so callers know it is approximate).
    let timestamp = toSeconds(raw.timestamp);
    if (timestamp === null && headerTimestamp !== null) timestamp = headerTimestamp;
    if (timestamp === null) return;
    const positionMs = timestamp * 1000;
    if (positionMs > nowMs + futureSkewMs) return;
    if (positionMs < nowMs - maxAgeMs) return;

    const trip = raw.trip;
    const vehicle = raw.vehicle;
    const tripId = trip?.tripId ?? null;
    const startDate = trip?.startDate ?? null;

    const id =
      vehicle?.id ?? (tripId ? `trip:${tripId}` : `entity:${entityId}`);

    const delaySeconds = tripDelay(raw, tripUpdates, tripId, startDate);

    vehicles.set(id, {
      id: `kd:vehicle:${id}`,
      operator: OPERATOR,
      type: 'train',
      line: null, // filled from static routes by the service
      routeId: trip?.routeId ?? null,
      tripId,
      startDate,
      vehicleLabel: vehicle?.label ?? null,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      heading: normaliseBearing(position?.bearing),
      speed: toKmh(position?.speed),
      destination: null, // filled from static trips by the service
      delaySeconds,
      occupancyStatus: Object.hasOwn(raw, 'occupancyStatus') ? occupancyName(raw.occupancyStatus) : null,
      // protobuf leaves an absent field unset rather than defaulting it, so
      // Object.hasOwn is what tells "no occupancy" apart from "0%".
      occupancyPercentage: Object.hasOwn(raw, 'occupancyPercentage') ? raw.occupancyPercentage : null,
      positionUpdatedAt: new Date(positionMs).toISOString(),
      source: 'kd-gtfs-rt',
      rawTripId: tripId,
    });
  };

  const processTripUpdate = (raw) => {
    if (!raw?.trip?.tripId) return;
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

  // Two passes: trip updates first so vehicles can join them for delaySeconds.
  for (const entity of feed.entity ?? []) processTripUpdate(entity.tripUpdate);
  for (const entity of feed.entity ?? []) processVehicle(entity.id, entity.vehicle);

  const stale = headerTimestamp !== null && headerTimestamp * 1000 < nowMs - maxAgeMs;

  return {
    vehicles: [...vehicles.values()],
    tripUpdates,
    headerTimestamp,
    stale,
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

  // Prefer an update for the stop the vehicle is at or approaching.
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
 * vehicle to a whole day's trains).
 */
const findTripUpdate = (tripUpdates, tripId, startDate) => {
  if (tripId === null) return null;
  if (startDate) {
    const exact = tripUpdates.get(`${startDate}|${tripId}`);
    if (exact) return exact;
  }
  return tripUpdates.get(tripId);
};

module.exports = {
  BOUNDS,
  findTripUpdate,
  parseRealtime,
  tripDelay,
};
