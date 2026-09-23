import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { NativeMap } from './native-map';

export type { MapSurfaceHandle, MapSurfaceProps, MapRoute } from './map-surface.types';

/**
 * The iOS surface: the native `react-native-maps` renderer, MapKit.
 *
 * `NativeMap` switches to its UrlTile layer when OpenStreetMap is selected; the
 * Leaflet page is reserved for browsers, where `react-native-maps` has no
 * implementation.
 */
export const MapView = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function MapView(props, ref) {
  return <NativeMap ref={ref} {...props} />;
});

export const platformMapAvailable = true;
