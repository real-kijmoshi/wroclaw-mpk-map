/**
 * When the departures widget's timeline entries fall, and what each one is.
 *
 * WidgetKit hands a layout the *entry's* date as "now", not the wall clock,
 * and a reload comes a quarter of an hour apart at best (the extension
 * fetches on each — `DeparturesLiveFetch` in plugins/with-widget-stop-picker.js
 * mirrors this file). So the timeline used to stop at a single entry half an
 * hour after the app last wrote it, and that entry stayed on screen for as long
 * as nothing replaced it — at 18:33 the widget was still listing the 08:08,
 * 08:09, 08:11 and 08:14 trams, the last two in amber as if they were catchable,
 * under "Stan z 07:38". Ten hours of departures that had already left.
 *
 * So the timeline now runs in three parts:
 *
 * - one entry a minute for the first `COUNTDOWN_MINUTES`, counting down;
 * - then one entry each time a known departure leaves, showing clock times
 *   (nothing redraws them once a minute, so a countdown there would freeze),
 *   which keeps the list true for as long as the fetched board reaches;
 * - and a last, `expired` entry with no rows. Nothing replaces the last entry,
 *   so it must not claim anything that time can make false: it says the
 *   departures need refreshing, which stays true however long it is up.
 *
 * How long the middle part lasts is the whole user-facing question. iOS runs
 * the background refresh when it chooses (an app refresh task, a few times a
 * day at best and never after the app is swiped away), so the timeline has to
 * last until the app next runs. With half an hour of board behind it, the widget read
 * "Odjazdy wymagają odświeżenia" at 19:06 after a 16:25 refresh, and again at
 * 08:33 after 23:10. The boards are now fetched a day ahead
 * (`WIDGET_HORIZON` in `api.ts`) and the timeline runs as far as they reach,
 * bounded by entry count and by `TIMELINE_BYTE_BUDGET` — the timeline is
 * stored in the app group's UserDefaults, which refuses anything over 4 MB,
 * and the other widgets and activities share it.
 *
 * Import-free on purpose: `server/test/widget-timeline.test.js` runs it.
 */

/** One entry a minute, counting down, for this long after a write. */
export const COUNTDOWN_MINUTES = 30;
/** Total entries, so a dozen starred stops cannot grow the timeline without bound. */
export const MAX_TIMELINE_ENTRIES = 1000;
/**
 * Serialized (JSON) size the whole timeline may take; see `withinBudget()`.
 * The plist UserDefaults stores is smaller than the JSON (a binary plist keeps
 * one copy of each repeated string), so this stays well clear of the 4 MB
 * UserDefaults refuses while holding a night of three busy stops.
 */
export const TIMELINE_BYTE_BUDGET = 2_500_000;
/** A row stays listed while its departure is less than this far in the past. */
export const DEPARTED_GRACE_MS = 30_000;

const MINUTE = 60_000;

export type TimelineSlot = {
  /** Epoch ms the entry takes over. */
  date: number;
  /** Clock times instead of countdowns: no entry follows a minute later to redraw it. */
  final: boolean;
  /** The last entry: no rows, only "open the app". */
  expired: boolean;
};

/** The first minute boundary at which a row leaving at `at` is no longer listed. */
export function departedAt(at: number): number {
  return (Math.floor((at + DEPARTED_GRACE_MS) / MINUTE) + 1) * MINUTE;
}

/** Whether a row leaving at `at` is still listed in the entry dated `date`. */
export function listedAt(at: number, date: number): boolean {
  return at >= date - DEPARTED_GRACE_MS;
}

/**
 * The entries for a timeline written at `now`, given every row's departure
 * time across every stop.
 */
export function timelineSlots(now: number, departures: number[]): TimelineSlot[] {
  const start = Math.floor(now / MINUTE) * MINUTE;
  const countdownEnd = start + COUNTDOWN_MINUTES * MINUTE;
  const slots: TimelineSlot[] = [];
  for (let minute = 0; minute < COUNTDOWN_MINUTES; minute += 1) {
    slots.push({ date: start + minute * MINUTE, final: false, expired: false });
  }
  // Each later entry is the moment some departure leaves the list.
  const changes = [
    ...new Set(departures.filter(Number.isFinite).map(departedAt).filter((date) => date > countdownEnd)),
  ].sort((a, b) => a - b);
  const room = MAX_TIMELINE_ENTRIES - COUNTDOWN_MINUTES - 2;
  slots.push({ date: countdownEnd, final: true, expired: false });
  for (const date of changes.slice(0, room)) slots.push({ date, final: true, expired: false });
  if (changes.length > room) {
    // More departures than entries: stop at the first one it cannot follow.
    slots.push({ date: changes[room], final: true, expired: true });
  } else {
    // Every known departure has left by the last entry (or by minute 30).
    slots[slots.length - 1].expired = true;
  }
  return slots;
}

/**
 * Cut a timeline to `budget` bytes, ending it on an expired entry.
 *
 * `sizeOf` is what an entry costs serialized. Entries are kept in order until
 * the next would cross the budget; that one becomes the expired entry, so the
 * timeline still ends saying "open the app" at exactly the moment the last
 * kept entry stops being true. The countdown half hour is always kept.
 */
export function withinBudget(
  slots: TimelineSlot[],
  sizeOf: (slot: TimelineSlot) => number,
  budget = TIMELINE_BYTE_BUDGET,
): TimelineSlot[] {
  let used = 0;
  for (let index = 0; index < slots.length; index += 1) {
    used += sizeOf(slots[index]);
    if (used > budget && index > COUNTDOWN_MINUTES) {
      return [...slots.slice(0, index), { ...slots[index], expired: true }];
    }
  }
  return slots;
}
