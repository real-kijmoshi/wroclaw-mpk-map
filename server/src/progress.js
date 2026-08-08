'use strict';

const { angleBetween, distanceMeters, projectToPolyline } = require('./gtfs/geo');
const { inWarsaw, secondsToTime } = require('./gtfs/parse');
const { HEADING_PENALTY_METERS } = require('./gtfs/store');

/**
 * Where a live vehicle is on its route, where it is going, and when it reaches
 * the stops in front of it.
 *
 * MPK's feed says only `{line, lat, lon}` — no trip id, no destination, no
 * delay. Everything below is inferred by putting that position back onto the
 * GTFS geometry:
 *
 *   1. the route variant, heading included, gives the direction and the
 *      ordered list of stops (`GtfsStore.matchVariant`);
 *   2. projecting the position onto that shape gives how far into the route
 *      the vehicle is, in metres;
 *   3. the timetable turns metres into seconds — every stop carries its
 *      distance along the shape and its offset from the start of the run, so
 *      the vehicle's own progress interpolates between them;
 *   4. the run itself is identified by asking which of today's departures on
 *      this shape would be exactly here right now. The gap is the delay.
 *
 * Times are therefore honest about what they are: an ETA is remaining
 * scheduled running time from the vehicle's real position, and the delay is
 * how far off the timetable it already is. Neither pretends to model traffic.
 */

const DAY_SECONDS = 86_400;

/**
 * Past this distance from the polyline the match is not trustworthy enough to
 * say which stop comes next — a diverted vehicle, a bad fix, or a line whose
 * shape is missing. The direction is still reported; the stop list is not.
 */
const MAX_OFF_ROUTE_METERS = 250;

/** A vehicle this close to a stop is described as being at it. */
const AT_STOP_METERS = 45;

/**
 * The widest schedule gap still read as "this run, running late".
 *
 * Beyond it the nearer explanation is that the vehicle is on a different
 * departure, and guessing produces the worst possible answer: a confident
 * "18 minut spóźnienia" that is really the next tram, on time.
 */
const MAX_DELAY_SECONDS = 45 * 60;

/**
 * How far around a vehicle's last known position, in route metres, the fast
 * path is willing to look before it hands back to the full matcher.
 *
 * The backward window only needs to cover GPS jitter pulling the nearest point
 * back along the segment it is on; the forward window has to cover how far a
 * vehicle can travel between two polls plus the same jitter. A tram doing
 * 60 km/h covers ~170 m in ten seconds, so 600 m ahead leaves a comfortable
 * margin, and a hit on either edge is rejected anyway (see `fastProjection`).
 */
const FAST_BACKWARD_METERS = 200;
const FAST_FORWARD_METERS = 600;

/** First index whose value is >= target in a strictly ascending array. */
const firstIndexAtLeast = (array, target) => {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (array[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** Last index whose value is <= target in a strictly ascending array, or -1. */
const lastIndexAtMost = (array, target) => {
  let low = 0;
  let high = array.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (array[mid] <= target) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
};

const secondsOfDay = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

/**
 * How many seconds into its run a vehicle is, given how far along the shape it
 * has travelled. Interpolates between the two stops it sits between, from the
 * departure of the one behind to the arrival of the one ahead, so a scheduled
 * wait at a stop is not spread over the road either side of it.
 */
const offsetAt = (stops, alongMeters) => {
  const last = stops[stops.length - 1];
  if (alongMeters <= stops[0].alongMeters) return stops[0].arrivalOffset;
  if (alongMeters >= last.alongMeters) return last.arrivalOffset;

  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i];
    const to = stops[i + 1];
    if (alongMeters < from.alongMeters || alongMeters > to.alongMeters) continue;

    const span = to.alongMeters - from.alongMeters;
    const fraction = span > 0 ? (alongMeters - from.alongMeters) / span : 0;
    return from.departureOffset + fraction * (to.arrivalOffset - from.departureOffset);
  }

  return last.arrivalOffset;
};

/**
 * Which departure of this shape the vehicle is running, and by how much it is
 * off its timetable. Positive seconds mean late.
 *
 * Every run of the shape shares one relative profile, so the question reduces
 * to: which start time, plus the vehicle's progress, lands closest to now?
 * Trips that began yesterday are considered too — a night service at 00:20 is
 * a 24:20 departure on the previous service day, and skipping that frame
 * leaves every night vehicle unmatched.
 */
const matchTrip = (gtfs, variant, progressOffset, now) => {
  const local = inWarsaw(now);
  const yesterday = new Date(local);
  yesterday.setDate(yesterday.getDate() - 1);

  const frames = [
    { seconds: secondsOfDay(local), date: local, label: 'today' },
    { seconds: secondsOfDay(local) + DAY_SECONDS, date: yesterday, label: 'yesterday' },
  ];

  let best = null;
  for (const frame of frames) {
    for (const tripIndex of variant.trips) {
      const start = gtfs.tripStart[tripIndex];
      if (start < 0) continue;

      const delaySeconds = frame.seconds - (start + progressOffset);
      if (Math.abs(delaySeconds) > MAX_DELAY_SECONDS) continue;
      if (best && Math.abs(delaySeconds) >= Math.abs(best.delaySeconds)) continue;

      const trip = gtfs.trips[tripIndex];
      if (!gtfs.isServiceActive(trip.serviceId, frame.date)) continue;

      best = { trip, start, delaySeconds: Math.round(delaySeconds), serviceDay: frame.label };
    }
  }

  return best;
};

/**
 * Re-project a vehicle that was already on `variant` at `previousState`,
 * searching only the stretch of polyline around its previous position.
 *
 * A vehicle that keeps running the same route moves a bounded distance per
 * poll, so its next projection can only be near the last one — searching the
 * whole polyline (and the whole line's other variants) for that answer is the
 * cost this avoids. The answer is only trusted when it is clearly inside the
 * window, close to the polyline, and running the way the vehicle is heading;
 * anything ambiguous hands back `null` and the caller runs the full matcher,
 * so the fast path can never be *more* wrong than today, only cheaper.
 *
 * @param {object} variant the variant the vehicle was last seen on
 * @param {{ lat: number, lon: number, heading?: number|null }} vehicle
 * @param {{ shapeId: string, alongMeters: number }} previousState
 * @returns {object|null} a projection, or null when the fast answer is not
 *   trustworthy enough to stand in for a full match.
 */
const fastProjection = (variant, vehicle, previousState) => {
  const { points, cumulative } = variant;
  const count = points.length / 2;
  if (count < 2 || !cumulative) return null;

  const minAlong = Math.max(0, previousState.alongMeters - FAST_BACKWARD_METERS);
  const maxAlong = previousState.alongMeters + FAST_FORWARD_METERS;

  // The window as a range of segment indices, from the vertex that first
  // passes the start to the last whose distance is still inside the window.
  // A segment spanning the window edge is kept whole, so no part of it is
  // silently skipped, and one extra segment past the forward edge is searched
  // as a probe (see below).
  const lo = firstIndexAtLeast(cumulative, minAlong);
  const hi = lastIndexAtMost(cumulative, maxAlong);
  if (hi < 0) return null;

  const lastSegment = count - 2;
  const fromIndex = Math.max(0, lo - 1);
  const toIndex = Math.min(hi + 1, lastSegment);
  if (fromIndex > toIndex) return null;

  const projection = projectToPolyline(vehicle.lat, vehicle.lon, points, {
    cumulative,
    fromIndex,
    toIndex,
  });
  if (!projection) return null;

  // A projection that lands on the probe segment past the window means the
  // vehicle actually sits just beyond `maxAlong` — the windowed answer would
  // then creep forward one window behind the vehicle forever. Reject and let
  // the full matcher place it. Anything inside the window is trustworthy: the
  // probe makes sure no nearer segment hides on the other side of the edge.
  // (The backward edge needs no probe — between polls a vehicle can only
  // drift a few metres against its direction of travel.)
  if (toIndex > hi && projection.index === toIndex) return null;

  // The same heading penalty the full matcher applies, so a vehicle that has
  // turned around at a terminus is not locked onto the leg it just left.
  const off =
    Number.isFinite(vehicle.heading) && projection.bearing !== null
      ? angleBetween(vehicle.heading, projection.bearing)
      : 0;
  const score =
    projection.distance +
    (HEADING_PENALTY_METERS * (1 - Math.cos((off * Math.PI) / 180))) / 2;
  if (score > MAX_OFF_ROUTE_METERS) return null;

  return projection;
};

/**
 * @param {import('./gtfs/store').GtfsStore} gtfs
 * @param {{ line: string, lat: number, lon: number, heading?: number|null }} vehicle
 * @param {{ now?: Date, limit?: number, history?: number, previousState?: object|null }} options
 *   `limit` caps the stops ahead, `history` the stops already passed.
 *   `previousState` is the projection state captured on the last call for this
 *   vehicle (`described.state`): when present and still on the same variant it
 *   enables the fast path, which re-projects only around the previous position
 *   instead of re-matching the whole line.
 * @returns {object|null} null when the timetable cannot place the vehicle at all
 */
const describeVehicle = (
  gtfs,
  vehicle,
  { now = new Date(), limit = 8, history = 1, previousState = null } = {},
) => {
  if (!gtfs?.isReady || !vehicle) return null;

  let variant;
  let projection;
  if (previousState?.shapeId) {
    const candidate = gtfs.getVariantByShapeId(previousState.shapeId);
    if (candidate && candidate.line === vehicle.line) {
      projection = fastProjection(candidate, vehicle, previousState);
      if (projection) variant = candidate;
    }
  }

  if (!variant) {
    const match = gtfs.matchVariant(vehicle.line, vehicle.lat, vehicle.lon, {
      heading: vehicle.heading,
    });
    if (!match) return null;
    variant = match.variant;
    projection = match.projection;
  }
  const stops = variant.stops;
  const terminus = stops.length ? stops[stops.length - 1].name : null;

  const described = {
    line: variant.line,
    shapeId: variant.shapeId,
    directionId: variant.directionId,
    // What a rider reads on the blind, and the full "A → B" for context.
    headsign: variant.headsign,
    direction: variant.direction,
    towards: terminus ?? variant.headsign ?? null,
    origin: stops.length ? stops[0].name : null,
    fromRouteMeters: projection ? Math.round(projection.distance) : null,
    onRoute: Boolean(projection) && projection.distance <= MAX_OFF_ROUTE_METERS,
    progressMeters: projection ? Math.round(projection.along) : null,
    routeMeters: Math.round(variant.lengthMeters ?? 0),
    // Index into the shape the app already has, so it can draw the part still
    // to come differently from the part already travelled.
    shapeIndex: projection ? projection.index : null,
    tripId: null,
    serviceDay: null,
    delaySeconds: null,
    scheduleMatched: false,
    atStop: null,
    previousStops: [],
    previousStop: null,
    nextStop: null,
    nextStops: [],
    stopsAhead: 0,
    stopCount: stops.length,
  };

  // Where this vehicle was on this shape, for the next poll's fast path.
  // Non-enumerable on purpose: `res.json` and `summarise` must not put it on
  // the wire — it exists to seed `previousState` on the next call.
  if (projection && described.onRoute) {
    Object.defineProperty(described, 'state', {
      value: {
        shapeId: variant.shapeId,
        polylineIndex: projection.index,
        alongMeters: projection.along,
      },
      enumerable: false,
    });
  }

  // A snapshot with no times for this shape still knows where the vehicle is
  // headed; it just cannot say when it gets anywhere.
  const timed =
    stops.length > 1 && stops.every((stop) => stop.arrivalOffset !== null && stop.departureOffset !== null);
  if (!projection || !described.onRoute || !timed) return described;

  const progressOffset = offsetAt(stops, projection.along);
  const run = matchTrip(gtfs, variant, progressOffset, now);

  if (run) {
    described.tripId = run.trip.id;
    described.serviceDay = run.serviceDay;
    described.delaySeconds = run.delaySeconds;
    described.scheduleMatched = true;
    if (run.trip.headsign) described.headsign = run.trip.headsign;
  }

  const nextIndex = stops.findIndex((stop) => stop.alongMeters > projection.along);
  const upcoming = nextIndex === -1 ? [] : stops.slice(nextIndex, nextIndex + Math.max(limit, 0));
  const passedFrom = nextIndex === -1 ? stops.length : nextIndex;

  const toEntry = (stop, passed) => {
    const relative = stop.arrivalOffset - progressOffset;
    return {
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      sequence: stop.sequence,
      // The timetable for the run this vehicle is on, not for the sample trip
      // the variant was described from — that one is some other departure and
      // showing its times would be a plain lie.
      scheduled: run ? secondsToTime(run.start + stop.arrivalOffset) : null,
      // Remaining scheduled running time from where the vehicle actually is.
      etaSeconds: passed ? null : Math.max(0, Math.round(relative)),
      agoSeconds: passed ? Math.max(0, Math.round(-relative)) : null,
      distanceMeters: Math.round(Math.abs(stop.alongMeters - projection.along)),
      passed,
    };
  };

  described.previousStops = stops
    .slice(Math.max(0, passedFrom - Math.max(history, 0)), passedFrom)
    .map((stop) => toEntry(stop, true));
  described.previousStop = described.previousStops.at(-1) ?? null;
  described.nextStops = upcoming.map((stop) => toEntry(stop, false));
  described.nextStop = described.nextStops[0] ?? null;
  described.stopsAhead = stops.length - passedFrom;

  // "At Rynek" reads better than "40 m before Rynek", and it is also what the
  // rider standing there sees.
  const candidates = [described.previousStop, described.nextStop].filter(Boolean);
  for (const candidate of candidates) {
    const metres = distanceMeters(vehicle.lat, vehicle.lon, candidate.lat, candidate.lon);
    if (metres <= AT_STOP_METERS && (!described.atStop || metres < described.atStop.distanceMeters)) {
      described.atStop = { id: candidate.id, name: candidate.name, distanceMeters: Math.round(metres) };
    }
  }

  return described;
};

/** The few fields worth repeating for every vehicle in /locations. */
const summarise = (described) => {
  if (!described) return null;
  return {
    headsign: described.headsign,
    direction: described.direction,
    towards: described.towards,
    directionId: described.directionId,
    shapeId: described.shapeId,
    delaySeconds: described.delaySeconds,
    tripId: described.tripId,
    stopsAhead: described.stopsAhead,
    atStop: described.atStop ? described.atStop.name : null,
    previousStop: described.previousStop
      ? { id: described.previousStop.id, name: described.previousStop.name }
      : null,
    nextStop: described.nextStop
      ? {
          id: described.nextStop.id,
          name: described.nextStop.name,
          etaSeconds: described.nextStop.etaSeconds,
          scheduled: described.nextStop.scheduled,
        }
      : null,
  };
};

module.exports = {
  AT_STOP_METERS,
  MAX_DELAY_SECONDS,
  MAX_OFF_ROUTE_METERS,
  describeVehicle,
  offsetAt,
  summarise,
};
