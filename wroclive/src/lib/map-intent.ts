import { useSyncExternalStore } from 'react';

import type { FleetVehicle, LineType, Stop } from '@/lib/api';

/**
 * A single, one-shot message from somewhere on the stack to the map.
 *
 * It is exactly the shape the search screen needs: open this stop on the map,
 * then forget it. The store holds the newest pending intent only, and
 * `consume()` clears it the moment it is read, so a second reader never sees
 * the same message twice and the value is never stale by the time the map wakes
 * up behind its modal.
 *
 * Kept outside React like the line filter and preferences: it is set from the
 * search screen and read from the map screen, and neither wants to hand a
 * payload across the router.
 */

export type MapIntent =
  | { kind: 'open-stop'; stop: Stop }
  | { kind: 'open-line'; line: string; type: LineType }
  | { kind: 'open-vehicle'; vehicle: FleetVehicle };

let pending: MapIntent | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const mapIntentStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => pending,

  openStop(stop: Stop) {
    pending = { kind: 'open-stop', stop };
    emit();
  },

  openLine(line: string, type: LineType) {
    pending = { kind: 'open-line', line, type };
    emit();
  },

  openVehicle(vehicle: FleetVehicle) {
    pending = { kind: 'open-vehicle', vehicle };
    emit();
  },

  /** Read the pending intent once, clearing it so it is not consumed twice. */
  consume(): MapIntent | null {
    const intent = pending;
    pending = null;
    emit();
    return intent;
  },

  clear() {
    pending = null;
  },
};

export function useMapIntent(): MapIntent | null {
  return useSyncExternalStore(
    mapIntentStore.subscribe,
    mapIntentStore.getSnapshot,
    mapIntentStore.getSnapshot,
  );
}
