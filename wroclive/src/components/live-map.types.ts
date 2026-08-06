import type { MapMessage } from '@/lib/map-html';

/** Commands the app sends into the Leaflet page. */
export type MapCommand =
  | { type: 'vehicles'; vehicles: unknown[] }
  | { type: 'route'; shape: unknown | null }
  | { type: 'stops'; stops: unknown[] }
  | { type: 'user'; position: { lat: number; lon: number } | null }
  | { type: 'theme'; dark: boolean }
  | { type: 'select'; id: string | null; follow?: boolean; center?: boolean }
  | { type: 'center'; lat: number; lon: number; zoom?: number; animate?: boolean };

export type LiveMapHandle = { send: (command: MapCommand) => void };

export type LiveMapProps = {
  dark: boolean;
  onMessage: (message: MapMessage) => void;
};
