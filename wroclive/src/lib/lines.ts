import type { LineType } from './api';

/**
 * Line colours, kept in step with `LINE_COLOR` in `server/views/map.html` —
 * the browser map is a second client of the same API and the two must not
 * drift apart.
 *
 * Every value clears 4.5:1 against the white text drawn on it. The palette
 * this replaced put white on `#F8E71C` at about 1.4:1, which is illegible in
 * the sunlight you are standing in at a stop. Check any new value before
 * adding it.
 */
export const LINE_COLOR: Record<LineType, string> = {
  tram: '#0B5FBF',
  tramSpecial: '#0E7490',
  tramTemporary: '#7C3AED',
  bus: '#B91C1C',
  busNight: '#3730A3',
  busSuburban: '#15803D',
  busTemporary: '#A16207',
  busZone: '#9D174D',
  busExpress: '#C2410C',
  busSpecial: '#334155',
  unknown: '#475569',
};

export const LINE_LABEL: Record<LineType, string> = {
  tram: 'Tramwaje',
  tramSpecial: 'Tramwaje specjalne',
  tramTemporary: 'Tramwaje tymczasowe',
  bus: 'Autobusy',
  busNight: 'Autobusy nocne',
  busSuburban: 'Autobusy podmiejskie',
  busTemporary: 'Autobusy tymczasowe',
  busZone: 'Autobusy strefowe',
  busExpress: 'Autobusy pospieszne',
  busSpecial: 'Autobusy specjalne',
  unknown: 'Pozostałe',
};

/**
 * The same categories, short enough to sit in a filter pill.
 *
 * `LINE_LABEL` runs to "Autobusy podmiejskie", which truncates mid-word in a
 * horizontal strip and reads as broken. The strip is already colour-coded and
 * the full name still heads the list below it, so the pill only has to be
 * unambiguous — which is why the rare tram/bus variants keep their vehicle
 * word and only abbreviate the qualifier.
 */
export const LINE_SHORT_LABEL: Record<LineType, string> = {
  tram: 'Tramwaje',
  tramSpecial: 'Tramwaje spec.',
  tramTemporary: 'Tramwaje tymcz.',
  bus: 'Autobusy',
  busNight: 'Nocne',
  busSuburban: 'Podmiejskie',
  busTemporary: 'Autobusy tymcz.',
  busZone: 'Strefowe',
  busExpress: 'Pospieszne',
  busSpecial: 'Autobusy spec.',
  unknown: 'Pozostałe',
};

/** `/lines` carries these two as convenience unions of the real categories. */
export const HIDDEN_CATEGORIES = new Set(['allTrams', 'allBuses']);

/** The order categories are listed in, most-used first. */
export const CATEGORY_ORDER: LineType[] = [
  'tram',
  'bus',
  'busNight',
  'busExpress',
  'busSuburban',
  'busZone',
  'tramSpecial',
  'tramTemporary',
  'busTemporary',
  'busSpecial',
  'unknown',
];

/** A hex colour, darkened towards black by `amount` of itself. */
const shade = (hex: string, amount: number): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  const step = (channel: number) =>
    Math.round(((value >> channel) & 255) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${step(16)}${step(8)}${step(0)}`;
};

/**
 * The classic marker's keyline: its own tint, a quarter of the way to black.
 *
 * The marker it comes from (commit a86981d) carried a pastel palette of its
 * own — `#7799CC` for trams and for every night bus, with the line number in
 * white on top at about 2.9:1. That is the contrast failure `LINE_COLOR`
 * exists to prevent, and a night map where 240 through 255 are all the same
 * washed-out blue is the legibility one. So the classic *shape* is what the
 * setting brings back; the colour is the palette everything else in the app
 * uses, and the border is derived from it so the two can never drift.
 */
export const CLASSIC_BORDER_COLOR: Record<LineType, string> = Object.fromEntries(
  Object.entries(LINE_COLOR).map(([type, color]) => [type, shade(color, 0.75)]),
) as Record<LineType, string>;

export const colorFor = (type: string | null | undefined): string =>
  LINE_COLOR[(type ?? 'unknown') as LineType] ?? LINE_COLOR.unknown;

export const classicBorderColorFor = (type: string | null | undefined): string =>
  CLASSIC_BORDER_COLOR[(type ?? 'unknown') as LineType] ?? CLASSIC_BORDER_COLOR.unknown;

export const labelFor = (type: string): string =>
  LINE_LABEL[type as LineType] ?? LINE_LABEL.unknown;

export const shortLabelFor = (type: string): string =>
  LINE_SHORT_LABEL[type as LineType] ?? LINE_SHORT_LABEL.unknown;

const TRAM_TYPES = new Set<string>(['tram', 'tramSpecial', 'tramTemporary']);

export const isTram = (type: string | null | undefined) => TRAM_TYPES.has(type ?? '');

/** Natural order: "4" before "10", letters after numbers. */
export const compareLines = (a: string, b: string) => {
  const aNum = /^\d+$/.test(a) ? Number.parseInt(a, 10) : null;
  const bNum = /^\d+$/.test(b) ? Number.parseInt(b, 10) : null;
  if (aNum !== null && bNum !== null) return aNum - bNum;
  if (aNum !== null) return -1;
  if (bNum !== null) return 1;
  return a.localeCompare(b, 'pl');
};
