type Row = { at: number; line: string };
type Entry = { props?: { stops?: { id: string; rows?: Row[] }[] } };

/**
 * Rows for the stops whose boards did not arrive this time, taken from the
 * timeline already on the widget.
 *
 * A widget refresh used to write whatever the fetch returned. When a board
 * failed, it wrote an empty one: a background refresh with no signal, or the
 * app's first write at launch, before its own fetch had answered. The next
 * refresh was hours away, and until then the widget said "Brak danych o
 * odjazdach" at a terminus with a tram every few minutes. Each row carries the
 * epoch time it leaves, not a countdown, so the rows already written stay true
 * and are simply carried over. Rows that have left are dropped.
 */
export function carryOverRows<R extends Row>(
  ids: Iterable<string>,
  previous: Entry[],
  now: number,
): Map<string, R[]> {
  const wanted = new Set(ids);
  const found = new Map<string, Map<string, R>>();
  for (const entry of previous) {
    for (const stop of entry?.props?.stops ?? []) {
      if (!wanted.has(stop.id)) continue;
      const rows = found.get(stop.id) ?? new Map<string, R>();
      for (const row of stop.rows ?? []) {
        if (!Number.isFinite(row?.at) || row.at < now - 30_000) continue;
        rows.set(`${row.line}|${row.at}`, row as R);
      }
      found.set(stop.id, rows);
    }
  }
  const result = new Map<string, R[]>();
  for (const [id, rows] of found) {
    if (rows.size > 0) result.set(id, [...rows.values()].sort((a, b) => a.at - b.at));
  }
  return result;
}
