/**
 * The colour palette, in light and dark.
 *
 * Sizes, radii, shadows and the type ramp live in `design.ts`; this file is
 * only colour. `useTheme()` flattens one of these two objects and adds the
 * fixed accent, so every value here is reachable as `theme.<name>`
 * and every name is a `ThemeColor`.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    textSecondary: '#60646C',
    /**
     * Icons, chevrons and dividing marks.
     *
     * Still clears 4.5:1 on white, so a stray use on text is not a bug — but
     * everything at this weight is meant to recede, and text that recedes is
     * `textSecondary`.
     */
    textTertiary: '#72777F',
    /** A plain page. */
    background: '#ffffff',
    /** The page behind a grouped list, so the cards on it read as cards. */
    backgroundGrouped: '#F2F2F7',
    /** A card on that page. */
    backgroundCard: '#ffffff',
    /** An inline element: a search field, a chip, a quiet button. */
    backgroundElement: '#EFEFF4',
    backgroundSelected: '#E0E1E6',
    /**
     * Reserved for departure countdowns, and nothing else. It is the one loud
     * colour in the app and it works because nothing competes with it — if you
     * need emphasis somewhere else, use weight or spacing.
     */
    amber: '#9A5B00',
    separator: 'rgba(60,60,67,0.22)',
    danger: '#C0392B',
    success: '#15803D',
    /** What a glass surface falls back to where liquid glass is unavailable. */
    glass: 'rgba(255,255,255,0.82)',
    glassBorder: 'rgba(255,255,255,0.7)',
    scrim: 'rgba(0,0,0,0.35)',
  },
  dark: {
    text: '#ffffff',
    textSecondary: '#B0B4BA',
    textTertiary: '#8E939B',
    background: '#000000',
    backgroundGrouped: '#000000',
    backgroundCard: '#1C1C1E',
    backgroundElement: '#212225',
    /**
     * The lightest surface the app paints in dark mode. Every dark accent in
     * `ACCENT` is chosen to clear 4.5:1 against *this* value — moving it
     * invalidates all four of them.
     */
    backgroundSelected: '#2E3135',
    amber: '#FFB020',
    separator: 'rgba(84,84,88,0.5)',
    danger: '#FF6B5E',
    success: '#3DDC84',
    glass: 'rgba(28,28,30,0.78)',
    glassBorder: 'rgba(255,255,255,0.12)',
    scrim: 'rgba(0,0,0,0.5)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * The fixed accent colour for links, checkmarks and interactive highlights.
 *
 * Amber stays reserved for countdowns; line colours are fixed too — see
 * AGENTS.md invariants 10 and 11. This is the Wrocław blue, chosen once so
 * every surface has a single consistent accent regardless of colour scheme.
 */
export const ACCENT = {
  light: '#1d4ed8',
  dark: '#60a5fa',
} as const;

/**
 * Colours for chrome that floats over the map.
 *
 * These do **not** follow the OS colour scheme. The base map is the rider's
 * choice and satellite imagery is dark in both schemes, so a light-scheme phone
 * showing hybrid tiles was drawing black icons and `textSecondary` onto a
 * near-black photograph — the HUD subtitle and the whole right-hand control
 * stack were effectively invisible. `useMapChrome()` picks the variant from
 * what the map is actually drawing, not from the phone's setting.
 *
 * `surface` is the fill *under* the blur, which is why it is not fully opaque:
 * the material still reads as glass, but the text on it clears 4.5:1 even when
 * the blur resolves to the opposite extreme — a sunlit river or a snow-covered
 * roof under the dark material, night imagery under the light one. Those two
 * cases are what set the alphas: at the 0.72/0.84 they started at, the
 * *secondary* text landed at 4.28:1 and 4.22:1 against the composited surface.
 * `glassTint` is the same colour for iOS 26's real liquid glass, which does
 * much of that work itself and only needs a nudge towards the right end.
 */
export const MapChrome = {
  dark: {
    surface: 'rgba(24,24,26,0.80)',
    glassTint: 'rgba(24,24,26,0.42)',
    border: 'rgba(255,255,255,0.16)',
    text: '#ffffff',
    textSecondary: 'rgba(235,235,245,0.72)',
    /** A pressed control, and the fill behind an icon that needs separating. */
    fill: 'rgba(255,255,255,0.12)',
  },
  light: {
    surface: 'rgba(255,255,255,0.92)',
    glassTint: 'rgba(255,255,255,0.5)',
    border: 'rgba(0,0,0,0.08)',
    text: '#000000',
    textSecondary: '#60646C',
    fill: 'rgba(0,0,0,0.06)',
  },
} as const;

export type MapChromeTokens = (typeof MapChrome)[keyof typeof MapChrome];

/**
 * The same colour, softened to a background tint.
 *
 * Used wherever an icon sits on a patch of its own colour. Painting a white
 * glyph on a solid theme colour only works in light mode: every dark-mode token
 * is itself a *light* colour, so white-on-`textSecondary` came out at 2.1:1 and
 * white-on-`success` at 1.8:1 — invisible. A tint of the colour under a glyph
 * of the same colour reads correctly in both schemes, because each token is
 * already chosen to contrast with the surface it is drawn on.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return color;

  const digits = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1];
  const value = Number.parseInt(digits, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});
