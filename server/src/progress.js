'use strict';

const { distanceMeters } = require('./gtfs/geo');
const { inWarsaw, secondsToTime } = require('./gtfs/parse');

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
 * @param {import('./gtfs/store').GtfsStore} gtfs
 * @param {{ line: string, lat: number, lon: number, heading?: number|null }} vehicle
 * @param {{ now?: Date, limit?: number, history?: number }} options
 *   `limit` caps the stops ahead, `history` the stops already passed.
 * @returns {object|null} null when the timetable cannot place the vehicle at all
 */
const describeVehicle = (gtfs, vehicle, { now = new Date(), limit = 8, history = 1 } = {}) => {
  if (!gtfs?.isReady || !vehicle) return null;

  const match = gtfs.matchVariant(vehicle.line, vehicle.lat, vehicle.lon, {
    heading: vehicle.heading,
  });
  if (!match) return null;

  const { variant, projection } = match;
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
