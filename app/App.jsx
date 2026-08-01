import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
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
import Material from "./components/Material";
import PressableScale from "./components/PressableScale";
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

/**
 * The tab bar floats over the map instead of sitting in a bar of its own, so
 * every other piece of chrome has to be told how much room it takes. These are
 * the only two numbers; everything else is derived from them and from the safe
 * area, which is what stops the sheet from ending up under the home indicator.
 */
const TAB_BAR_HEIGHT = 58;
const STATUS_PILL_HEIGHT = 40;

const INITIAL_REGION = {
  latitude: 51.107885,
  longitude: 17.038538,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Shell />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Everything lives inside the providers so it can read the safe-area insets.
 * On the web those come from the `env(safe-area-inset-*)` values that
 * `viewport-fit=cover` in public/index.html unlocks.
 */
function Shell() {
  const insets = useSafeAreaInsets();

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

  // How much of the bottom of the screen the floating tab bar occupies, home
  // indicator included. Anything that must clear it measures from here.
  const tabBarSpace = TAB_BAR_HEIGHT + space.sm + Math.max(insets.bottom, space.md);
  const topSpace = insets.top + space.sm;

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        initialRegion={INITIAL_REGION}
        vehicles={visibleVehicles}
        showsUserLocation={followUser}
        onSelectStop={setSelectedStop}
        selectedStopId={selectedStop?.id}
        topOffset={topSpace + STATUS_PILL_HEIGHT + space.sm}
        bottomOffset={tabBarSpace + space.sm}
      />

      <View style={[styles.top, { paddingTop: topSpace }]} pointerEvents="box-none">
        <StatusPill
          lastUpdated={lastUpdated}
          vehicleCount={visibleVehicles.length}
          lineCount={selectedLines.length}
          onPress={() => setLinesSelectionVisible(true)}
        />
      </View>

      {lines === null && !linesError && (
        <View style={styles.centre} pointerEvents="none">
          <Material style={styles.centreCard}>
            <ActivityIndicator color={color.rail} />
            <Text style={styles.centreText}>Wczytywanie rozkładów…</Text>
          </Material>
        </View>
      )}

      {linesError && (
        <View style={styles.centre} pointerEvents="box-none">
          <PressableScale style={styles.errorCard} onPress={loadLines} feedback="light">
            <Text style={styles.errorText}>{linesError}</Text>
            <Text style={styles.errorHint}>Dotknij, aby spróbować ponownie</Text>
          </PressableScale>
        </View>
      )}

      {preferencesLoaded && lines !== null && selectedLines.length === 0 && !selectedStop && (
        <View style={[styles.callToAction, { bottom: tabBarSpace }]} pointerEvents="box-none">
          <PressableScale
            style={styles.emptyCard}
            onPress={() => setLinesSelectionVisible(true)}
            accessibilityRole="button"
          >
            <TramFront size={20} color={color.paper} />
            <Text style={styles.emptyText}>Wybierz linie, które chcesz śledzić</Text>
          </PressableScale>
        </View>
      )}

      <DeparturesSheet
        stop={selectedStop}
        onClose={() => setSelectedStop(null)}
        bottomOffset={tabBarSpace}
      />

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

      <View
        style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, space.md) }]}
        pointerEvents="box-none"
      >
        <Material style={styles.tabBar}>
          <TabButton
            label="Linie"
            active={linesSelectionVisible}
            onPress={() => setLinesSelectionVisible(true)}
            icon={TramFront}
          />
          <TabButton
            label="Komunikaty"
            active={alertsVisible}
            onPress={openAlerts}
            badge={unreadAlerts}
            icon={Bell}
          />
          <TabButton
            label="Ustawienia"
            active={settingsVisible}
            onPress={() => setSettingsVisible(true)}
            icon={Settings}
          />
        </Material>
      </View>
    </View>
  );
}

function TabButton({ label, icon: Icon, onPress, badge = 0, active = false }) {
  const tint = active ? color.rail : color.text;

  return (
    <PressableScale
      onPress={onPress}
      scale={0.92}
      style={[styles.tab, active && styles.tabActive]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={badge ? `${label}, ${badge} nowych` : label}
    >
      <View>
        <Icon size={22} color={tint} strokeWidth={active ? 2.4 : 2} />
        {badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText} allowFontScaling={false}>
              {badge > 9 ? "9+" : badge}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.tabLabel, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: color.paperMuted },
  map: { ...StyleSheet.absoluteFillObject },
  top: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },

  // Overlays are centred and capped: full-width cards look right on a phone and
  // absurd on a desktop browser window.
  centre: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  centreCard: {
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    borderRadius: radius.card,
    ...shadow.chip,
  },
  centreText: { ...type.footnote, color: color.textMuted },
  errorCard: {
    width: "100%",
    maxWidth: layout.maxContentWidth,
    alignItems: "center",
    gap: space.xs,
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderRadius: radius.card,
    ...shadow.card,
  },
  errorText: { ...type.callout, color: color.disruption, textAlign: "center" },
  errorHint: { ...type.footnote, color: color.textMuted },

  callToAction: {
    position: "absolute",
    left: space.md,
    right: space.md,
    alignItems: "center",
  },
  emptyCard: {
    width: "100%",
    maxWidth: layout.maxContentWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    backgroundColor: color.rail,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.card,
    ...shadow.float,
  },
  emptyText: { ...type.callout, color: color.paper },

  bottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: space.md,
  },
  // A capsule that floats over the map, rather than a bar welded to the bottom
  // edge: the map keeps running underneath it and the blur says so.
  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    height: TAB_BAR_HEIGHT,
    paddingHorizontal: space.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.55)",
    ...shadow.float,
  },
  tab: {
    minWidth: 84,
    height: TAB_BAR_HEIGHT - space.sm,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: "rgba(11, 95, 191, 0.12)" },
  tabLabel: { ...type.caption, letterSpacing: 0, textTransform: "none" },
  badge: {
    position: "absolute",
    top: -5,
    right: -10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: color.disruption,
    borderWidth: 2,
    borderColor: color.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700", lineHeight: 12 },
});
