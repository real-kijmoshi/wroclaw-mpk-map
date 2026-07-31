import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Maps, { Marker, Polyline } from "react-native-maps";

import LineBadge from "./LineBadge";
import { fetchShape, toCoordinates, toStops } from "../api";
import { color, colorForType, font, radius, shadow, space, type } from "../theme";

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
        <LineBadge line={vehicle.line} type={vehicle.type} size="sm" />
      </View>
    </Marker>
  );
}

function StopMarker({ stop, tint, showLabel, onPress }) {
  return (
    <Marker
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(stop)}
      tracksViewChanges={false}
      accessibilityLabel={`Przystanek ${stop.name}`}
    >
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
}

export default function MapView({
  style,
  initialRegion,
  vehicles,
  showsUserLocation,
  onSelectStop,
  selectedStopId,
}) {
  const mapRef = useRef(null);
  const requestRef = useRef(0);
  const [zoomDelta, setZoomDelta] = useState(initialRegion.latitudeDelta);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);

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

  const fitTo = useCallback((coordinates) => {
    if (!coordinates.length || !mapRef.current) return;
    mapRef.current.fitToCoordinates(coordinates, {
      edgePadding: { top: 140, right: 60, bottom: 260, left: 60 },
      animated: true,
    });
  }, []);

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
        showsMyLocationButton={showsUserLocation}
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
        <View style={styles.banner}>
          {routeLoading ? (
            <View style={styles.bannerRow}>
              <ActivityIndicator size="small" color={color.rail} />
              <Text style={styles.bannerTitle}>Wczytywanie trasy…</Text>
            </View>
          ) : routeError ? (
            <Text style={styles.bannerTitle}>{routeError}</Text>
          ) : (
            <View style={styles.bannerRow}>
              <LineBadge line={route.line} type={route.type} size="md" />
              <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle} numberOfLines={1}>
                  {route.direction ?? `Linia ${route.line}`}
                </Text>
                <Text style={styles.bannerSubtitle}>
                  {`${route.stops.length} przystanków · dotknij przystanku, aby zobaczyć odjazdy`}
                </Text>
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  vehicle: { alignItems: "center", justifyContent: "center", padding: 4 },
  vehicleDimmed: { opacity: 0.35 },
  stopWrapper: { alignItems: "center" },
  stopDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: color.paper,
    borderWidth: 3,
  },
  stopLabel: {
    marginTop: 3,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 120,
  },
  stopLabelText: { ...type.caption, fontWeight: "700", color: color.text },
  banner: {
    position: "absolute",
    top: 96,
    left: space.md,
    right: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    ...shadow.chip,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  bannerTitle: { ...type.body, fontFamily: font.dataMedium, fontSize: 16, color: color.text },
  bannerSubtitle: { ...type.small, color: color.textMuted, marginTop: 2 },
});
