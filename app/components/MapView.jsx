import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Maps, { Marker, Polyline } from "react-native-maps";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { LocateFixed, X } from "lucide-react-native";

import LineBadge from "./LineBadge";
import { fetchShape, toCoordinates, toStops } from "../api";
import { color, colorForType, font, layout, radius, shadow, space, type } from "../theme";

/** Below this zoom every stop label would overlap, so they are hidden. */
const STOP_LABEL_MAX_DELTA = 0.03;

/** A tap that changes what is on the map is worth a tick. Never fails loudly. */
const tap = (style = Haptics.ImpactFeedbackStyle.Light) =>
  Haptics.impactAsync(style).catch(() => {});

// Both marker types are memoised: vehicle positions refresh every 10 seconds,
// and without this every marker on screen re-rendered on each poll even though
// almost none of them had moved.
const VehicleMarker = memo(function VehicleMarker({ vehicle, dimmed, onPress }) {
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
});

const StopMarker = memo(function StopMarker({ stop, tint, selected, showLabel, onPress }) {
  return (
    <Marker
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(stop)}
      // The selected stop has to redraw when the tint changes; the rest never do.
      tracksViewChanges={selected}
      zIndex={selected ? 2 : 1}
      accessibilityLabel={`Przystanek ${stop.name}`}
    >
      <View style={styles.stopWrapper}>
        <View style={[styles.stopDot, selected && styles.stopDotSelected, { borderColor: tint }]} />
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

export default function MapView({
  style,
  initialRegion,
  vehicles,
  showsUserLocation,
  onSelectStop,
  selectedStopId,
}) {
  const insets = useSafeAreaInsets();
  const mapRef = useRef(null);
  const requestRef = useRef(0);
  // Mirrors `route.line` so the marker callbacks below can stay referentially
  // stable — rebuilding them on every route change defeats the memo above.
  const routeLineRef = useRef(null);
  const [zoomDelta, setZoomDelta] = useState(initialRegion.latitudeDelta);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);

  const validVehicles = useMemo(
    () => vehicles.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)),
    [vehicles],
  );

  const applyRoute = useCallback((next) => {
    routeLineRef.current = next?.line ?? null;
    setRoute(next);
  }, []);

  const clearRoute = useCallback(() => {
    requestRef.current += 1;
    applyRoute(null);
    setRouteError(null);
    setRouteLoading(false);
    onSelectStop?.(null);
  }, [applyRoute, onSelectStop]);

  const fitTo = useCallback((coordinates) => {
    if (!coordinates.length || !mapRef.current) return;
    mapRef.current.fitToCoordinates(coordinates, {
      edgePadding: { top: 140, right: 60, bottom: 260, left: 60 },
      animated: true,
    });
  }, []);

  const selectVehicle = useCallback(
    async (vehicle) => {
      tap();
      if (routeLineRef.current === vehicle.line) {
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
        applyRoute({
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
    [applyRoute, clearRoute, fitTo],
  );

  const selectStop = useCallback(
    (stop) => {
      tap(Haptics.ImpactFeedbackStyle.Soft);
      onSelectStop?.(stop);
    },
    [onSelectStop],
  );

  // iOS has no equivalent of Android's built-in my-location button, so on that
  // platform there was no way back to yourself after panning away.
  const recentre = useCallback(async () => {
    tap();
    try {
      const position =
        (await Location.getLastKnownPositionAsync()) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!position || !mapRef.current) return;
      mapRef.current.animateToRegion(
        {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        },
        450,
      );
    } catch {
      // Location can be off or refused between the permission check and now.
    }
  }, []);

  const showStopLabels = zoomDelta < STOP_LABEL_MAX_DELTA;
  const bannerTop = insets.top + space.sm + layout.statusPill + space.sm;

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
            selected={stop.id === selectedStopId}
            tint={stop.id === selectedStopId ? color.amber : route.tint}
            showLabel={showStopLabels}
            onPress={selectStop}
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

      {/* Hidden while the departures sheet is up — it occupies this corner. */}
      {showsUserLocation && !selectedStopId && (
        <Pressable
          onPress={recentre}
          style={({ pressed }) => [
            styles.recentre,
            { bottom: layout.tabBar + insets.bottom + space.md },
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Pokaż moją lokalizację"
        >
          <LocateFixed size={20} color={color.rail} strokeWidth={2} />
        </Pressable>
      )}

      {(route || routeLoading || routeError) && (
        <View style={[styles.banner, { top: bannerTop }]}>
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
              <View style={styles.bannerText}>
                <Text style={styles.bannerTitle} numberOfLines={1}>
                  {route.direction ?? `Linia ${route.line}`}
                </Text>
                {/* Kept short on purpose: the long form ("dotknij, aby
                    zobaczyć odjazdy") ran past the close button and ellipsised
                    away the part that says what to do. */}
                <Text style={styles.bannerSubtitle} numberOfLines={1}>
                  {`${route.stops.length} ${plural(route.stops.length)} · dotknij przystanek`}
                </Text>
              </View>
              <Pressable
                onPress={clearRoute}
                hitSlop={10}
                style={({ pressed }) => [styles.bannerClose, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Ukryj trasę"
              >
                <X size={18} color={color.textMuted} />
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** Polish counts take three forms: 1 przystanek, 2-4 przystanki, 5+ przystanków. */
function plural(count) {
  if (count === 1) return "przystanek";
  const last = count % 10;
  const teen = count % 100 >= 12 && count % 100 <= 14;
  return !teen && last >= 2 && last <= 4 ? "przystanki" : "przystanków";
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  pressed: { opacity: 0.6 },
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
  stopDotSelected: { width: 20, height: 20, borderRadius: 10, borderWidth: 4 },
  stopLabel: {
    marginTop: 3,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 120,
  },
  stopLabelText: { ...type.caption, fontWeight: "700", color: color.text },
  recentre: {
    position: "absolute",
    right: space.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.paper,
    ...shadow.chip,
  },
  // `top` is supplied at render time so the banner clears the status pill,
  // which itself sits below whatever notch the device has.
  banner: {
    position: "absolute",
    left: space.md,
    right: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    ...shadow.chip,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  bannerText: { flex: 1 },
  bannerTitle: { ...type.body, fontFamily: font.dataMedium, fontSize: 16, color: color.text },
  bannerSubtitle: { ...type.small, color: color.textMuted, marginTop: 2 },
  bannerClose: { padding: space.xs },
});
