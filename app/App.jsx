import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
// Imported as individual files, not from the package root: the barrel re-exports
// all nine weights in both italic and roman, and a `require` of every one of
// them puts ~1.9 MB of TTFs the app never renders into the binary.
import BarlowSemiCondensed_600SemiBold from "@expo-google-fonts/barlow-semi-condensed/600SemiBold/BarlowSemiCondensed_600SemiBold.ttf";
import BarlowSemiCondensed_700Bold from "@expo-google-fonts/barlow-semi-condensed/700Bold/BarlowSemiCondensed_700Bold.ttf";
import { Bell, Settings, TramFront } from "lucide-react-native";

import MapView from "./components/MapView";
import StatusPill from "./components/StatusPill";
import DeparturesSheet from "./components/DeparturesSheet";
import LinesSelection from "./modals/LinesSelection";
import SettingsModal from "./modals/SettingsModal";
import AlertsModal from "./modals/AlertsModal";
import { fetchAlerts, fetchLines, fetchVehicles, normaliseLines } from "./api";
import { color, layout, radius, shadow, space, type } from "./theme";

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
  const [fontsLoaded, fontError] = useFonts({
    BarlowSemiCondensed_600SemiBold,
    BarlowSemiCondensed_700Bold,
  });

  // A font that fails to load must not cost you the whole app. This was
  // `if (!fontsLoaded) return null` with the error discarded, so a rejected
  // load left a blank screen under a splash that never hid — no map, no
  // message, nothing to retry. Barlow is only the departure-board face; without
  // it the numerals fall back to the system font and everything still works.
  const ready = fontsLoaded || Boolean(fontError);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        {ready ? <Screen /> : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Everything below the providers.
 *
 * Split out so it can read the safe-area insets — `useSafeAreaInsets()` only
 * answers inside the provider, and the floating surfaces need the real bottom
 * inset to sit above the tab bar on every device rather than on one of them.
 */
function Screen() {
  const insets = useSafeAreaInsets();

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

  // Top of the tab bar. Everything that floats over the map stacks off this.
  const chromeBottom = layout.tabBar + insets.bottom;

  return (
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
        <Pressable
          style={({ pressed }) => [styles.errorCard, pressed && styles.cardPressed]}
          onPress={loadLines}
          accessibilityRole="button"
        >
          <Text style={styles.errorText}>{linesError}</Text>
          <Text style={styles.errorHint}>Dotknij, aby spróbować ponownie</Text>
        </Pressable>
      )}

      {preferencesLoaded && lines !== null && selectedLines.length === 0 && (
        <Pressable
          style={({ pressed }) => [
            styles.emptyCard,
            { bottom: chromeBottom + space.md },
            pressed && styles.cardPressed,
          ]}
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
            icon={TramFront}
          />
          <TabButton label="Komunikaty" onPress={openAlerts} badge={unreadAlerts} icon={Bell} />
          <TabButton
            label="Ustawienia"
            onPress={() => setSettingsVisible(true)}
            icon={Settings}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

function TabButton({ label, icon: Icon, onPress, badge = 0 }) {
  return (
    <Pressable
      onPress={onPress}
      // The icon and label both dim on press. They used to have no pressed
      // state at all, so a tap on a modal that takes a frame to open read as
      // the button not having registered.
      style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} nowych` : label}
    >
      <View>
        <Icon size={22} color={color.text} strokeWidth={1.9} />
        {badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText} allowFontScaling={false}>
              {badge > 9 ? "9+" : badge}
            </Text>
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
  cardPressed: { opacity: 0.8 },
  // `bottom` is supplied at render time from the safe-area inset.
  emptyCard: {
    position: "absolute",
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
  // Keep this in step with `layout.tabBar`, which is what everything floating
  // over the map uses to work out how much room the bar takes.
  tabBar: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: color.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.paperLine,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  tab: { alignItems: "center", gap: 2, paddingHorizontal: space.lg, paddingVertical: space.xs },
  tabPressed: { opacity: 0.55 },
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
