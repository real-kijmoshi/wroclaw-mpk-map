import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as SplashScreen from "expo-splash-screen";
import {
  BarlowSemiCondensed_600SemiBold,
  BarlowSemiCondensed_700Bold,
  useFonts,
} from "@expo-google-fonts/barlow-semi-condensed";
import { Bell, Settings, TramFront } from "lucide-react-native";

import MapView from "./components/MapView";
import StatusPill from "./components/StatusPill";
import DeparturesSheet from "./components/DeparturesSheet";
import LinesSelection from "./modals/LinesSelection";
import SettingsModal from "./modals/SettingsModal";
import AlertsModal from "./modals/AlertsModal";
import { fetchAlerts, fetchLines, fetchVehicles, normaliseLines } from "./api";
import { color, radius, shadow, space, type } from "./theme";

const VEHICLE_REFRESH_MS = 10_000;
const ALERT_REFRESH_MS = 5 * 60_000;
const STORAGE_KEY = "selectedLines";

const INITIAL_REGION = {
  latitude: 51.107885,
  longitude: 17.038538,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsLoaded] = useFonts({
    BarlowSemiCondensed_600SemiBold,
    BarlowSemiCondensed_700Bold,
  });

  const [lines, setLines] = useState(null);
  const [linesError, setLinesError] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [selectedLines, setSelectedLines] = useState([]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [followUser, setFollowUser] = useState(false);
  const [selectedStop, setSelectedStop] = useState(null);

  const [linesSelectionVisible, setLinesSelectionVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [alertsVisible, setAlertsVisible] = useState(false);

  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState(null);
  const seenAlertsRef = useRef(new Set());
  const [unreadAlerts, setUnreadAlerts] = useState(0);

  // Restore the user's lines before anything can overwrite them.
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
    // Skip the first run, otherwise an empty array overwrites the preferences
    // that are still being read from storage.
    if (!preferencesLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(selectedLines)).catch(() => {});
  }, [selectedLines, preferencesLoaded]);

  const loadLines = useCallback(async () => {
    try {
      setLinesError(null);
      // apiGet already waits out the 503 the server returns while it ingests
      // the feed; this guards against a payload that is not the line index.
      const payload = normaliseLines(await fetchLines());
      if (!payload) throw new Error("Nieoczekiwana odpowiedź serwera.");
      setLines(payload);
    } catch (error) {
      setLinesError(error.message ?? "Nie udało się wczytać linii.");
    }
  }, []);

  useEffect(() => {
    loadLines();
  }, [loadLines]);

  useEffect(() => {
    if (!linesError) return undefined;
    const timer = setTimeout(loadLines, 15_000);
    return () => clearTimeout(timer);
  }, [linesError, loadLines]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await fetchVehicles({ retries: 1 });
        if (cancelled) return;
        setVehicles(Array.isArray(data?.locations) ? data.locations : []);
        setLastUpdated(data?.lastUpdated ? Date.parse(data.lastUpdated) : null);
      } catch {
        // Keep the last snapshot; StatusPill shows that it has gone stale.
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
        // Always ask for the full list: asking for "everything newer than now",
        // as this once did, returns nothing every time.
        const data = await fetchAlerts({ retries: 1 });
        if (cancelled) return;
        const items = Array.isArray(data?.alerts) ? data.alerts : [];
        setAlerts(items);
        setAlertsError(null);
        setUnreadAlerts(items.filter((alert) => !seenAlertsRef.current.has(alert.id)).length);
      } catch (error) {
        if (!cancelled) setAlertsError(error.message ?? "Nie udało się pobrać komunikatów.");
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
  // it used to be switched on without ever asking, so it never appeared.
  useEffect(() => {
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => setFollowUser(status === "granted"))
      .catch(() => setFollowUser(false));
  }, []);

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

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

  // Alerts touching a line you follow matter more than the rest.
  const rankedAlerts = useMemo(() => {
    const relevant = (alert) => alert.affected?.some((line) => selectedSet.has(line));
    return [...alerts].sort((a, b) => Number(relevant(b)) - Number(relevant(a)));
  }, [alerts, selectedSet]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.container}>
          <MapView
            style={styles.map}
            initialRegion={INITIAL_REGION}
            vehicles={visibleVehicles}
            showsUserLocation={followUser}
            onSelectStop={setSelectedStop}
            selectedStopId={selectedStop?.id}
          />

          <SafeAreaView style={styles.top} pointerEvents="box-none" edges={["top"]}>
            <StatusPill
              lastUpdated={lastUpdated}
              vehicleCount={visibleVehicles.length}
              lineCount={selectedLines.length}
              onPress={() => setLinesSelectionVisible(true)}
              style={styles.statusPill}
            />
          </SafeAreaView>

          {lines === null && !linesError && (
            <View style={styles.centreCard} pointerEvents="none">
              <ActivityIndicator color={color.rail} />
              <Text style={styles.centreText}>Wczytywanie rozkładów…</Text>
            </View>
          )}

          {linesError && (
            <Pressable style={styles.errorCard} onPress={loadLines}>
              <Text style={styles.errorText}>{linesError}</Text>
              <Text style={styles.errorHint}>Dotknij, aby spróbować ponownie</Text>
            </Pressable>
          )}

          {preferencesLoaded && lines !== null && selectedLines.length === 0 && (
            <Pressable
              style={styles.emptyCard}
              onPress={() => setLinesSelectionVisible(true)}
              accessibilityRole="button"
            >
              <TramFront size={20} color={color.paper} />
              <Text style={styles.emptyText}>Wybierz linie, które chcesz śledzić</Text>
            </Pressable>
          )}

          <DeparturesSheet stop={selectedStop} onClose={() => setSelectedStop(null)} />

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
            alerts={rankedAlerts}
            followedLines={selectedSet}
            loading={alertsLoading}
            error={alertsError}
          />

          <SafeAreaView style={styles.bottom} pointerEvents="box-none" edges={["bottom"]}>
            <View style={styles.tabBar}>
              <TabButton
                label="Linie"
                onPress={() => setLinesSelectionVisible(true)}
                icon={<TramFront size={22} color={color.text} />}
              />
              <TabButton
                label="Komunikaty"
                onPress={openAlerts}
                badge={unreadAlerts}
                icon={<Bell size={22} color={color.text} />}
              />
              <TabButton
                label="Ustawienia"
                onPress={() => setSettingsVisible(true)}
                icon={<Settings size={22} color={color.text} />}
              />
            </View>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function TabButton({ label, icon, onPress, badge = 0 }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} nowych` : label}
    >
      <View>
        {icon}
        {badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
          </View>
        )}
      </View>
      <Text style={styles.tabLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: color.paperMuted },
  map: { ...StyleSheet.absoluteFillObject },
  top: { position: "absolute", top: 0, left: 0, right: 0 },
  statusPill: { top: space.sm },
  centreCard: {
    position: "absolute",
    alignSelf: "center",
    top: "45%",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.paper,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    borderRadius: radius.md,
    ...shadow.chip,
  },
  centreText: { ...type.small, color: color.textMuted },
  errorCard: {
    position: "absolute",
    top: "45%",
    left: space.xl,
    right: space.xl,
    alignItems: "center",
    gap: space.xs,
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderRadius: radius.md,
    ...shadow.chip,
  },
  errorText: { ...type.body, color: color.disruption, textAlign: "center" },
  errorHint: { ...type.small, color: color.textMuted },
  emptyCard: {
    position: "absolute",
    bottom: 108,
    left: space.md,
    right: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    backgroundColor: color.rail,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    ...shadow.chip,
  },
  emptyText: { ...type.body, color: color.paper },
  bottom: { position: "absolute", bottom: 0, left: 0, right: 0 },
  tabBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.paperLine,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  tab: { alignItems: "center", gap: 2, paddingHorizontal: space.lg, paddingVertical: space.xs },
  tabLabel: { ...type.caption, color: color.textMuted, textTransform: "none" },
  badge: {
    position: "absolute",
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: color.disruption,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
});
