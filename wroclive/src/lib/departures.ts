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
