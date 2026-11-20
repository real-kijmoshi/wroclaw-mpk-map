/**
 * A hub: every stop a rider would call by one name, however the feed splits it.
 *
 * The feed names some interchanges per platform — "GALERIA DOMINIKAŃSKA 01"
 * through "… 11", eleven rows in search — and splits others into same-named
 * groups further apart than `groupStopAreas()` calls one place: Plac
 * Grunwaldzki is two "PL. GRUNWALDZKI" groups 220 m apart. Each of those is
 * right to keep (they face different ways, and choosing the side is how a
 * rider gets the right direction), so a hub is offered *in addition* — one
 * entry whose board and trips cover all of them, so a trip can be "Plac
 * Grunwaldzki → Galeria Dominikańska" rather than one platform to another.
 *
 * A hub is the same base name (a trailing platform number dropped) chained
 * within `HUB_LINK_METERS` of another member, so the two Rynek areas on
 * opposite sides of the square are one hub and a "Rynek" in another town is
 * not.
 *
 * Import-free on purpose: `server/test/app-pure-modules.test.js` runs it.
 */

export const HUB_LINK_METERS = 250;

type HubInput = { id: string; ids?: string[]; name: string; lat: number; lon: number; lines?: string[] };

export type StopHub = {
  /** The first member's id: what a map marker and a board are keyed on. */
  id: string;
  /** Every platform id of every member. */
  ids: string[];
  /** The base name: "GALERIA DOMINIKAŃSKA". */
  name: string;
  lat: number;
  lon: number;
  /** How many differently placed or numbered stops it joins. */
  stops: number;
  lines: string[];
};

/** "GALERIA DOMINIKAŃSKA 07" → "GALERIA DOMINIKAŃSKA". */
export function hubName(name: string): string {
  const base = name.replace(/\s+\d{1,2}$/, '').trim();
  return base || name.trim();
}

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Clusters of input stops, in input order of their first member. */
function cluster<S extends HubInput>(stops: S[]): S[][] {
  const groups: { key: string; members: S[] }[] = [];
  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    const key = hubName(stop.name).toLocaleLowerCase('pl');
    const joined = groups.filter(
      (group) => group.key === key && group.members.some((member) => metresBetween(member, stop) <= HUB_LINK_METERS),
    );
    if (joined.length === 0) {
      groups.push({ key, members: [stop] });
      continue;
    }
    // A stop between two groups links them.
    const [into, ...rest] = joined;
    into.members.push(stop);
    for (const other of rest) {
      into.members.push(...other.members);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups.map((group) => group.members);
}

function toHub(members: HubInput[]): StopHub {
  const ids = [...new Set(members.flatMap((stop) => [stop.id, ...(stop.ids ?? [])]))];
  const lines = [...new Set(members.flatMap((stop) => stop.lines ?? []))];
  const distinct = new Set(members.map((stop) => `${stop.name}|${stop.lat.toFixed(4)}|${stop.lon.toFixed(4)}`));
  return {
    id: members[0].id,
    ids,
    name: hubName(members[0].name),
    lat: members.reduce((sum, stop) => sum + stop.lat, 0) / members.length,
    lon: members.reduce((sum, stop) => sum + stop.lon, 0) / members.length,
    stops: distinct.size,
    lines,
  };
}

/**
 * The hubs among search results worth offering on top of them: those that
 * join more than `minimumStops` separately listed stops (a list grouped by
 * `groupStopAreas()` already shows a one-place stop as one row).
 */
export function findHubs(stops: HubInput[], listed: (members: HubInput[]) => number = (m) => m.length): StopHub[] {
  return cluster(stops)
    .filter((members) => listed(members) > 1)
    .map(toHub);
}

/**
 * The map's stops with each hub drawn once (`preferences.stopGrouping`).
 * A stop alone keeps its own record; a hub is one marker carrying every
 * platform's id, so tapping it opens the whole interchange's board.
 */
export function collapseToHubs<S extends HubInput>(stops: S[]): (S | (StopHub & { name: string }))[] {
  return cluster(stops).map((members) => (members.length === 1 ? members[0] : toHub(members)));
}
