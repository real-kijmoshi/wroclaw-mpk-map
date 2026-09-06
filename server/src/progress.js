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

/**
 * First index into a *sorted array of trip indices* whose trip starts at or
 * after `target`. `trips` must be sorted by `tripStart[tripIndex]`, which is
 * the invariant `#buildVariants` in store.js guarantees.
 */
const firstTripIndexAtLeast = (trips, tripStart, target) => {
  let low = 0;
  let high = trips.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tripStart[trips[mid]] < target) low = mid + 1;
    else high = mid;
  }
  return low;
};

const secondsOfDay = (date) => date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

/**
 * Whether a stops array is ordered by distance along the shape.
 *
 * The variant builder projects stops in sequence order with each search
 * starting at the previous stop's segment, which makes `alongMeters` monotonic
 * for the overwhelming majority of routes — but not always: a stop whose
 * nearest polyline point falls behind the previous stop's (seen on double
 * crossings, e.g. Wrocław's "most Milenijny" pair) breaks it. The binary
 * searches below are exact only for a monotonic array, so the few non-monotonic
 * variants fall back to the original linear scans. Memoised per array: the
 * arrays are built once per GTFS refresh and stable for the store's lifetime.
 */
const monotonicCache = new WeakMap();
const isMonotonic = (stops) => {
  let result = monotonicCache.get(stops);
  if (result === undefined) {
    result = true;
    for (let i = 1; i < stops.length; i += 1) {
      if (stops[i].alongMeters < stops[i - 1].alongMeters) {
        result = false;
        break;
      }
    }
    monotonicCache.set(stops, result);
  }
  return result;
};

/**
 * The original linear interpolation over stop offsets.
 *
 * Kept as the exact fallback for the non-monotonic stop arrays `isMonotonic`
 * rejects: there, "the first segment containing the point" has no single
 * binary-searchable position, and the pre-optimization scan is the only answer
 * that matches the old behavior byte for byte.
 */
const offsetAtScan = (stops, alongMeters) => {
  const last = stops[stops.length - 1];
  if (alongMeters <= stops[0].alongMeters) {
    return { offset: stops[0].arrivalOffset, segmentIndex: 0, sorted: false };
  }
  if (alongMeters >= last.alongMeters) {
    return { offset: last.arrivalOffset, segmentIndex: -1, sorted: false };
  }

  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i];
    const to = stops[i + 1];
    if (alongMeters < from.alongMeters || alongMeters > to.alongMeters) continue;

    const span = to.alongMeters - from.alongMeters;
    const fraction = span > 0 ? (alongMeters - from.alongMeters) / span : 0;
    return {
      offset: from.departureOffset + fraction * (to.arrivalOffset - from.departureOffset),
      segmentIndex: i,
      sorted: false,
    };
  }

  return { offset: last.arrivalOffset, segmentIndex: -1, sorted: false };
};

/**
 * How many seconds into its run a vehicle is, given how far along the shape it
 * has travelled. Interpolates between the two stops it sits between, from the
 * departure of the one behind to the arrival of the one ahead, so a scheduled
 * wait at a stop is not spread over the road either side of it.
 *
 * Returns the offset together with the index of the segment's first stop, so
 * the caller can say which stop comes next without walking the list again.
 * The segment index is the one the linear walk would have stopped at: 0 when
 * the vehicle is at or before the first stop, the `from` stop of the
 * interpolated segment in between, and -1 at or beyond the last stop.
 *
 * Stops are ordered along the shape by construction (store.js projects each
 * one from where the previous landed), so the segment is found by a binary
 * search over alongMeters. A stop list that turns out not to be non-decreasing
 * falls back to the linear walk rather than trusting the search — a wrong
 * offset here is a wrong delay with no error anywhere. The `sorted` flag tells
 * the caller whether the segment index is trustworthy, so it can use the old
 * findIndex walk where the list is not sorted.
 */
const offsetAt = (stops, alongMeters) => {
  const sorted = isMonotonic(stops);
  const last = stops[stops.length - 1];

  if (alongMeters <= stops[0].alongMeters) {
    return { offset: stops[0].arrivalOffset, segmentIndex: 0, sorted };
  }
  if (alongMeters >= last.alongMeters) {
    return { offset: last.arrivalOffset, segmentIndex: -1, sorted };
  }

  // `from` is the first stop whose segment contains `alongMeters` — exactly
  // the segment the linear loop returned on a monotonic array (a position
  // exactly on a stop boundary resolves with fraction 1 to the boundary stop's
  // *arrival* offset, not its departure). Non-monotonic stops keep the scan.
  if (!sorted) return offsetAtScan(stops, alongMeters);

  let low = 0;
  let high = stops.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (stops[mid].alongMeters < alongMeters) low = mid + 1;
    else high = mid;
  }
  const from = stops[low - 1];
  const to = stops[low];
  const span = to.alongMeters - from.alongMeters;
  const fraction = span > 0 ? (alongMeters - from.alongMeters) / span : 0;
  return {
    offset: from.departureOffset + fraction * (to.arrivalOffset - from.departureOffset),
    segmentIndex: low - 1,
    sorted,
  };
};

/**
 * The first stop still ahead of a vehicle, derived from the segment offsetAt()
 * located instead of a fresh walk over the stop list.
 *
 * This reproduces `stops.findIndex((stop) => stop.alongMeters > alongMeters)`
 * exactly: every stop at or before the vehicle's position is passed, the first
 * with a larger one is next, and there is none when the vehicle is at or
 * beyond the last stop. The segment index is where the walk starts, so the
 * common case costs one comparison and only an exact boundary (a stop, or a
 * run of stops at the same distance) is walked past.
 */
const nextStopIndex = (stops, segmentIndex, alongMeters) => {
  if (segmentIndex < 0) return -1;

  let index = segmentIndex;
  while (index < stops.length && stops[index].alongMeters <= alongMeters) index += 1;
  return index >= stops.length ? -1 : index;
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
 *
 * The trips of a variant are sorted by `tripStart` (store.js `#buildVariants`),
 * so the old scan over every trip in both frames — O(trips) per vehicle per
 * frame — is replaced with a binary search. The delay window caps the answer
 * to `±MAX_DELAY_SECONDS` around the target start, so only the small band of
 * departures inside it is examined at all. The band is walked in the same
 * ascending order the scan used, and the same strict `|delay| < |best|`
 * comparison keeps the winner identical: a nearer departure with a service
 * that is not running today is skipped, and a slightly farther one with an
 * active service wins, exactly as before.
 */
const matchTrip = (gtfs, variant, progressOffset, now) => {
  const local = inWarsaw(now);
  const yesterday = new Date(local);
  yesterday.setDate(yesterday.getDate() - 1);

  const frames = [
    { seconds: secondsOfDay(local), date: local, label: 'today' },
    { seconds: secondsOfDay(local) + DAY_SECONDS, date: yesterday, label: 'yesterday' },
  ];

  const trips = variant.trips;
  const tripStart = gtfs.tripStart;

  let best = null;
  for (const frame of frames) {
    const targetStart = frame.seconds - progressOffset;

    const from = firstTripIndexAtLeast(trips, tripStart, targetStart - MAX_DELAY_SECONDS);
    for (let i = from; i < trips.length; i += 1) {
      const start = tripStart[trips[i]];
      if (start < 0) continue;
      if (start - targetStart > MAX_DELAY_SECONDS) break;

      const delaySeconds = targetStart - start;
      if (best && Math.abs(delaySeconds) >= Math.abs(best.delaySeconds)) continue;

      const trip = gtfs.trips[trips[i]];
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
    // From the matched run's `wheelchair_accessible`, and only from it. The
    // variant's other trips are other departures — possibly other vehicles —
    // so borrowing their accessibility is the same mistake as borrowing their
    // times (see the run-matching note above). Unmatched stays null.
    wheelchairAccessible: null,
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

  const progress = offsetAt(stops, projection.along);
  const progressOffset = progress.offset;
  const run = matchTrip(gtfs, variant, progressOffset, now);

  if (run) {
    described.tripId = run.trip.id;
    described.serviceDay = run.serviceDay;
    described.delaySeconds = run.delaySeconds;
    described.scheduleMatched = true;
    described.wheelchairAccessible = run.trip.wheelchairAccessible ?? null;
    if (run.trip.headsign) described.headsign = run.trip.headsign;
  }

  // For a stop list in shape order the segment located by offsetAt() finds the
  // next stop in one step; an unsorted list (offsetAt fell back to the scan)
  // keeps the old findIndex walk, which is the only derivation that stays
  // correct without ordering.
  const nextIndex = progress.sorted
    ? nextStopIndex(stops, progress.segmentIndex, projection.along)
    : stops.findIndex((stop) => stop.alongMeters > projection.along);
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
  matchTrip,
  nextStopIndex,
  offsetAt,
  summarise,
};
