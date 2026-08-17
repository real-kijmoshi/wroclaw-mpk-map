import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { OsmMap } from './osm-map';

export type { MapSurfaceHandle, MapSurfaceProps, MapRoute } from './map-surface.types';

/**
 * The Android surface: the Leaflet page, not `react-native-maps`.
 *
 * On Android `react-native-maps` renders through the Google Maps SDK and has no
 * other provider — its OSM option is a `UrlTile` layer drawn *on top of* a
 * Google map, so the SDK still initialises and a store build still needs a Maps
 * API key. This project ships no Google Maps, so Android draws the same Leaflet
 * page the web build does (`osm-map.tsx` → `live-map.tsx`), and the Google Maps
 * SDK is never instantiated.
 *
 * iOS keeps the native surface: `map-view.ios.tsx` resolves to `native-map.tsx`,
 * which is MapKit — Apple's own map, no key, no Google.
 */
export const MapView = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function MapView(props, ref) {
  return <OsmMap ref={ref} {...props} />;
});

/**
 * Whether this build can offer a *platform* map alongside OpenStreetMap, for
 * the settings screen and the map's layers button. Android has one surface, so
 * there is no provider to choose — same as web.
 */
export const platformMapAvailable = false;
