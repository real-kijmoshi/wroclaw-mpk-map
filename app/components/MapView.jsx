import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** The same colour, faded — react-native-maps has no stroke opacity of its own. */
const fade = (hex, alpha) => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(value)) return hex;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/** How long a marker keeps redrawing after its appearance changes. */
const MARKER_TRACK_MS = 300;

/**
 * A marker with a custom view keeps the first snapshot it took while
 * `tracksViewChanges` is false — which is what makes hundreds of them
 * affordable, and also means a style change never appears on screen. This
 * turns tracking back on for a beat whenever `look` changes, and off again
 * once the new appearance has been captured.
 */
function useMarkerRedraw(look) {
  const [tracking, setTracking] = useState(true);

  useEffect(() => {
    setTracking(true);
    const timer = setTimeout(() => setTracking(false), MARKER_TRACK_MS);
    return () => clearTimeout(timer);
  }, [look]);

  return tracking;
}

function VehicleMarker({ vehicle, dimmed, selected, onPress }) {
  const towards = vehicle.trip?.towards ?? vehicle.trip?.headsign ?? null;
  const tracking = useMarkerRedraw(`${dimmed}-${selected}`);

  return (
    <Marker
      coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(vehicle)}
      tracksViewChanges={tracking}
      accessibilityLabel={towards ? `Linia ${vehicle.line} do ${towards}` : `Linia ${vehicle.line}`}
    >
      <View style={[styles.vehicle, dimmed && styles.vehicleDimmed]}>
        <LineBadge
          line={vehicle.line}
          type={vehicle.type}
          size="sm"
          style={[styles.vehicleBadge, selected && styles.vehicleBadgeSelected]}
        />
      </View>
    </Marker>
  );
}

function StopMarker({ stop, tint, selected, next, showLabel, onPress }) {
  const tracking = useMarkerRedraw(`${tint}-${selected}-${next}-${showLabel}`);

  return (
    <Marker
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(stop)}
      tracksViewChanges={tracking}
      accessibilityLabel={next ? `Następny przystanek ${stop.name}` : `Przystanek ${stop.name}`}
    >
      <View style={styles.stopWrapper}>
        <View
          style={[
            styles.stopDot,
            { borderColor: tint },
            // The stop the selected vehicle is heading for, filled so it reads
            // as the next thing to happen rather than one dot among thirty.
            next && [styles.stopDotNext, { backgroundColor: tint }],
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
  onSelectVehicle,
  selectedVehicleId,
  vehicleTrip,
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
    onSelectVehicle?.(null);
  }, [onSelectStop, onSelectVehicle]);

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
      if (selectedVehicleId === vehicle.id) {
        clearRoute();
        return;
      }

      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setRouteLoading(true);
      setRouteError(null);
      onSelectVehicle?.(vehicle);

      try {
        const data = await fetchShape(vehicle.line, {
          lat: vehicle.lat,
          lon: vehicle.lon,
          // Without this the server answers with whichever direction happens to
          // be nearer, and the route drawn is the one going the other way.
          heading: vehicle.heading,
        });
        // A slower earlier request must not overwrite a newer selection.
        if (requestRef.current !== requestId) return;

        const coordinates = toCoordinates(data.points);
        setRoute({
          line: data.line ?? vehicle.line,
          shapeId: data.shapeId ?? null,
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
    [clearRoute, fitTo, onSelectVehicle, selectedVehicleId],
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

  const selectedVehicle = useMemo(
    () => validVehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [validVehicles, selectedVehicleId],
  );

  // Live summary from /locations if the detail has not arrived yet: both carry
  // the destination and the next stop, and the list is refreshed anyway.
  const trip = vehicleTrip ?? selectedVehicle?.trip ?? null;

  // Where along the drawn shape the vehicle is, so the part already travelled
  // can be drawn faded. Only meaningful when the detail describes the same
  // variant the map is showing — otherwise the split lands anywhere.
  const travelledTo =
    route && vehicleTrip?.shapeId === route.shapeId && Number.isFinite(vehicleTrip?.shapeIndex)
      ? Math.min(Math.max(vehicleTrip.shapeIndex, 0), route.coordinates.length - 1)
      : null;

  const nextStopId = trip?.nextStop?.id ?? null;

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
            coordinates={travelledTo === null ? route.coordinates : route.coordinates.slice(travelledTo)}
            strokeColor={route.tint}
            strokeWidth={5}
            lineJoin="round"
            lineCap="round"
            zIndex={1}
          />
        )}

        {/* The road already behind the vehicle, kept for context but quiet. */}
        {route && travelledTo > 0 && (
          <Polyline
            coordinates={route.coordinates.slice(0, travelledTo + 1)}
            strokeColor={fade(route.tint, 0.28)}
            strokeWidth={5}
            lineJoin="round"
            lineCap="round"
            zIndex={0}
          />
        )}

        {route?.stops.map((stop) => (
          <StopMarker
            key={`stop-${stop.id}`}
            stop={stop}
            tint={stop.id === selectedStopId ? color.amber : route.tint}
            selected={stop.id === selectedStopId}
            next={stop.id === nextStopId}
            showLabel={showStopLabels || stop.id === nextStopId}
            onPress={onSelectStop}
          />
        ))}

        {validVehicles.map((vehicle) => (
          <VehicleMarker
            key={vehicle.id ?? `${vehicle.line}-${vehicle.lat}-${vehicle.lon}`}
            vehicle={vehicle}
            dimmed={Boolean(route) && route.line !== vehicle.line}
            selected={vehicle.id === selectedVehicleId}
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
                    {trip?.direction ?? route.direction ?? `Linia ${route.line}`}
                  </Text>
                  <Text style={styles.bannerSubtitle} numberOfLines={1}>
                    {progressLine(trip) ?? `${route.stops.length} przystanków · dotknij przystanku`}
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

      {/* Hidden while a sheet is up: they occupy the same corner. */}
      {showsUserLocation && !selectedStopId && !selectedVehicleId && (
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

/**
 * The live half of the banner: where the selected vehicle is going next, and
 * whether it is running to time. Null when nothing is known, so the caller can
 * fall back to describing the route itself.
 */
function progressLine(trip) {
  if (!trip?.nextStop) return null;

  const parts = [];
  const minutes = Math.round((trip.nextStop.etaSeconds ?? 0) / 60);
  parts.push(
    minutes <= 0
      ? `Dojeżdża do: ${trip.nextStop.name}`
      : `Następny: ${trip.nextStop.name} · ${minutes} min`,
  );

  const delayMinutes = Math.round((trip.delaySeconds ?? 0) / 60);
  if (trip.delaySeconds !== null && trip.delaySeconds !== undefined && delayMinutes >= 1) {
    parts.push(`spóźniony ${delayMinutes} min`);
  }

  return parts.join(" · ");
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
  vehicleBadgeSelected: { borderWidth: 2.5, borderColor: color.paper, ...shadow.float },
  stopWrapper: { alignItems: "center" },
  stopDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: color.paper,
    borderWidth: 3,
    ...shadow.chip,
  },
  stopDotNext: { width: 16, height: 16, borderRadius: 8 },
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
