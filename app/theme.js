/**
 * Design tokens.
 *
 * Direction: the app quotes the thing people actually read at a Wrocław stop —
 * the amber-on-black DIP departure board. That vocabulary is spent in exactly
 * one place (the departures sheet). Everything else stays quiet, light and
 * native so the board is the thing you remember.
 */

export const color = {
  // The board.
  ink: "#0E141B",
  inkRaised: "#1A2430",
  inkLine: "#26333F",

  // Daylight surfaces.
  paper: "#FFFFFF",
  paperMuted: "#F1F5F9",
  paperLine: "#E2E8F0",

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

export const type = {
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  body: { fontSize: 15, fontWeight: "500" },
  small: { fontSize: 13, fontWeight: "500" },
  caption: { fontSize: 11, fontWeight: "600", letterSpacing: 0.6 },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

/**
 * Heights of the chrome that floating surfaces have to clear.
 *
 * The tab bar and the status pill are laid out by hand rather than measured,
 * and three things float over the map and must not collide with them: the
 * departures sheet, the "pick some lines" prompt and the route banner. Those
 * offsets used to be written as literals (`bottom: 92`, `top: 96`) that were
 * only correct on an iPhone with a home indicator — on a device with no bottom
 * inset the sheet hovered 34pt above the tab bar with a gap under it. Combine
 * these with the live inset from `useSafeAreaInsets()`, never on their own.
 */
export const layout = {
  // paddingTop 8 + icon 22 + gap 2 + label ~14 + tab padding 8 + paddingBottom 4
  tabBar: 58,
  // paddingVertical 8 twice + a 15pt line
  statusPill: 36,
};

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };

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
};

export const colorForType = (t) => lineColor[t] || lineColor.unknown;
