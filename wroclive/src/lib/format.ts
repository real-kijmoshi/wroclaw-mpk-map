/** Polish copy for the numbers the server serves. Sentence case, no filler. */

/** A countdown, split so the number can carry the amber and the unit not. */
export function etaParts(seconds: number | null | undefined): { value: string; unit: string } {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return { value: '—', unit: '' };
  }
  if (seconds < 30) return { value: 'teraz', unit: '' };
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return { value: String(minutes), unit: 'min' };
  return { value: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`, unit: 'h' };
}

/**
 * How far off the timetable a vehicle is.
 *
 * `null` means the server could not identify which departure the vehicle is
 * running — it says so rather than guessing, so neither do we.
 */
export function formatDelay(seconds: number | null | undefined): {
  text: string;
  tone: 'late' | 'early' | 'onTime' | 'unknown';
} {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return { text: 'Brak rozkładu', tone: 'unknown' };
  }
  const minutes = Math.round(seconds / 60);
  if (minutes >= 2) return { text: `${minutes} min spóźnienia`, tone: 'late' };
  if (minutes <= -2) return { text: `${Math.abs(minutes)} min przed czasem`, tone: 'early' };
  return { text: 'Punktualnie', tone: 'onTime' };
}

/** "23:11:00" from the timetable → "23:11" for a person. */
export const formatScheduled = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  // GTFS runs past 24:00 for trips that began yesterday; wrap it for display.
  const hour = Number.parseInt(match[1], 10) % 24;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
};

/**
 * Polish has three plural forms, and picking the wrong one is the kind of
 * thing a native speaker reads as broken software: 1 "pojazd", 2–4 "pojazdy",
 * 5+ "pojazdów" — except in the teens, which take the last form.
 */
export function plural(count: number, [one, few, many]: [string, string, string]): string {
  if (count === 1) return one;
  const tens = count % 100;
  const units = count % 10;
  if (units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14)) return few;
  return many;
}

/**
 * How far away a nearby stop is.
 *
 * Metres up to a kilometre — the resolution someone deciding whether to walk
 * actually wants — and rounded to 10m, because the position this is measured
 * from is a phone fix and not worth more precision than that.
 */
export function formatDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Relative age of an alert or a fleet snapshot. */
export function formatAge(timestamp: number | string | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return '';
  const value = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!Number.isFinite(value)) return '';

  const seconds = Math.round((Date.now() - value) / 1000);
  if (seconds < 60) return 'przed chwilą';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min temu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} godz. temu`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'wczoraj' : `${days} dni temu`;
}
