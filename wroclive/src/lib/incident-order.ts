import type { Incident } from './api';

export type IncidentSection = {
  heading: string | null;
  incidents: Incident[];
};

const newestFirst = (left: Incident, right: Incident) =>
  right.lastUpdatedAt - left.lastUpdatedAt;

const SEVERITY_RANK: Record<Incident['severity'], number> = {
  major: 3,
  moderate: 2,
  minor: 1,
  unknown: 0,
};

/**
 * Major outranks recency: a two-line detour reported a minute ago must not
 * bury a four-line "brak przejazdu" reported ten minutes ago. Severity is
 * only meaningful while an incident is still open — once resolved it is
 * history, so the resolved section stays plain newest-first.
 */
const bySeverityThenNewest = (left: Incident, right: Incident) =>
  SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] || newestFirst(left, right);

/**
 * Confirmed active service impact outranks history. Stale reports whose
 * current state is unknown stay after resolved reports, never among active
 * disruptions.
 */
export function orderIncidentsForSelectedLines(
  incidents: Incident[],
  selectedLines: readonly string[],
): IncidentSection[] {
  const active = incidents.filter((incident) => incident.status === 'active').sort(bySeverityThenNewest);
  const resolved = incidents.filter((incident) => incident.status === 'resolved').sort(newestFirst);
  const unknown = incidents.filter((incident) => incident.status === 'unknown').sort(newestFirst);
  const sections: IncidentSection[] = [];

  if (!selectedLines.length) {
    if (active.length) {
      sections.push({ heading: resolved.length || unknown.length ? 'Aktywne utrudnienia' : null, incidents: active });
    }
  } else {
    const selected = new Set(selectedLines.map((line) => line.toUpperCase()));
    const relevant = active.filter((incident) =>
      incident.affected.some((line) => selected.has(line.toUpperCase())));
    const other = active.filter((incident) => !relevant.includes(incident));

    if (relevant.length) sections.push({ heading: 'Twoje linie', incidents: relevant });
    if (other.length) {
      sections.push({
        heading: relevant.length ? 'Pozostałe aktywne' : (resolved.length || unknown.length ? 'Aktywne utrudnienia' : null),
        incidents: other,
      });
    }
  }

  if (resolved.length) {
    sections.push({ heading: 'Przywrócono ruch', incidents: resolved });
  }

  if (unknown.length) {
    sections.push({ heading: 'Stan niepotwierdzony', incidents: unknown });
  }

  return sections;
}
