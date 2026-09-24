import type { Departure, LineType } from '@/lib/api';
import { compareLines } from '@/lib/lines';

/**
 * Reading a departure board rather than just listing it.
 *
 * The same few questions come up wherever a board is shown — the sheet, the
 * platform chooser, the widget — and each used to answer them its own way.
 */

/** Seconds until it leaves: the live prediction when there is one, the timetable otherwise. */
export const departureSeconds = (departure: Departure) =>
  departure.realtime && departure.predictedInSeconds != null ? departure.predictedInSeconds : departure.inSeconds;

/**
 * Where vehicles from this platform go, busiest first.
 *
 * Two platforms of one stop share a name and face opposite ways, and "Tramwaje"
 * does not tell them apart — "→ Oporów, Leśnica" does. Counted over the board
 * the server sent, which is the next several departures, so the order is what
 * a rider will actually see leave.
 */
export function boardDirections(departures: Departure[], max = 2): string[] {
  const counts = new Map<string, number>();
  for (const departure of departures) {
    const headsign = departure.headsign?.trim();
    if (headsign) counts.set(headsign, (counts.get(headsign) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pl'))
    .slice(0, max)
    .map(([headsign]) => headsign);
}

/** "→ Oporów, Leśnica", or '' for a board with nothing on it. */
export function directionsLabel(departures: Departure[], max = 2): string {
  const directions = boardDirections(departures, max);
  return directions.length ? `→ ${directions.join(', ')}` : '';
}

export type RouteGroup = {
  key: string;
  line: string;
  type: LineType;
  headsign: string | null;
  departures: Departure[];
};

/**
 * The board by route: one row per line and direction, with its next few
 * departures side by side.
 *
 * A chronological board at an interchange is twelve rows of five different
 * lines, and the rider who wants the 10 reads all of them to find its second
 * departure. Grouped, it is one row. Routes are ordered by their next
 * departure, so the top row is still "what leaves first".
 */
export function groupByRoute(departures: Departure[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const departure of departures) {
    const key = `${departure.line}|${departure.headsign ?? ''}`;
    const group = groups.get(key);
    if (group) group.departures.push(departure);
    else {
      groups.set(key, {
        key,
        line: departure.line,
        type: departure.type,
        headsign: departure.headsign,
        departures: [departure],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      departureSeconds(a.departures[0]) - departureSeconds(b.departures[0]) || compareLines(a.line, b.line),
  );
}

/** The lines on a board, each once, in the order a badge row is read. */
export function boardLines(departures: Departure[]): Pick<Departure, 'line' | 'type'>[] {
  const lines = new Map<string, Pick<Departure, 'line' | 'type'>>();
  for (const departure of departures) {
    if (!lines.has(departure.line)) lines.set(departure.line, { line: departure.line, type: departure.type });
  }
  return [...lines.values()].sort((a, b) => compareLines(a.line, b.line));
}

/** The part of a map vehicle a departure is matched against. */
type RunningVehicle = { id: string; line: string; trip: { tripId?: string | null } | null; tripId?: string | null };

/**
 * The vehicle already driving this departure, when it is on the road.
 *
 * The server's own live match (`vehicleId`) comes first, but it only exists
 * once the vehicle's next stop *is* this one. Before that the vehicle is still
 * found by the run it was matched to — so a tram five stops out is one tap
 * away, not only the one pulling in. Tomorrow's departures never match: GTFS
 * reuses a trip id every day it runs, and today's vehicle on it is not
 * tomorrow's. The run is inferred (invariant 18), so the line must agree too.
 */
export function runningVehicle<V extends RunningVehicle>(departure: Departure, vehicles: readonly V[]): V | null {
  if (departure.vehicleId) {
    const live = vehicles.find((vehicle) => vehicle.id === departure.vehicleId);
    if (live) return live;
  }
  if (!departure.tripId || departure.serviceDay === 'tomorrow') return null;
  return (
    vehicles.find(
      (vehicle) =>
        vehicle.line === departure.line &&
        (vehicle.trip?.tripId === departure.tripId || vehicle.tripId === departure.tripId),
    ) ?? null
  );
}

/**
 * Seconds until a saved trip's departure reaches the destination, or null on
 * a board that was not asked for one.
 *
 * The timetable's arrival, moved by however late the vehicle is running at
 * the origin. A delay does not stay constant along a route, but it is the one
 * the rider can see, and "on time at Reja" from a tram already four minutes
 * late is the answer that makes someone late for school.
 */
export const arrivalSeconds = (departure: Departure) =>
  departure.arrivalInSeconds === undefined
    ? null
    : departure.arrivalInSeconds + (departureSeconds(departure) - departure.inSeconds);

/** "7:54" — a wall-clock time `seconds` from `now`, the way a rider says it. */
export function clockIn(seconds: number, now = Date.now()) {
  const date = new Date(now + seconds * 1_000);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}
