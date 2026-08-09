import type { Alert } from './api';

/**
 * Partition alerts so disruptions on the user's selected lines surface first.
 *
 * Returns a list of sections to render. Each section has an optional heading
 * (null when there's a single section) and its alerts in newest-first order.
 *
 * - No lines selected → one section, all alerts, no heading (unchanged UI).
 * - Lines selected but no alert touches them → one section, all alerts, no heading.
 * - Some relevant → "Twoje linie" then "Pozostałe".
 * - All relevant → one section headed "Twoje linie".
 */
export function orderAlertsForSelectedLines(
  alerts: Alert[],
  selectedLines: readonly string[],
): { heading: string | null; alerts: Alert[] }[] {
  if (!selectedLines.length) {
    return [{ heading: null, alerts }];
  }

  const selected = new Set(selectedLines.map((line) => line.toUpperCase()));
  const relevant: Alert[] = [];
  const other: Alert[] = [];

  for (const alert of alerts) {
    const isRelevant = alert.affected.some((line) => selected.has(line.toUpperCase()));
    (isRelevant ? relevant : other).push(alert);
  }

  if (!relevant.length) {
    // No alert touches the selected lines — render exactly as today.
    return [{ heading: null, alerts }];
  }

  if (!other.length) {
    return [{ heading: 'Twoje linie', alerts: relevant }];
  }

  return [
    { heading: 'Twoje linie', alerts: relevant },
    { heading: 'Pozostałe', alerts: other },
  ];
}
