import { requireOptionalNativeModule } from 'expo';
import type { AppleMaps as AppleMapsTypes } from 'expo-maps';
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import { colorFor } from '@/lib/lines';
import { BACKWARD_TOLERANCE_METERS, projectProgress, splitRoute, type RouteProgress, type RouteSplit } from '@/lib/route-progress';
import { WROCLAW_CENTER } from '@/lib/map-html';

/**
 * MapKit polylines expose `color` and `width` but no opacity, so the dimmed
 * travelled segment is the route colour with alpha baked into an rgba string,
 * which RN's colour pipeline turns into a native colour.
 */
function fadeColor(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const INITIAL_CAMERA = {
  coordinates: { latitude: WROCLAW_CENTER.lat, longitude: WROCLAW_CENTER.lon },
  zoom: WROCLAW_CENTER.zoom,
};

/**
 * Whether this *runtime* has the map, which is not the same question as
 * whether the platform is iOS.
 *
 * `expo-maps` is a native module: it is in a development or release build, and
 * it is not in Expo Go. Assuming it exists because the platform is iOS renders
 * a view with nothing behind it and the app dies on the map screen — the one
 * screen that is the whole app.
 */
export const appleMapsAvailable = requireOptionalNativeModule('ExpoMaps') !== null;

/**
 * Required rather than imported, because importing is the crash.
 *
 * `expo-maps`' entry point resolves its native module at module scope, and its
 * Apple view resolves a native view the same way, so a plain top-level import
 * throws while the bundle is still evaluating — before anything gets a chance
 * to check whether the module is there and fall back.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const maps: typeof import('expo-maps') | null = appleMapsAvailable ? require('expo-maps') : null;

/**
 * The map drawn by MapKit.
 *
 * Everything the Leaflet page draws by hand — the line badge, the route, the
 * stops — becomes an annotation or a polyline here, and MapKit owns the
 * gestures, the labels and dark mode.
 *
 * Two things are worth knowing before changing this. Annotation shape is
 * MapKit's, not ours, so a vehicle here is a balloon carrying the line number
 * rather than the square the fallback map draws. And `onAnnotationClick`
 * arrived in iOS 18: below that a rider can see the fleet but cannot tap into
 * a vehicle.
 */
export const AppleMap = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function AppleMap(
  {
    dark,
    vehicles,
    route,
    selectedVehicleId,
    userPosition,
    nearbyStops,
    onSelectVehicle,
    onSelectStop,
    onBackground,
  },
  ref,
) {
  const mapRef = useRef<AppleMapsTypes.MapView>(null);

  useImperativeHandle(
    ref,
    () => ({
      centerOn(latitude, longitude, zoom) {
        mapRef.current?.setCameraPosition({ coordinates: { latitude, longitude }, zoom });
      },
    }),
    [],
  );

  /**
   * Vehicles and stops as annotations.
   *
   * The id is prefixed so a tap can be told apart: the click handler is given
   * the annotation back, not which list it came from.
   */
  const annotations = useMemo<NonNullable<AppleMapsTypes.MapProps['annotations']>>(() => {
    const fleet = vehicles.map((vehicle) => ({
      id: `v:${vehicle.id}`,
      coordinates: { latitude: Number(vehicle.lat), longitude: Number(vehicle.lon) },
      text: vehicle.line,
      backgroundColor: colorFor(vehicle.type),
      textColor: '#ffffff',
      title: vehicle.trip?.towards ?? vehicle.trip?.headsign ?? vehicle.line,
      tintColor: colorFor(vehicle.type),
    }));

    // A route's own stops replace the nearby ones, the same way those layers
    // trade places on the Leaflet map.
    const stops = (route ? route.stops : nearbyStops).map((stop) => ({
      id: `s:${stop.id}`,
      coordinates: { latitude: Number(stop.lat), longitude: Number(stop.lon) },
      text: '',
      backgroundColor: dark ? '#1c1c1e' : '#ffffff',
      textColor: dark ? '#ffffff' : '#000000',
      title: stop.name,
      tintColor: route?.color ?? '#8e8e93',
    }));

    return [...stops, ...fleet];
  }, [vehicles, route, nearbyStops, dark]);

  const progressRef = useRef<{ vehicleId: string; progress: RouteProgress } | null>(null);

  const polylines = useMemo<NonNullable<AppleMapsTypes.MapProps['polylines']>>(() => {
    if (!route?.points.length) return [];

    const selected = selectedVehicleId
      ? (vehicles.find((v) => v.id === selectedVehicleId) ?? null)
      : null;
    let split: RouteSplit | null = null;
    if (selectedVehicleId && selected && Number.isFinite(selected.lat) && Number.isFinite(selected.lon)) {
      const prev = progressRef.current?.vehicleId === selectedVehicleId
        ? progressRef.current.progress
        : null;
      const projected = projectProgress(
        route.points,
        selected.lat,
        selected.lon,
        prev ? { segmentIndex: prev.segmentIndex, alongMeters: prev.alongMeters } : undefined,
      );
      if (projected) {
        if (!prev || projected.alongMeters >= prev.alongMeters - BACKWARD_TOLERANCE_METERS) {
          progressRef.current = { vehicleId: selectedVehicleId, progress: projected };
          split = splitRoute(route.points, projected);
        } else {
          split = splitRoute(route.points, prev);
        }
      } else {
        progressRef.current = null;
      }
    } else {
      progressRef.current = null;
    }

    if (!split) {
      return [
        {
          id: 'route',
          coordinates: route.points.map(function (p) { return { latitude: p[0], longitude: p[1] }; }),
          color: route.color,
          width: 6,
        },
      ];
    }

    return [
      {
        id: 'route-travelled',
        coordinates: split.travelled.map(function (p) { return { latitude: p[0], longitude: p[1] }; }),
        color: fadeColor(route.color, 0.3),
        width: 6,
      },
      {
        id: 'route-remaining',
        coordinates: split.remaining.map(function (p) { return { latitude: p[0], longitude: p[1] }; }),
        color: route.color,
        width: 6,
      },
    ];
  }, [route, vehicles, selectedVehicleId]);

  const handleAnnotation = useCallback(
    (annotation: AppleMapsTypes.Annotation) => {
      const id = annotation.id ?? '';
      if (id.startsWith('v:')) {
        onSelectVehicle(id.slice(2));
        return;
      }
      if (id.startsWith('s:')) {
        const stopId = id.slice(2);
        onSelectStop(
          (route?.stops ?? nearbyStops).find((stop) => stop.id === stopId) ?? {
            id: stopId,
            name: annotation.title ?? '',
            lat: 0,
            lon: 0,
          },
        );
      }
    },
    [nearbyStops, onSelectVehicle, onSelectStop, route],
  );

  // After the hooks, never before them. Nothing should reach this component
  // without the module, but a missing map is not worth a hook-order crash.
  if (!maps) return null;
  const { AppleMaps } = maps;

  return (
    <AppleMaps.View
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      colorScheme={dark ? AppleMaps.MapColorScheme.DARK : AppleMaps.MapColorScheme.LIGHT}
      cameraPosition={INITIAL_CAMERA}
      annotations={annotations}
      polylines={polylines}
      properties={{
        isMyLocationEnabled: Boolean(userPosition),
        mapType: AppleMaps.MapType.STANDARD,
        selectionEnabled: true,
      }}
      uiSettings={{
        compassEnabled: true,
        myLocationButtonEnabled: false,
        scaleBarEnabled: false,
        togglePitchEnabled: false,
      }}
      onAnnotationClick={handleAnnotation}
      onMapClick={onBackground}
    />
  );
});
