import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { NativeMap } from './native-map';

export type { MapSurfaceHandle, MapSurfaceProps, MapRoute } from './map-surface.types';

/**
 * Avoid react-native-maps' affected MapKit renderer on iOS.
 *
 * Keep both native iOS choices on the native surface. `NativeMap` switches to
 * its UrlTile layer when OpenStreetMap is selected; the Leaflet WebView is
 * reserved for browsers, where it is reliable.
 */
export const MapView = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function MapView(props, ref) {
  return <NativeMap ref={ref} {...props} />;
});

export const platformMapAvailable = true;
