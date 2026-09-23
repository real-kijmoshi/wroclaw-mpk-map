import { parseLink } from '@/lib/links';
import { mapIntentStore } from '@/lib/map-intent';

/**
 * Incoming `wroclive://open?…` links — a tap on the widget or the Live
 * Activity, or a link opened from elsewhere.
 *
 * There is no route per stop or vehicle: the map is the only screen that can
 * show either, so the link becomes the same one-shot intent the search screen
 * posts, and the router is sent to the map. Anything not ours passes through
 * untouched. Never throws — an error here crashes the launch.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const target = parseLink(path);
    if (!target) return path;
    if (target.kind === 'stop') mapIntentStore.openStop(target.stop);
    else mapIntentStore.openVehicleId(target.id);
    return '/';
  } catch {
    return '/';
  }
}
