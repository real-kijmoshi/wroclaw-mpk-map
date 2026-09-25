/**
 * What `expo-widgets` can hand WidgetKit.
 *
 * A widget timeline is stored in the app group's `UserDefaults`, and
 * `UserDefaults` takes property lists only: strings, numbers, booleans,
 * arrays and dictionaries. Expo turns a JS `null` into `NSNull`, which is
 * none of those, so one `label: null` anywhere in thirty entries made iOS
 * refuse the whole timeline — the widget stayed on "star a stop" with five
 * stops starred, and the stop picker, which reads the same timeline, spun on
 * "Loading…" for ever. Nothing reported it: the write fails inside the
 * system.
 *
 * So a `null` (or `undefined`) field is dropped rather than sent, and the
 * layouts read a missing field as `null` (`== null`, never `=== null`). A
 * non-finite number is dropped the same way — it has no property-list form
 * either.
 */
export function toPropertyList(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null).map(toPropertyList);
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item == null) continue;
      if (typeof item === 'number' && !Number.isFinite(item)) continue;
      result[key] = toPropertyList(item);
    }
    return result;
  }
  return value;
}
