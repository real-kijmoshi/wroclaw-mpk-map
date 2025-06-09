import { StyleSheet, TouchableOpacity, View, Text } from "react-native";
import MapView from "./components/MapView";
import { useEffect, useState, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TramFront, Settings, Bell } from "lucide-react-native";
import LinesSelection from "./modals/LinesSelection";
import SettingsModal from "./modals/SettingsModal";
import AlertsModal from "./modals/AlertsModal";
import InfoBox from "./components/InfoBox";
import { API_URL } from "./const.json";

export default function App() {
  const [lines, setLines] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [selectedLines, setSelectedLines] = useState([]);
  const [linesSelectionVisible, setLinesSelectionVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [alertsVisible, setAlertsVisible] = useState(false);

  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState(null);

  const alertsInterval = useRef(null);

  // date 7 days ago in YYYY-MM-DD format


  const fetchAlerts = async () => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const response = await fetch(`${API_URL}/alerts?from=${alerts.length > 0 ? Date.now() : 0}`);
      if (!response.ok) throw new Error(`Error fetching alerts: ${response.status}`);

      const data = await response.json();
      const alertsData = data.alerts || [];
      setAlerts(alertsData);
    } catch (error) {
      console.error(error);
      setAlertsError("Failed to load alerts.");
      setAlerts([]);
    } finally {
      setAlertsLoading(false);
    }
  };

  // Fetch lines on mount
  useEffect(() => {
    const fetchLines = async () => {
      try {
        const response = await fetch(`${API_URL}/lines`);
        const text = await response.text();
        const data = JSON.parse(text);
        setLines(data);

        const selectedLinesRaw = await AsyncStorage.getItem("selectedLines");
        setSelectedLines(selectedLinesRaw ? JSON.parse(selectedLinesRaw) : []);
      } catch (error) {
        console.error("Error fetching lines:", error);
        setSelectedLines([]);
      }
    };
    fetchLines();
  }, []);

  // Fetch vehicles every 10 seconds
  useEffect(() => {
    const fetchVehicles = async () => {
      try {
        const response = await fetch(`${API_URL}/locations`);
        const data = await response.json();
        setVehicles(data.locations);
        setLastUpdated(new Date(data.lastUpdated).getTime());
      } catch (error) {
        console.error("Error fetching vehicles:", error);
      }
    };

    fetchVehicles();
    const interval = setInterval(fetchVehicles, 10000);
    return () => clearInterval(interval);
  }, []);

  // Save selected lines when changed
  useEffect(() => {
    const saveSelectedLines = async () => {
      try {
        await AsyncStorage.setItem("selectedLines", JSON.stringify(selectedLines));
      } catch (e) {
        console.error("Failed to save selected lines", e);
      }
    };
    saveSelectedLines();
  }, [selectedLines]);

  // Fetch alerts once on mount and then every 2 minutes
  useEffect(() => {
    fetchAlerts();
    alertsInterval.current = setInterval(fetchAlerts, 2 * 60 * 1000); // 2 minutes

    return () => clearInterval(alertsInterval.current);
  }, []);

  return (
    <View style={styles.container}>

      <InfoBox
        lastUpdated={lastUpdated}
      />

      <MapView
        style={styles.map}
        initialRegion={{
          latitude: 51.107885,
          longitude: 17.038538,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.421,
        }}
        vehicles={vehicles.filter((vehicle) =>
          selectedLines.includes(vehicle.line)
        )}
      />

      <LinesSelection
        lines={lines}
        selectedLines={selectedLines}
        setSelectedLines={setSelectedLines}
        visible={linesSelectionVisible}
        onClose={() => setLinesSelectionVisible(false)}
      />

      <SettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
      />

      <AlertsModal
        visible={alertsVisible}
        onClose={() => setAlertsVisible(false)}
        alerts={alerts}
        loading={alertsLoading}
        error={alertsError}
      />

      <View style={styles.navigationBar}>
        <TouchableOpacity
          onPress={() => setLinesSelectionVisible(true)}
          style={styles.button}
          activeOpacity={0.7}
        >
          <TramFront size={28} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setAlertsVisible(true)}
          style={[styles.button, { marginHorizontal: 12 }]}
          activeOpacity={0.7}
        >
          <Bell size={28} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setSettingsVisible(true)}
          style={styles.button}
          activeOpacity={0.7}
        >
          <Settings size={28} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f0f2f5",
  },
  map: {
    width: "100%",
    height: "100%",
  },
  navigationBar: {
    position: "absolute",
    bottom: 20,
    left: 20,
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "rgba(6, 5, 34, 0.9)",
    borderRadius: 35,
    paddingVertical: 10,
    paddingHorizontal: 16,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    width: "90%",
  },
  button: {
    backgroundColor: "#4a90e2",
    padding: 12,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    width: 56,
    height: 56,
  },
});
