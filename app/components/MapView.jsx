import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Maps, { Marker, Polyline } from "react-native-maps";

import { fetchDepartures, fetchShape } from "../api";
import { LINE_COLORS } from "../theme";

/** Below this zoom every marker would overlap, so stop pins are hidden. */
const STOP_LABEL_MAX_DELTA = 0.03;

function VehicleMarker({ vehicle, selected, onPress }) {
  const color = LINE_COLORS[vehicle.type] ?? LINE_COLORS.unknown;

  return (
    <Marker
      coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(vehicle)}
      tracksViewChanges={false}
      title={`${vehicle.line}`}
      description={vehicle.heading != null ? `Kierunek ${vehicle.heading}°` : undefined}
    >
      <View style={styles.vehicleWrapper}>
        {vehicle.heading != null && (
          <View
            style={[
              styles.heading,
              { borderBottomColor: color, transform: [{ rotate: `${vehicle.heading}deg` }] },
            ]}
          />
        )}
        <View
          style={[
            styles.marker,
            { backgroundColor: color },
            selected && styles.markerSelected,
          ]}
        >
          <Text style={styles.markerText} numberOfLines={1}>
            {vehicle.line}
          </Text>
        </View>
      </View>
    </Marker>
  );
}

function StopMarker({ stop, color, showLabel, onPress }) {
  return (
    <Marker
      coordinate={{ latitude: stop.lat, longitude: stop.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(stop)}
      tracksViewChanges={false}
      title={stop.name}
    >
      <View style={styles.stopWrapper}>
        <View style={[styles.stopDot, { borderColor: color }]} />
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

export default function MapView({ style, initialRegion, vehicles, showsUserLocation }) {
  const mapRef = useRef(null);
  const [zoomDelta, setZoomDelta] = useState(initialRegion.latitudeDelta);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [stopBoard, setStopBoard] = useState(null);
  const requestRef = useRef(0);

  const validVehicles = useMemo(
    () =>
      vehicles.filter(
        (vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon),
      ),
    [vehicles],
  );

  const clearRoute = useCallback(() => {
    requestRef.current += 1;
    setRoute(null);
    setRouteError(null);
    setRouteLoading(false);
    setStopBoard(null);
  }, []);

  const fitTo = useCallback((coordinates) => {
    if (!coordinates.length || !mapRef.current) return;
    mapRef.current.fitToCoordinates(coordinates, {
      edgePadding: { top: 120, right: 60, bottom: 200, left: 60 },
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
      setStopBoard(null);

      try {
        const data = await fetchShape(vehicle.line, { lat: vehicle.lat, lon: vehicle.lon });
        // A slower earlier request must not overwrite a newer selection.
        if (requestRef.current !== requestId) return;

        const coordinates = (data.points ?? []).map(([latitude, longitude]) => ({
          latitude,
          longitude,
        }));

        setRoute({
          line: data.line ?? vehicle.line,
          direction: data.direction,
          color: LINE_COLORS[vehicle.type] ?? LINE_COLORS.unknown,
          coordinates,
          stops: data.stops ?? [],
        });
        fitTo(coordinates);
      } catch (error) {
        if (requestRef.current === requestId) setRouteError(error.message);
      } finally {
        if (requestRef.current === requestId) setRouteLoading(false);
      }
    },
    [clearRoute, fitTo, route],
  );

  const selectStop = useCallback(async (stop) => {
    setStopBoard({ stop, departures: null, error: null });
    try {
      const data = await fetchDepartures(stop.id);
      setStopBoard({ stop, departures: data.departures ?? [], error: null });
    } catch (error) {
      setStopBoard({ stop, departures: [], error: error.message });
    }
  }, []);

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
            strokeColor={route.color}
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
            color={route.color}
            showLabel={showStopLabels}
            onPress={selectStop}
          />
        ))}

        {validVehicles.map((vehicle) => (
          <VehicleMarker
            key={vehicle.id ?? `${vehicle.line}-${vehicle.lat}-${vehicle.lon}`}
            vehicle={vehicle}
            selected={route?.line === vehicle.line}
            onPress={selectVehicle}
          />
        ))}
      </Maps>

      {(route || routeLoading || routeError) && (
        <View style={styles.banner}>
          {routeLoading ? (
            <View style={styles.bannerRow}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.bannerTitle}>Wczytywanie trasy…</Text>
            </View>
          ) : routeError ? (
            <Text style={styles.bannerTitle}>{routeError}</Text>
          ) : (
            <>
              <Text style={styles.bannerTitle}>
                {`Linia ${route.line}${route.direction ? ` — ${route.direction}` : ""}`}
              </Text>
              <Text style={styles.bannerSubtitle}>
                {`${route.stops.length} przystanków • dotknij mapy, aby ukryć`}
              </Text>
            </>
          )}
        </View>
      )}

      {stopBoard && (
        <View style={styles.board}>
          <View style={styles.boardHeader}>
            <Text style={styles.boardTitle} numberOfLines={1}>
              {stopBoard.stop.name}
            </Text>
            <TouchableOpacity onPress={() => setStopBoard(null)} hitSlop={12}>
              <Text style={styles.boardClose}>Zamknij</Text>
            </TouchableOpacity>
          </View>

          {stopBoard.departures === null ? (
            <ActivityIndicator color="#fff" />
          ) : stopBoard.error ? (
            <Text style={styles.boardEmpty}>{stopBoard.error}</Text>
          ) : stopBoard.departures.length === 0 ? (
            <Text style={styles.boardEmpty}>Brak odjazdów w ciągu najbliższych 2 godzin.</Text>
          ) : (
            stopBoard.departures.slice(0, 6).map((departure) => (
              <View key={`${departure.tripId}-${departure.departure}`} style={styles.boardRow}>
                <View
                  style={[
                    styles.boardBadge,
                    { backgroundColor: LINE_COLORS[departure.type] ?? LINE_COLORS.unknown },
                  ]}
                >
                  <Text style={styles.boardBadgeText}>{departure.line}</Text>
                </View>
                <Text style={styles.boardHeadsign} numberOfLines={1}>
                  {departure.headsign ?? ""}
                </Text>
                <Text style={styles.boardTime}>
                  {departure.inSeconds < 60
                    ? "teraz"
                    : `${Math.round(departure.inSeconds / 60)} min`}
                </Text>
              </View>
            ))
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  vehicleWrapper: { alignItems: "center", justifyContent: "center", width: 44, height: 44 },
  heading: {
    position: "absolute",
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 10,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    top: 0,
  },
  marker: {
    minWidth: 30,
    paddingHorizontal: 5,
    height: 26,
    borderRadius: 7,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.85)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 4,
  },
  markerSelected: { borderColor: "#fff", borderWidth: 3 },
  markerText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  stopWrapper: { alignItems: "center" },
  stopDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#fff",
    borderWidth: 3,
  },
  stopLabel: {
    marginTop: 3,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    maxWidth: 110,
  },
  stopLabelText: { fontSize: 10, fontWeight: "600", color: "#222" },
  banner: {
    position: "absolute",
    top: Platform.OS === "ios" ? 96 : 78,
    left: 16,
    right: 16,
    backgroundColor: "rgba(11, 16, 32, 0.92)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  bannerTitle: { color: "#fff", fontSize: 14, fontWeight: "700" },
  bannerSubtitle: { color: "rgba(255,255,255,0.75)", fontSize: 12, marginTop: 2 },
  board: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 96,
    backgroundColor: "rgba(11, 16, 32, 0.96)",
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  boardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  boardTitle: { color: "#fff", fontSize: 16, fontWeight: "700", flexShrink: 1 },
  boardClose: { color: "#4DA3FF", fontSize: 13, fontWeight: "600" },
  boardEmpty: { color: "rgba(255,255,255,0.7)", fontSize: 13 },
  boardRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  boardBadge: {
    minWidth: 34,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    alignItems: "center",
  },
  boardBadgeText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  boardHeadsign: { color: "rgba(255,255,255,0.85)", fontSize: 13, flex: 1 },
  boardTime: { color: "#fff", fontSize: 13, fontWeight: "700" },
});
