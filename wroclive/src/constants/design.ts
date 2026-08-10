/**
 * The design system: every size, radius, shadow and step of the type ramp.
 *
 * Before this file existed each component invented its own. Twelve of them
 * hand-rolled `fontSize: 17 / 19 / 21 / 23 / 26` inline because `ThemedText`
 * only offered a 48pt title and a 32pt subtitle that nothing wanted, and three
 * of them carried a copy of the same `Platform.select` shadow. The result read
 * as a template rather than a designed app, which is the whole reason for this
 * pass. Nothing below is decorative — reach for a token, never a number.
 */

import { Platform, type TextStyle } from 'react-native';

/**
 * The type ramp, aligned to the system text styles rather than invented.
 *
 * Sizes match iOS's own steps so the app sits inside the platform's typography
 * instead of beside it, and the tighter tracking at the large end is what keeps
 * a 28pt Polish title from reading as a banner. Every step carries its own line
 * height: leading is part of a type style, not something a layout re-decides.
 */
export const Type = {
  /** Screen titles. */
  display: { fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  /** Section and sheet titles. */
  title: { fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  /** The most important line in a block — a stop name, a direction. */
  headline: { fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  /** Running text. */
  body: { fontSize: 16, lineHeight: 22, letterSpacing: -0.1 },
  /** A denser body, for rows that carry two lines. */
  callout: { fontSize: 15, lineHeight: 20, letterSpacing: -0.1 },
  /** Supporting text under a headline. */
  subhead: { fontSize: 14, lineHeight: 19, letterSpacing: 0 },
  /** Timestamps, hints, counts. */
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  /** Section headers and badges — the smallest thing worth reading. */
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0.1 },
} as const satisfies Record<string, TextStyle>;

export type TypeStep = keyof typeof Type;

/**
 * Weights as names.
 *
 * Weight used to be smuggled into the type name (`smallBold` beside `small`),
 * which doubled the ramp for no reason and meant a bold caption had nowhere to
 * live. It is an independent axis and is spelled as one.
 */
export const Weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  heavy: '800',
} as const satisfies Record<string, TextStyle['fontWeight']>;

export type WeightName = keyof typeof Weight;

/**
 * The spacing scale.
 *
 * Replaces `Spacing.half / one / two / three / four / five / six`, whose names
 * said nothing about size and which jumped 32 → 64 with nothing between.
 */
export const Space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  huge: 48,
} as const;

/** Corner radii. `pill` is deliberately huge so it rounds any height fully. */
export const Radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

/**
 * Shadows, one definition per role.
 *
 * Web needs `boxShadow` and Android needs `elevation`; expressing that once
 * here is what stopped three components from each keeping their own slightly
 * different copy.
 */
const shadow = (
  ios: { opacity: number; radius: number; y: number },
  elevation: number,
) =>
  Platform.select({
    ios: {
      shadowColor: '#000000',
      shadowOpacity: ios.opacity,
      shadowRadius: ios.radius,
      shadowOffset: { width: 0, height: ios.y },
    },
    android: { elevation },
    default: {
      boxShadow: `0 ${ios.y}px ${ios.radius * 2}px rgba(0,0,0,${ios.opacity})`,
    },
  }) as object;

export const Elevation = {
  /** A card resting on the page. */
  card: shadow({ opacity: 0.08, radius: 8, y: 2 }, 2),
  /** Anything floating over the map. */
  floating: shadow({ opacity: 0.18, radius: 10, y: 3 }, 5),
  /** The sheet, whose shadow points upward. */
  sheet: Platform.select({
    ios: {
      shadowColor: '#000000',
      shadowOpacity: 0.18,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: -4 },
    },
    android: { elevation: 16 },
    default: { boxShadow: '0 -4px 28px rgba(0,0,0,0.2)' },
  }) as object,
  /** A map marker: small and tight, or it smears at marker scale. */
  marker: shadow({ opacity: 0.3, radius: 3, y: 1 }, 3),
} as const;

/**
 * The smallest thing a finger can reliably hit.
 *
 * Both platforms publish a minimum (44pt on iOS, 48dp on Android); 44 is the
 * number this app builds to, with `hitSlop` making up the difference where a
 * control has to *look* smaller than it is.
 */
export const HitTarget = 44;

/** How long the sheet, and anything that moves with it, takes to settle. */
export const Motion = {
  /** Reanimated spring for the sheet and anything tracking it. */
  spring: { damping: 24, stiffness: 240, mass: 0.75 } as const,
  /** A plain fade or slide that should not overshoot. */
  timing: { duration: 220 } as const,
  /**
   * What a spring becomes when the system asks for less movement.
   *
   * Short and linear: it still says "this moved", without the overshoot and
   * settle that Reduce Motion exists to remove.
   */
  reduced: { duration: 160 } as const,
  /** Pressed-state opacity, one value so every control depresses alike. */
  pressedOpacity: 0.55,
} as const;
