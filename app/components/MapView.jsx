import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Maps, { Marker, Polyline } from "react-native-maps";
import * as Location from "expo-location";
import { LocateFixed, X } from "lucide-react-native";

import LineBadge from "./LineBadge";
import Material from "./Material";
import PressableScale from "./PressableScale";
import { fetchShape, toCoordinates, toStops } from "../api";
import {
  color,
  colorForType,
  font,
  hairline,
  layout,
  radius,
  shadow,
  space,
  type,
} from "../theme";

/** Below this zoom every stop label would overlap, so they are hidden. */
const STOP_LABEL_MAX_DELTA = 0.03;

function VehicleMarker({ vehicle, dimmed, onPress }) {
  return (
    <Marker
      coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(vehicle)}
      tracksViewChanges={false}
      accessibilityLabel={`Linia ${vehicle.line}`}
    >
      <View style={[styles.vehicle, dimmed && styles.vehicleDimmed]}>
        <LineBadge line={vehicle.line} type={vehicle.type} size="sm" style={styles.vehicleBadge} />
      </View>
    </Marker>
  );
}

function StopMarker({ stop, tint, selected, showLabel, onPress }) {
  return (
    <Marker
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(stop)}
      tracksViewChanges={false}
      accessibilityLabel={`Przystanek ${stop.name}`}
    >
      <View style={styles.stopWrapper}>
        <View
          style={[
            styles.stopDot,
            { borderColor: tint },
            selected && [styles.stopDotSelected, { backgroundColor: tint }],
          ]}
        />
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
}

export default function MapView({
  style,
  initialRegion,
  vehicles,
  showsUserLocation,
  onSelectStop,
  selectedStopId,
  topOffset = 0,
  bottomOffset = 0,
}) {
  const mapRef = useRef(null);
  const requestRef = useRef(0);
  const [zoomDelta, setZoomDelta] = useState(initialRegion.latitudeDelta);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [locating, setLocating] = useState(false);

  const validVehicles = useMemo(
    () => vehicles.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)),
    [vehicles],
  );

  const clearRoute = useCallback(() => {
    requestRef.current += 1;
    setRoute(null);
    setRouteError(null);
    setRouteLoading(false);
    onSelectStop?.(null);
  }, [onSelectStop]);

  const fitTo = useCallback(
    (coordinates) => {
      if (!coordinates.length || !mapRef.current) return;
      // The chrome floats over the map, so the padding has to match what is
      // actually covering the edges rather than a guess.
      mapRef.current.fitToCoordinates?.(coordinates, {
        edgePadding: {
          top: topOffset + space.xxl,
          right: space.xxl,
          bottom: bottomOffset + space.xxl,
          left: space.xxl,
        },
        animated: true,
      });
    },
    [topOffset, bottomOffset],
  );

  const selectVehicle = useCallback(
    async (vehicle) => {
      if (route?.line === vehicle.line) {
        clearRoute();
        return;
      }

      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setRouteLoading(true);
      setRouteError(null);

      try {
        const data = await fetchShape(vehicle.line, { lat: vehicle.lat, lon: vehicle.lon });
        // A slower earlier request must not overwrite a newer selection.
        if (requestRef.current !== requestId) return;

        const coordinates = toCoordinates(data.points);
        setRoute({
          line: data.line ?? vehicle.line,
          type: vehicle.type,
          direction: data.direction,
          tint: colorForType(vehicle.type),
          coordinates,
          stops: toStops(data.stops),
        });
        fitTo(coordinates);
      } catch (error) {
        if (requestRef.current === requestId) {
          setRouteError(error.message ?? "Nie udało się wczytać trasy.");
        }
      } finally {
        if (requestRef.current === requestId) setRouteLoading(false);
      }
    },
    [clearRoute, fitTo, route],
  );

  /**
   * Recentre on the user. The platform's own button is Android-only and lands
   * in the corner our chrome already occupies, so the app draws its own.
   */
  const locate = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      mapRef.current?.animateToRegion?.(
        {
          latitude: coords.latitude,
          longitude: coords.longitude,
          latitudeDelta: 0.012,
          longitudeDelta: 0.012,
        },
        450,
      );
    } catch {
      // Permission can be revoked between launch and the tap; nothing useful
      // to say, and the map is still where it was.
    } finally {
      setLocating(false);
    }
  }, [locating]);

  const showStopLabels = zoomDelta < STOP_LABEL_MAX_DELTA;

  return (
    <View style={styles.container}>
      <Maps
        ref={mapRef}
        style={style}
        // Uncontrolled: feeding the region back on every pan fought the user's
        // gestures and made the map stutter.
        initialRegion={initialRegion}
        onRegionChangeComplete={(region) => setZoomDelta(region.latitudeDelta)}
        showsUserLocation={showsUserLocation}
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale={false}
        showsIndoors={false}
        toolbarEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        onPress={clearRoute}
      >
        {route && route.coordinates.length > 1 && (
          <Polyline
            coordinates={route.coordinates}
            strokeColor={route.tint}
            strokeWidth={5}
            lineJoin="round"
            lineCap="round"
            zIndex={1}
          />
        )}

        {route?.stops.map((stop) => (
          <StopMarker
            key={`stop-${stop.id}`}
            stop={stop}
            tint={stop.id === selectedStopId ? color.amber : route.tint}
            selected={stop.id === selectedStopId}
            showLabel={showStopLabels}
            onPress={onSelectStop}
          />
        ))}

        {validVehicles.map((vehicle) => (
          <VehicleMarker
            key={vehicle.id ?? `${vehicle.line}-${vehicle.lat}-${vehicle.lon}`}
            vehicle={vehicle}
            dimmed={Boolean(route) && route.line !== vehicle.line}
            onPress={selectVehicle}
          />
        ))}
      </Maps>

      {(route || routeLoading || routeError) && (
        <View style={[styles.bannerWrapper, { top: topOffset }]} pointerEvents="box-none">
          <Material style={styles.banner}>
            {routeLoading ? (
              <View style={styles.bannerRow}>
                <ActivityIndicator size="small" color={color.rail} />
                <Text style={styles.bannerTitle}>Wczytywanie trasy…</Text>
              </View>
            ) : routeError ? (
              <View style={styles.bannerRow}>
                <Text style={[styles.bannerTitle, styles.bannerError]}>{routeError}</Text>
              </View>
            ) : (
              <View style={styles.bannerRow}>
                <LineBadge line={route.line} type={route.type} size="md" />
                <View style={styles.bannerText}>
                  <Text style={styles.bannerTitle} numberOfLines={1}>
                    {route.direction ?? `Linia ${route.line}`}
                  </Text>
                  <Text style={styles.bannerSubtitle} numberOfLines={1}>
                    {`${route.stops.length} przystanków · dotknij przystanku`}
                  </Text>
                </View>
                <PressableScale
                  onPress={clearRoute}
                  hitSlop={10}
                  style={styles.bannerClose}
                  accessibilityRole="button"
                  accessibilityLabel="Ukryj trasę"
                >
                  <X size={16} color={color.textMuted} strokeWidth={2.5} />
                </PressableScale>
              </View>
            )}
          </Material>
        </View>
      )}

      {/* Hidden while the departures sheet is up: it occupies the same corner. */}
      {showsUserLocation && !selectedStopId && (
        <View style={[styles.locateWrapper, { bottom: bottomOffset }]} pointerEvents="box-none">
          <PressableScale
            onPress={locate}
            scale={0.9}
            feedback="light"
            accessibilityRole="button"
            accessibilityLabel="Pokaż moją lokalizację"
          >
            <Material style={styles.locate}>
              {locating ? (
                <ActivityIndicator size="small" color={color.rail} />
              ) : (
                <LocateFixed size={20} color={color.rail} strokeWidth={2.2} />
              )}
            </Material>
          </PressableScale>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  vehicle: { alignItems: "center", justifyContent: "center", padding: 4 },
  vehicleDimmed: { opacity: 0.35 },
  // A hairline of white around the badge keeps the number readable where the
  // map underneath happens to be the same colour as the line.
  vehicleBadge: {
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.9)",
    ...shadow.chip,
  },
  stopWrapper: { alignItems: "center" },
  stopDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: color.paper,
    borderWidth: 3,
    ...shadow.chip,
  },
  stopDotSelected: { width: 18, height: 18, borderRadius: 9, borderColor: color.paper },
  stopLabel: {
    marginTop: 4,
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 130,
    borderWidth: hairline,
    borderColor: color.separator,
    ...shadow.chip,
  },
  stopLabelText: { ...type.caption, fontWeight: "700", color: color.text },

  bannerWrapper: { position: "absolute", left: space.md, right: space.md, alignItems: "center" },
  banner: {
    width: "100%",
    maxWidth: layout.maxContentWidth,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderWidth: hairline,
    borderColor: "rgba(255, 255, 255, 0.55)",
    ...shadow.float,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  bannerText: { flex: 1 },
  bannerTitle: { ...type.callout, fontFamily: font.dataMedium, fontSize: 16, color: color.text },
  bannerError: { color: color.disruption, flex: 1 },
  bannerSubtitle: { ...type.footnote, color: color.textMuted, marginTop: 1 },
  bannerClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.fill,
  },

  locateWrapper: { position: "absolute", right: space.md, alignItems: "flex-end" },
  locate: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: hairline,
    borderColor: "rgba(255, 255, 255, 0.55)",
    ...shadow.float,
  },
});
