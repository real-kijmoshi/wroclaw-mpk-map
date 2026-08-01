import { Platform, StyleSheet } from "react-native";

/**
 * Design tokens.
 *
 * Direction: the app quotes the thing people actually read at a Wrocław stop —
 * the amber-on-black DIP departure board. That vocabulary is spent in exactly
 * one place (the departures sheet). Everything else stays quiet, light and
 * native so the board is the thing you remember.
 *
 * "Native" here means iOS: system greys, translucent materials over the map,
 * inset grouped lists, capsule controls. The values below are the iOS system
 * palette rather than a generic slate ramp, so the chrome reads as part of the
 * phone instead of as a web page pretending to be an app.
 */

export const color = {
  // The board.
  ink: "#0E141B",
  inkRaised: "#1A2430",
  inkLine: "#26333F",

  // Daylight surfaces. paperMuted is iOS systemGroupedBackground, which is what
  // an inset grouped list sits on; paper is the card on top of it.
  paper: "#FFFFFF",
  paperMuted: "#F2F2F7",
  paperLine: "#E5E5EA",

  // iOS system fills and separators. These are deliberately translucent: over a
  // map or a blurred bar they pick up what is behind them instead of punching a
  // flat grey hole in it.
  fill: "rgba(120, 120, 128, 0.12)",
  fillStrong: "rgba(120, 120, 128, 0.20)",
  separator: "rgba(60, 60, 67, 0.18)",
  scrim: "rgba(0, 0, 0, 0.32)",
  hairlineOnDark: "rgba(255, 255, 255, 0.10)",

  // MPK tram blue — primary action.
  rail: "#0B5FBF",
  railDark: "#084A96",

  // Departure amber. Reserved for time. If it isn't a countdown, it isn't amber.
  amber: "#FFB020",

  text: "#0F172A",
  textMuted: "#64748B",
  textOnDark: "#F8FAFC",
  textOnDarkMuted: "#94A3B8",

  disruption: "#C2410C",
  destructive: "#C81E1E",
  live: "#16A34A",
  stale: "#B45309",
};

/**
 * Line-type colours.
 *
 * The previous palette was an arbitrary rainbow — #F8E71C yellow behind white
 * text sat around 1.4:1, effectively unreadable in sunlight, which is precisely
 * when you are looking at your phone at a stop. Every value here clears 4.5:1
 * against white.
 */
export const lineColor = {
  tram: "#0B5FBF",
  tramSpecial: "#0E7490",
  tramTemporary: "#7C3AED",
  bus: "#B91C1C",
  busNight: "#3730A3",
  busSuburban: "#15803D",
  busTemporary: "#A16207",
  busZone: "#9D174D",
  busExpress: "#C2410C",
  busSpecial: "#334155",
  unknown: "#475569",
};

export const lineLabel = {
  tram: "Tramwaje",
  tramSpecial: "Tramwaje specjalne",
  tramTemporary: "Tramwaje tymczasowe",
  bus: "Autobusy",
  busNight: "Autobusy nocne",
  busSuburban: "Autobusy podmiejskie",
  busTemporary: "Autobusy tymczasowe",
  busZone: "Autobusy strefowe",
  busExpress: "Autobusy pospieszne",
  busSpecial: "Autobusy specjalne",
  unknown: "Pozostałe",
};

/**
 * Two type roles.
 *
 * Body is the system face — native, legible, invisible, correct for chrome.
 * Data is Barlow Semi Condensed, which comes out of the same signage tradition
 * as destination blinds and platform indicators. It is used only for numerals
 * and line badges, never for prose.
 */
export const font = {
  data: "BarlowSemiCondensed_700Bold",
  dataMedium: "BarlowSemiCondensed_600SemiBold",
};

/**
 * The iOS text styles the app actually uses, at their real sizes and tracking.
 * Anything typeset by hand drifts away from the platform; going through these
 * is what keeps a sheet header looking like a sheet header.
 */
export const type = {
  largeTitle: { fontSize: 30, fontWeight: "700", letterSpacing: -0.6 },
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.45 },
  headline: { fontSize: 17, fontWeight: "600", letterSpacing: -0.43 },
  callout: { fontSize: 16, fontWeight: "500", letterSpacing: -0.32 },
  body: { fontSize: 15, fontWeight: "500" },
  small: { fontSize: 13, fontWeight: "500" },
  footnote: { fontSize: 13, fontWeight: "400", letterSpacing: -0.08 },
  caption: { fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, control: 12, md: 12, card: 16, lg: 18, sheet: 28, pill: 999 };

export const hairline = StyleSheet.hairlineWidth;

/**
 * Nothing the finger can hit is allowed to be smaller than this. The line chips
 * used to be 35pt tall, which is a miss every few taps on the move.
 */
export const HIT_SIZE = 44;

/** Chrome that floats over the map is centred and capped on a wide window. */
export const layout = { maxContentWidth: 480 };

export const shadow = {
  card: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 8,
  },
  chip: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  float: {
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 12,
  },
  sheet: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 24,
  },
};

/**
 * Translucent "material", the iOS surface for anything floating over content.
 *
 * The browser can do the real thing — react-native-web passes backdropFilter
 * straight through to CSS and prefixes it — so on web the bar genuinely blurs
 * the map underneath. React Native has no equivalent without pulling in a
 * native blur view, so the native fallback is the same tint at an opacity high
 * enough to stay legible over dark map tiles. The keys are kept apart per
 * platform so `backdropFilter` never reaches a native StyleSheet.
 */
export const material = {
  light: Platform.select({
    web: {
      backgroundColor: "rgba(255, 255, 255, 0.72)",
      backdropFilter: "saturate(180%) blur(20px)",
    },
    default: { backgroundColor: "rgba(255, 255, 255, 0.94)" },
  }),
  dark: Platform.select({
    web: {
      backgroundColor: "rgba(20, 26, 33, 0.72)",
      backdropFilter: "saturate(180%) blur(20px)",
    },
    default: { backgroundColor: "rgba(20, 26, 33, 0.94)" },
  }),
};

/**
 * One spring vocabulary. `sheet` is the sheet presentation, `press` is the
 * touch-down scale, `settle` is anything returning to rest.
 */
export const spring = {
  sheet: { damping: 26, stiffness: 260, mass: 0.85 },
  press: { damping: 20, stiffness: 500, mass: 0.4 },
  settle: { damping: 22, stiffness: 220, mass: 0.7 },
};

export const colorForType = (t) => lineColor[t] || lineColor.unknown;
