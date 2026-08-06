import type { FleetVehicle, Stop } from '@/lib/api';

/** A route drawn on the map, already reduced to what any map can draw. */
export type MapRoute = {
  points: [number, number][];
  color: string;
  stops: { id: string; name: string; lat: number; lon: number }[];
} | null;

/**
 * What every map surface takes.
 *
 * Declarative on purpose: Apple's map is a React component that re-renders
 * from props, the Leaflet page is an imperative canvas behind a bridge, and
 * the screen above should not have to know which one it is talking to.
 */
export type MapSurfaceProps = {
  dark: boolean;
  vehicles: FleetVehicle[];
  route: MapRoute;
  selectedVehicleId: string | null;
  /** @deprecated Selection no longer moves the viewport. */
  follow?: boolean;
  userPosition: { lat: number; lon: number } | null;
  nearbyStops: Stop[];
  onSelectVehicle: (id: string) => void;
  onSelectStop: (id: string, name: string) => void;
  onBackground: () => void;
};

export type MapSurfaceHandle = {
  centerOn: (lat: number, lon: number, zoom?: number) => void;
};
