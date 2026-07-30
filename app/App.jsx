import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Bell, Settings, TramFront } from "lucide-react-native";

import MapView from "./components/MapView";
import InfoBox from "./components/InfoBox";
import LinesSelection from "./modals/LinesSelection";
import SettingsModal from "./modals/SettingsModal";
import AlertsModal from "./modals/AlertsModal";
import { fetchAlerts, fetchLines, fetchVehicles } from "./api";

const VEHICLE_REFRESH_MS = 10_000;
const ALERT_REFRESH_MS = 5 * 60_000;
const STORAGE_KEY = "selectedLines";

const INITIAL_REGION = {
  latitude: 51.107885,
  longitude: 17.038538,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

export default function App() {
  const [lines, setLines] = useState(null);
  const [linesError, setLinesError] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesError, setVehiclesError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [selectedLines, setSelectedLines] = useState([]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [followUser, setFollowUser] = useState(false);

  const [linesSelectionVisible, setLinesSelectionVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [alertsVisible, setAlertsVisible] = useState(false);

  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState(null);
  const seenAlertsRef = useRef(new Set());
  const [unreadAlerts, setUnreadAlerts] = useState(0);

  // Restore the user's lines before the first render that could overwrite them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const stored = raw ? JSON.parse(raw) : [];
        if (!cancelled && Array.isArray(stored)) setSelectedLines(stored);
      } catch {
        // A corrupt value should not stop the app from starting.
      } finally {
        if (!cancelled) setPreferencesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Skip the very first run, otherwise an empty array overwrites the
    // preferences that are still being read from storage.
    if (!preferencesLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLines)).catch(() => {});
  }, [selectedLines, preferencesLoaded]);

  const loadLines = useCallback(async () => {
    try {
      setLinesError(null);
      setLines(await fetchLines());
    } catch (error) {
      setLinesError(error.message);
    }
  }, []);

  useEffect(() => {
    loadLines();
  }, [loadLines]);

  // Retry line loading while the server is still building its indexes.
  useEffect(() => {
    if (!linesError) return undefined;
    const timer = setTimeout(loadLines, 10_000);
    return () => clearTimeout(timer);
  }, [linesError, loadLines]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await fetchVehicles();
        if (cancelled) return;
        setVehicles(Array.isArray(data?.locations) ? data.locations : []);
        setLastUpdated(data?.lastUpdated ?? null);
        setVehiclesError(null);
      } catch (error) {
        if (!cancelled) setVehiclesError(error.message);
      }
    };

    load();
    const interval = setInterval(load, VEHICLE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // Always ask for the full list: the server returns the current set of
        // alerts, and asking for "everything newer than now" (as this used to)
        // simply returns nothing.
        const data = await fetchAlerts();
        if (cancelled) return;
        const items = Array.isArray(data?.alerts) ? data.alerts : [];
        setAlerts(items);
        setAlertsError(null);

        const seen = seenAlertsRef.current;
        setUnreadAlerts(items.filter((alert) => !seen.has(alert.id)).length);
      } catch (error) {
        if (!cancelled) setAlertsError(error.message);
      } finally {
        if (!cancelled) setAlertsLoading(false);
      }
    };

    load();
    const interval = setInterval(load, ALERT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // The map only shows the blue "you are here" dot once permission is granted;
  // previously it was switched on without ever asking, so it never appeared.
  useEffect(() => {
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => setFollowUser(status === "granted"))
      .catch(() => setFollowUser(false));
  }, []);

  const openAlerts = () => {
    alerts.forEach((alert) => seenAlertsRef.current.add(alert.id));
    setUnreadAlerts(0);
    setAlertsVisible(true);
  };

  const selectedSet = useMemo(() => new Set(selectedLines), [selectedLines]);
  const visibleVehicles = useMemo(
    () => vehicles.filter((vehicle) => selectedSet.has(vehicle.line)),
    [vehicles, selectedSet],
  );

  const status = linesError ?? vehiclesError;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View style={styles.container}>
          <MapView
            style={styles.map}
            initialRegion={INITIAL_REGION}
            vehicles={visibleVehicles}
            showsUserLocation={followUser}
          />

          <SafeAreaView style={styles.overlay} pointerEvents="box-none" edges={["top"]}>
            <InfoBox
              lastUpdated={lastUpdated}
              vehicleCount={visibleVehicles.length}
              totalCount={vehicles.length}
              error={status}
            />
          </SafeAreaView>

          {lines === null && !linesError && (
            <View style={styles.centerCard} pointerEvents="none">
              <ActivityIndicator color="#fff" />
              <Text style={styles.centerText}>Wczytywanie linii…</Text>
            </View>
          )}

          {preferencesLoaded && selectedLines.length === 0 && lines !== null && (
            <TouchableOpacity
              style={styles.emptyCard}
              onPress={() => setLinesSelectionVisible(true)}
              activeOpacity={0.85}
            >
              <TramFront size={22} color="#fff" />
              <Text style={styles.emptyText}>
                Wybierz linie, które chcesz śledzić na mapie
              </Text>
            </TouchableOpacity>
          )}

          <LinesSelection
            lines={lines ?? {}}
            selectedLines={selectedLines}
            setSelectedLines={setSelectedLines}
            visible={linesSelectionVisible}
            onClose={() => setLinesSelectionVisible(false)}
          />

          <SettingsModal
            visible={settingsVisible}
            onClose={() => setSettingsVisible(false)}
            selectedCount={selectedLines.length}
            onClearLines={() => setSelectedLines([])}
          />

          <AlertsModal
            visible={alertsVisible}
            onClose={() => setAlertsVisible(false)}
            alerts={alerts}
            loading={alertsLoading}
            error={alertsError}
          />

          <SafeAreaView style={styles.navigationWrapper} pointerEvents="box-none" edges={["bottom"]}>
            <View style={styles.navigationBar}>
              <TouchableOpacity
                onPress={() => setLinesSelectionVisible(true)}
                style={styles.button}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Wybierz linie"
              >
                <TramFront size={26} color="#fff" />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={openAlerts}
                style={styles.button}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Komunikaty${unreadAlerts ? `, ${unreadAlerts} nowych` : ""}`}
              >
                <Bell size={26} color="#fff" />
                {unreadAlerts > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {unreadAlerts > 9 ? "9+" : unreadAlerts}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setSettingsVisible(true)}
                style={styles.button}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Ustawienia"
              >
                <Settings size={26} color="#fff" />
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: "#0B1020" },
  map: { ...StyleSheet.absoluteFillObject },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  centerCard: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(11, 16, 32, 0.85)",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 14,
  },
  centerText: { color: "#fff", fontSize: 14 },
  emptyCard: {
    position: "absolute",
    bottom: 110,
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0, 117, 255, 0.94)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  emptyText: { color: "#fff", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  navigationWrapper: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingBottom: 16,
  },
  navigationBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: "rgba(6, 5, 34, 0.92)",
    borderRadius: 32,
    paddingVertical: 8,
    paddingHorizontal: 10,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  button: {
    backgroundColor: "#0075FF",
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    width: 52,
    height: 52,
  },
  badge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: "#E85D75",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
});
