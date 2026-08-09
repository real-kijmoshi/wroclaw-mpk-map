/**
 * Selectable accent themes for the app's UI.
 *
 * The light/dark *surface* scheme always follows the OS colour scheme; what the
 * rider picks here is the *accent*: links, the check on a selected radio, and
 * other small interactive highlights. The departure-countdown colour
 * (`theme.amber`) is reserved for countdowns alone and does not vary between
 * themes — see AGENTS.md invariant 10 ("amber is for countdowns"). Line
 * colours are fixed too (invariant 11), so a theme never touches route identity.
 *
 * Every light accent clears 4.5:1 against the white page and every dark accent
 * clears 4.5:1 against the darkest surface the app paints (`#2E3135`), so text
 * and icons stay legible whether they land on the page background, a card, or a
 * selected tab. The light accents are 600/800-level shades and the dark ones are
 * 300/400-level: dark enough on white, bright enough on black, without being so
 * pale that they wash out in sunlight (this is a map you read outside).
 */

export type ThemeName = 'default' | 'teal' | 'indigo' | 'rose';

export const DEFAULT_THEME: ThemeName = 'default';

export const THEMES: Record<
  ThemeName,
  {
    label: string;
    accent: { light: string; dark: string };
  }
> = {
  /** Wrocław default — blue for links and selected states. */
  default: { label: 'Domyślny', accent: { light: '#1d4ed8', dark: '#60a5fa' } },
  /** Cool green-blue. */
  teal: { label: 'Turkus', accent: { light: '#047857', dark: '#22c5bd' } },
  /** Soft violet. */
  indigo: { label: 'Indygo', accent: { light: '#4f46e5', dark: '#a097f3' } },
  /** Warm pink-red. */
  rose: { label: 'Róża', accent: { light: '#c21807', dark: '#fb9eac' } },
};
