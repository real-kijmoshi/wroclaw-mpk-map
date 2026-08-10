import type { Incident } from './api';

export type IncidentSection = {
  heading: string | null;
  incidents: Incident[];
};

const newestFirst = (left: Incident, right: Incident) =>
  right.lastUpdatedAt - left.lastUpdatedAt;

/**
 * Active service impact always outranks history. Within active incidents the
 * rider's selected lines come first; resolved incidents form the final,
 * newest-first section regardless of line relevance.
 */
export function orderIncidentsForSelectedLines(
  incidents: Incident[],
  selectedLines: readonly string[],
): IncidentSection[] {
  const active = incidents.filter((incident) => incident.status !== 'resolved').sort(newestFirst);
  const resolved = incidents.filter((incident) => incident.status === 'resolved').sort(newestFirst);
  const sections: IncidentSection[] = [];

  if (!selectedLines.length) {
    if (active.length) {
      sections.push({ heading: resolved.length ? 'Aktywne utrudnienia' : null, incidents: active });
    }
  } else {
    const selected = new Set(selectedLines.map((line) => line.toUpperCase()));
    const relevant = active.filter((incident) =>
      incident.affected.some((line) => selected.has(line.toUpperCase())));
    const other = active.filter((incident) => !relevant.includes(incident));

    if (relevant.length) sections.push({ heading: 'Twoje linie', incidents: relevant });
    if (other.length) {
      sections.push({
        heading: relevant.length ? 'Pozostałe aktywne' : (resolved.length ? 'Aktywne utrudnienia' : null),
        incidents: other,
      });
    }
  }

  if (resolved.length) {
    sections.push({ heading: 'Przywrócono ruch', incidents: resolved });
  }

  return sections;
}
