import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { NativeMap } from './native-map';

export type { MapSurfaceHandle, MapSurfaceProps, MapRoute } from './map-surface.types';

/**
 * The Android native map surface.
 *
 * The rider's provider preference is handled inside the surface: Google Maps
 * is the default and the OSM option replaces its tiles.
 *
 * iOS and web resolve their platform files instead. iOS deliberately avoids
 * react-native-maps because its MapKit renderer can show the red rendering
 * artifact seen in development runtimes.
 */
export const MapView = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function MapView(props, ref) {
  return <NativeMap ref={ref} {...props} />;
});

/** Whether this build can offer the platform map at all, for the settings screen. */
export const platformMapAvailable = true;
