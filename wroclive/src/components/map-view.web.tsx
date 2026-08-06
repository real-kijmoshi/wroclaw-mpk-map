import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { OsmMap } from './osm-map';

export type { MapSurfaceHandle, MapSurfaceProps, MapRoute } from './map-surface.types';

/**
 * Leaflet is the web counterpart to the native react-native-maps surface.
 * Keeping this in a platform file prevents the native module from entering the
 * browser bundle.
 */
export const MapView = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function MapView(props, ref) {
  return <OsmMap ref={ref} {...props} />;
});

export const platformMapAvailable = false;
