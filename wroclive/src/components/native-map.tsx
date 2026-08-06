import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Maps, {
  Marker,
  Polyline,
  UrlTile,
  type MapMarkerProps,
  type Region,
} from 'react-native-maps';

import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import type { FleetVehicle, Stop } from '@/lib/api';
import { vehicleBorderColorFor, vehicleColorFor } from '@/lib/lines';
import { WROCLAW_CENTER } from '@/lib/map-html';
import { usePreferences } from '@/lib/preferences';

/**
 * The map, drawn by the platform.
 *
 * MapKit on iOS, Google's map on Android — the real thing, gestures and labels
 * and all, rather than a page in a WebView. `react-native-maps` is a native
 * module, but it is one of the modules Expo Go carries (`AIRMap` is in the Expo
 * Go binary), so this renders in Expo Go as well as in a build.
 *
 * The web build cannot have it — there is no web implementation — so
 * `native-map.web.tsx` hands the Leaflet page back there instead. Nothing above
 * this file knows which one it got.
 */

/** Below this span every stop label would overlap, so they stay hidden. */
const STOP_LABEL_MAX_DELTA = 0.03;

/** How long a marker keeps redrawing after its appearance changes. */
const MARKER_TRACK_MS = 350;

/**
 * Keep one extra half-viewport of markers around every edge. Panning stays
 * seamless, while a close city view no longer mounts hundreds of offscreen
 * native views.
 */
const MARKER_OVERSCAN_RATIO = 0.5;

/** A Leaflet zoom level as the region span `react-native-maps` speaks in. */
const deltaForZoom = (zoom: number) => 360 / 2 ** zoom;

const INITIAL_REGION: Region = {
  latitude: WROCLAW_CENTER.lat,
  longitude: WROCLAW_CENTER.lon,
  latitudeDelta: deltaForZoom(WROCLAW_CENTER.zoom),
  longitudeDelta: deltaForZoom(WROCLAW_CENTER.zoom),
};

/**
 * A marker with a custom child view keeps the first snapshot it took once
 * `tracksViewChanges` is false — which is what makes a few hundred of them
 * affordable, and also means a style change never reaches the screen. This
 * turns tracking back on for a beat whenever the look changes, and off again
 * once the new appearance has been captured.
 */
function useMarkerRedraw(look: string) {
  const [capturedLook, setCapturedLook] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setCapturedLook(look), MARKER_TRACK_MS);
    return () => clearTimeout(timer);
  }, [look]);

  return capturedLook !== look;
}

/**
 * Which way the vehicle is going.
 *
 * The direction tip is part of the marker rather than a separate rotating
 * layer. VehicleMarker rotates the complete badge and tip together, matching
 * the physical-looking markers in the reference.
 */
function HeadingArrow({ tint, edge }: { tint: string; edge: string }) {
  return (
    <View pointerEvents="none" style={styles.arrowOrbit}>
      <View style={[styles.arrowOutline, { borderBottomColor: edge }]} />
      <View style={[styles.arrowTip, { borderBottomColor: tint }]} />
    </View>
  );
}

const coordinate = (lat: number, lon: number) => ({
  latitude: Number(lat),
  longitude: Number(lon),
});

type VehicleMarkerProps = {
  vehicle: FleetVehicle;
  dimmed: boolean;
  selected: boolean;
  onPress: (id: string) => void;
};

const VehicleMarker = memo(
  function VehicleMarker({ vehicle, dimmed, selected, onPress }: VehicleMarkerProps) {
    // Heading is bucketed to 15°: redrawing for every degree of GPS jitter is
    // redrawing constantly, and nobody can see 5° on a 42pt badge. Same bucket
    // the Leaflet page uses.
    const tracking = useMarkerRedraw(
      `${vehicle.line}|${vehicle.type}|${dimmed}|${selected}|${Math.round((vehicle.heading ?? -1) / 15)}`,
    );

    const towards = vehicle.trip?.towards ?? vehicle.trip?.headsign ?? null;
    const tint = vehicleColorFor(vehicle.type);
    const edge = vehicleBorderColorFor(vehicle.type);
    const bearing = Number.isFinite(vehicle.heading)
      ? [{ rotate: `${Math.round(vehicle.heading as number)}deg` }]
      : undefined;
    const uprightLabel = Number.isFinite(vehicle.heading)
      ? [{ rotate: `${-Math.round(vehicle.heading as number)}deg` }]
      : undefined;

    return (
      <Marker
        coordinate={coordinate(vehicle.lat, vehicle.lon)}
        // Google Maps/Android uses a normalized anchor. Apple Maps ignores that
        // prop and uses centerOffset instead, so explicitly select the centring
        // mechanism for each renderer.
        anchor={Platform.OS === 'ios' ? undefined : ANCHOR_CENTRE}
        centerOffset={Platform.OS === 'ios' ? APPLE_CENTRE_OFFSET : undefined}
        tracksViewChanges={tracking}
        // Android bubbles a marker tap through to the map underneath, which
        // would clear the very selection the tap just made.
        onPress={(event) => {
          event.stopPropagation();
          onPress(vehicle.id);
        }}
        accessibilityLabel={
          towards ? `Linia ${vehicle.line} do ${towards}` : `Linia ${vehicle.line}`
        }>
        <View style={[styles.vehicle, dimmed && styles.vehicleDimmed]}>
          <View style={[styles.vehicleBearing, bearing && { transform: bearing }]}>
            {Number.isFinite(vehicle.heading) && <HeadingArrow tint={tint} edge={edge} />}
            <View
              style={[
                styles.vehicleBody,
                { backgroundColor: tint, borderColor: edge },
                selected && styles.vehicleBadgeSelected,
              ]}>
              <View pointerEvents="none" style={styles.vehicleSheen} />
              <Text
                numberOfLines={1}
                allowFontScaling={false}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[
                  styles.vehicleLabel,
                  vehicle.line.length > 3 && styles.vehicleLabelLong,
                  uprightLabel && { transform: uprightLabel },
                ]}>
                {vehicle.line}
              </Text>
            </View>
          </View>
        </View>
      </Marker>
    );
  },
  (previous, next) =>
    previous.vehicle.id === next.vehicle.id &&
    previous.vehicle.line === next.vehicle.line &&
    previous.vehicle.type === next.vehicle.type &&
    previous.vehicle.lat === next.vehicle.lat &&
    previous.vehicle.lon === next.vehicle.lon &&
    previous.vehicle.heading === next.vehicle.heading &&
    previous.vehicle.trip?.towards === next.vehicle.trip?.towards &&
    previous.vehicle.trip?.headsign === next.vehicle.trip?.headsign &&
    previous.dimmed === next.dimmed &&
    previous.selected === next.selected &&
    previous.onPress === next.onPress,
);

type StopMarkerProps = {
  stop: Stop;
  tint: string;
  showLabel: boolean;
  onPress: (id: string, name: string) => void;
};

const StopMarker = memo(function StopMarker({ stop, tint, showLabel, onPress }: StopMarkerProps) {
  const tracking = useMarkerRedraw(`${tint}|${showLabel}`);

  return (
    <Marker
      coordinate={coordinate(stop.lat, stop.lon)}
      anchor={ANCHOR_CENTRE}
      tracksViewChanges={tracking}
      onPress={(event) => {
        event.stopPropagation();
        onPress(stop.id, stop.name);
      }}
      accessibilityLabel={`Przystanek ${stop.name}`}>
      <View style={styles.stopWrapper}>
        <View style={[styles.stopDot, { borderColor: tint }]} />
        {showLabel && (
          <View style={styles.stopLabel}>
            <Text style={styles.stopLabelText} numberOfLines={1}>
              {stop.name}
            </Text>
          </View>
        )}
      </View>
    </Marker>
  );
});

export const NativeMap = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function NativeMap(
  {
    dark,
    vehicles,
    route,
    selectedVehicleId,
    follow = false,
    userPosition,
    nearbyStops,
    onSelectVehicle,
    onSelectStop,
    onBackground,
  },
  ref,
) {
  const mapRef = useRef<Maps>(null);
  const { mapProvider } = usePreferences();
  const [visibleRegion, setVisibleRegion] = useState(INITIAL_REGION);

  useImperativeHandle(
    ref,
    () => ({
      centerOn(lat, lon, zoom) {
        const delta = deltaForZoom(zoom ?? 15);
        mapRef.current?.animateToRegion(
          { latitude: lat, longitude: lon, latitudeDelta: delta, longitudeDelta: delta },
          450,
        );
      },
    }),
    [],
  );

  const validVehicles = useMemo(
    () => vehicles.filter((vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon)),
    [vehicles],
  );

  const selected = useMemo(
    () => validVehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [validVehicles, selectedVehicleId],
  );

  const visibleVehicles = useMemo(() => {
    const latitudeRadius =
      visibleRegion.latitudeDelta * (0.5 + MARKER_OVERSCAN_RATIO);
    const longitudeRadius =
      visibleRegion.longitudeDelta * (0.5 + MARKER_OVERSCAN_RATIO);
    const inView = validVehicles.filter(
      (vehicle) =>
        Math.abs(vehicle.lat - visibleRegion.latitude) <= latitudeRadius &&
        Math.abs(vehicle.lon - visibleRegion.longitude) <= longitudeRadius,
    );

    // Following or fitting a selected vehicle must never lose its marker just
    // because the region completion event has not arrived yet.
    if (selected && !inView.some((vehicle) => vehicle.id === selected.id)) {
      inView.push(selected);
    }
    return inView;
  }, [selected, validVehicles, visibleRegion]);

  useEffect(() => {
    if (!follow || !selected) return;
    mapRef.current?.animateCamera(
      { center: { latitude: selected.lat, longitude: selected.lon } },
      { duration: 400 },
    );
  }, [follow, selected]);

  const routeKey = route && follow ? `${route.color}|${route.points.length}|${route.stops.length}` : null;
  useEffect(() => {
    if (!follow || !route?.points.length) return;
    mapRef.current?.fitToCoordinates(
      route.points.map(([latitude, longitude]) => ({ latitude, longitude })),
      { edgePadding: { top: 120, right: 64, bottom: 380, left: 64 }, animated: true },
    );
    // Selection only fits when the preference is enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const routeCoordinates = useMemo(
    () => (route ? route.points.map(([latitude, longitude]) => ({ latitude, longitude })) : []),
    [route],
  );

  // A route's own stops replace the nearby ones while there is a route, the
  // same way those two layers trade places everywhere else.
  const stops: Stop[] = route ? route.stops : nearbyStops;
  const showStopLabels = visibleRegion.latitudeDelta < STOP_LABEL_MAX_DELTA;

  const handleStop = useCallback(
    (id: string, name: string) => onSelectStop(id, name),
    [onSelectStop],
  );
  const handleRegionChange = useCallback((region: Region) => {
    setVisibleRegion(region);
  }, []);

  const osm = mapProvider === 'osm';

  return (
    <Maps
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      // Uncontrolled: feeding the region back on every pan fights the rider's
      // own gestures and makes the map stutter.
      initialRegion={INITIAL_REGION}
      onRegionChangeComplete={handleRegionChange}
      onPress={onBackground}
      showsUserLocation={Boolean(userPosition)}
      showsMyLocationButton={false}
      showsCompass={false}
      showsScale={false}
      showsIndoors={false}
      toolbarEnabled={false}
      pitchEnabled={false}
      rotateEnabled={false}
      userInterfaceStyle={dark ? 'dark' : 'light'}
      // Android draws the raster tiles over its own base map unless the base
      // map is switched off; iOS does it through the tile layer instead.
      mapType={osm && Platform.OS === 'android' ? 'none' : 'standard'}>
      {osm && (
        <UrlTile
          urlTemplate={`https://a.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}@2x.png`}
          maximumZ={20}
          shouldReplaceMapContent
          zIndex={-1}
        />
      )}

      {routeCoordinates.length > 1 && route && (
        <Polyline
          coordinates={routeCoordinates}
          strokeColor={route.color}
          strokeWidth={5}
          lineJoin="round"
          lineCap="round"
          zIndex={1}
        />
      )}

      {stops.map((stop) => (
        <StopMarker
          key={`stop-${stop.id}`}
          stop={stop}
          tint={route?.color ?? '#8e8e93'}
          showLabel={showStopLabels}
          onPress={handleStop}
        />
      ))}

      {visibleVehicles.map((vehicle) => (
        <VehicleMarker
          key={vehicle.id}
          vehicle={vehicle}
          // While a route is drawn, everything not running it steps back.
          dimmed={Boolean(selected) && vehicle.line !== selected?.line}
          selected={vehicle.id === selectedVehicleId}
          onPress={onSelectVehicle}
        />
      ))}
    </Maps>
  );
});

/** Whether this build can offer the platform's own map at all. */
export const nativeMapAvailable = true;

const ANCHOR_CENTRE: MapMarkerProps['anchor'] = { x: 0.5, y: 0.5 };
const APPLE_CENTRE_OFFSET: NonNullable<MapMarkerProps['centerOffset']> = { x: 0, y: 0 };

const styles = StyleSheet.create({
  // Fixed and square, so the spike's orbit is the same at every angle and the
  // badge stays centred on the vehicle's actual position.
  // The transparent 58pt canvas is symmetric around the GPS coordinate. It is
  // large enough for the 40pt tile to rotate diagonally without its bounds —
  // and therefore its native anchor — being cropped or shifted.
  vehicle: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center' },
  vehicleDimmed: { opacity: 0.35 },
  vehicleBearing: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowOrbit: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
  },
  arrowTip: {
    position: 'absolute',
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 14,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    backgroundColor: 'transparent',
  },
  arrowOutline: {
    position: 'absolute',
    top: 1,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 16,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    backgroundColor: 'transparent',
  },
  vehicleBody: {
    width: 40,
    minWidth: 40,
    height: 40,
    paddingHorizontal: 0,
    borderWidth: 2.5,
    borderRadius: 10.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 3,
  },
  vehicleSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 19,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  vehicleLabel: {
    maxWidth: 37,
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '400',
    lineHeight: 22,
    letterSpacing: -0.4,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.10)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  vehicleLabelLong: { fontSize: 15, letterSpacing: -0.7 },
  vehicleBadgeSelected: {
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowOpacity: 0.32,
    shadowRadius: 5,
    elevation: 7,
  },

  // Keep the measured marker bounds equal to the dot. A wide label wrapper
  // changes the native marker anchor and makes stops appear displaced.
  stopWrapper: { alignItems: 'center' },
  stopDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    borderWidth: 3,
  },
  stopLabel: {
    position: 'absolute',
    top: 18,
    maxWidth: 130,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  stopLabelText: { fontSize: 11, fontWeight: '700', color: '#000000' },
});
