/**
 * Which incidents earn a notification. Kept free of runtime imports so
 * `server/test/app-pure-modules.test.js` can run it.
 *
 * The rules are the "a fake disruption is worse than a missing one" rule
 * applied to a lock screen:
 *
 * - Only an incident that started *after* the rider switched this on. The
 *   archive keeps days of history — a hundred notices at once was the first
 *   thing switching it on would otherwise do.
 * - Only active ones, and only once each: an incident is remembered when it is
 *   first seen, whether it was announced or not, so changing the line scope
 *   later does not replay old news.
 * - Nothing older than `MAX_AGE_MS`. iOS wakes the background task when it
 *   likes, sometimes hours late, and "tram stopped at Rondo" from this morning
 *   is noise by the evening.
 * - At most `MAX_SEPARATE` separate notifications per check; beyond that one
 *   summary says how many, so a bad afternoon is one buzz, not ten.
 */
export const INCIDENT_ALERT_MAX_AGE_MS = 3 * 60 * 60 * 1_000;
export const INCIDENT_ALERT_MAX_SEPARATE = 3;
/** How long a seen id is remembered — longer than any incident lasts. */
export const INCIDENT_SEEN_TTL_MS = 3 * 24 * 60 * 60 * 1_000;

/** Mirrors `IncidentAlertMode` in preferences.ts; restated so this file imports nothing. */
export type IncidentAlertMode = 'off' | 'mine' | 'all';

export type IncidentForAlert = {
  id: string;
  status: string;
  affected: string[];
  firstSeenAt: number;
};

export type IncidentAlertPlan<T extends IncidentForAlert> = {
  /** Announce each of these on its own. */
  separate: T[];
  /** Announce this many more in one summary; 0 for none. */
  summarised: number;
  /** The seen-set to store, pruned. */
  seen: Record<string, number>;
};

export function planIncidentAlerts<T extends IncidentForAlert>(
  incidents: readonly T[],
  state: { mode: IncidentAlertMode; enabledAt: number | null; seen: Record<string, number> },
  lines: readonly string[],
  now: number,
): IncidentAlertPlan<T> {
  const seen: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.seen)) {
    if (Number.isFinite(at) && now - at < INCIDENT_SEEN_TTL_MS) seen[id] = at;
  }
  if (state.mode === 'off' || state.enabledAt === null) {
    return { separate: [], summarised: 0, seen };
  }

  const wanted = new Set(lines);
  const fresh: T[] = [];
  for (const incident of incidents) {
    if (incident.status !== 'active' || !incident.id) continue;
    const known = incident.id in seen;
    seen[incident.id] = known ? seen[incident.id] : now;
    if (known) continue;
    if (!Number.isFinite(incident.firstSeenAt)) continue;
    if (incident.firstSeenAt < state.enabledAt) continue;
    if (now - incident.firstSeenAt > INCIDENT_ALERT_MAX_AGE_MS) continue;
    if (state.mode === 'mine' && !incident.affected.some((line) => wanted.has(line))) continue;
    fresh.push(incident);
  }

  // Newest first: if anything is folded into the summary, it is the older news.
  fresh.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  if (fresh.length <= INCIDENT_ALERT_MAX_SEPARATE) {
    return { separate: fresh, summarised: 0, seen };
  }
  return {
    separate: fresh.slice(0, INCIDENT_ALERT_MAX_SEPARATE - 1),
    summarised: fresh.length - (INCIDENT_ALERT_MAX_SEPARATE - 1),
    seen,
  };
}
