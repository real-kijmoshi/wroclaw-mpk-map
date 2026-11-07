/**
 * What a fresh board means for an armed "Czas wyjść" reminder. Kept free of
 * runtime imports so `server/test/leave-timing.test.js` can run it.
 *
 * A departure missing from one board is not a departure that left: a board
 * that came back short, or a run the server re-matched, would otherwise cancel
 * a reminder the rider is relying on with nothing on screen to say so. So a
 * missing departure keeps the last schedule until its own time has passed —
 * the same rule as the arrival alert: announced early, never dropped.
 */
export const LEAVE_RESCHEDULE_THRESHOLD_MS = 15_000;
/** A departure this far behind its time has gone. */
export const LEAVE_GONE_AFTER_MS = 30_000;

export type LeaveFollow = { action: 'keep' } | { action: 'drop' } | { action: 'reschedule' };

export function followLeaveAlert(
  current: { departureAt: number; firesAt: number },
  /** The same departure on the fresh board, as epoch ms, or null when it is not on it. */
  live: { departureAt: number; firesAt: number } | null,
  now: number,
): LeaveFollow {
  if (!live) {
    return current.departureAt + LEAVE_GONE_AFTER_MS <= now ? { action: 'drop' } : { action: 'keep' };
  }
  if (live.departureAt + LEAVE_GONE_AFTER_MS <= now) return { action: 'drop' };
  // Already delivered: moving it would only announce the same thing twice.
  if (current.firesAt <= now) return { action: 'keep' };
  if (Math.abs(live.firesAt - current.firesAt) <= LEAVE_RESCHEDULE_THRESHOLD_MS) return { action: 'keep' };
  return { action: 'reschedule' };
}
