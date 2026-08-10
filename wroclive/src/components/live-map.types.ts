import type { MapMessage } from '@/lib/map-html';

/** Commands the app sends into the Leaflet page. */
export type MapCommand =
  | { type: 'vehicles'; vehicles: unknown[] }
  | { type: 'route'; shape: unknown | null }
  | { type: 'stops'; stops: unknown[]; selectedId?: string | null }
  | { type: 'selectStop'; id: string | null }
  | { type: 'user'; position: { lat: number; lon: number } | null }
  | { type: 'theme'; dark: boolean }
  | { type: 'select'; id: string | null; follow?: boolean; center?: boolean }
  | { type: 'center'; lat: number; lon: number; zoom?: number; animate?: boolean };

export type LiveMapHandle = { send: (command: MapCommand) => void };

export type LiveMapProps = {
  dark: boolean;
  onMessage: (message: MapMessage) => void;
};

/**
 * Commands describe current map state, so only the newest command of each
 * kind matters while the embedded map is loading. This bounds the startup
 * queue if Leaflet or its tiles are slow and avoids replaying stale fleets.
 */
export function enqueueLatest(queue: MapCommand[], command: MapCommand) {
  const existing = queue.findIndex((item) => item.type === command.type);
  if (existing >= 0) queue[existing] = command;
  else queue.push(command);
}
