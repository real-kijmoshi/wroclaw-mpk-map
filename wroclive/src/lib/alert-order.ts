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
  const active = alerts.filter((alert) => !isResolvedAlert(alert));
  const resolved = alerts.filter(isResolvedAlert);

  if (!selectedLines.length) {
    return [{ heading: null, alerts: [...active, ...resolved] }];
  }

  const selected = new Set(selectedLines.map((line) => line.toUpperCase()));
  const relevant = active.filter((alert) =>
    alert.affected.some((line) => selected.has(line.toUpperCase())));
  const other = active.filter((alert) => !relevant.includes(alert));

  if (!relevant.length) {
    return [{ heading: null, alerts: [...other, ...resolved] }];
  }

  return [
    { heading: 'Twoje linie', alerts: relevant },
    ...(other.length ? [{ heading: 'Pozostałe aktywne', alerts: other }] : []),
    ...(resolved.length ? [{ heading: 'Przywrócono ruch', alerts: resolved }] : []),
  ];
}

export function isResolvedAlert(alert: Alert): boolean {
  return /ruch\s+(przywrócon|normalny)|wznowion|zakończon|odwołane utrudnien/.test(
    `${alert.title ?? ''} ${alert.content}`.toLocaleLowerCase('pl-PL'),
  );
}
