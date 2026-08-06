import { forwardRef } from 'react';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';

/**
 * Apple's map exists only on iOS.
 *
 * Metro picks `apple-map.ios.tsx` there; everywhere else this stub is what
 * gets bundled, so nothing outside iOS ever imports `expo-maps` — importing a
 * view that has no implementation for the platform is a crash, not a fallback.
 */
export const appleMapsAvailable = false;

export const AppleMap = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function AppleMap() {
  return null;
});
