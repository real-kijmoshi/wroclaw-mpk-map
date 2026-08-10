import type { FleetVehicle, Stop } from '@/lib/api';

/** A route drawn on the map, already reduced to what any map can draw. */
export type MapRoute = {
  points: [number, number][];
  color: string;
  stops: { id: string; name: string; lat: number; lon: number }[];
} | null;

/**
 * What is currently on screen, in the terms every surface can express.
 *
 * A radius rather than a bounding box, because that is what `/stops/near`
 * takes and because a circle that covers the viewport is the honest shape of
 * "roughly here". `zoom` is a Leaflet level so a caller can gate on scale
 * without knowing whether it is talking to MapKit's region spans or Leaflet's
 * integers.
 */
export type MapViewport = {
  lat: number;
  lon: number;
  radiusMeters: number;
  zoom: number;
};

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
  /** Keep the selected vehicle centred while it moves. */
  follow?: boolean;
  /** Fit a route only when it was explicitly opened as a line. */
  fitRoute?: boolean;
  userPosition: { lat: number; lon: number } | null;
  /** The stops to draw. Whoever supplies them decides what "nearby" means. */
  nearbyStops: Stop[];
  /** Always drawn with its name, whatever the zoom or the de-collision pass. */
  selectedStopId?: string | null;
  onSelectVehicle: (id: string) => void;
  /** The complete record keeps a platform's ids and coordinates intact. */
  onSelectStop: (stop: Stop) => void;
  onBackground: () => void;
  /**
   * Fired when the rider stops moving the map.
   *
   * It is what makes the stops layer follow the viewport instead of waiting
   * for the locate button — you should be able to look at a district and see
   * its stops without telling the app where you are.
   */
  onViewportChange?: (viewport: MapViewport) => void;
};

export type MapSurfaceHandle = {
  centerOn: (lat: number, lon: number, zoom?: number) => void;
};
