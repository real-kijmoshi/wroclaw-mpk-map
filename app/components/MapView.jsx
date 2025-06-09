import { StyleSheet, Text, View } from "react-native";
import Maps, { Marker as MapMarker, Polyline } from "react-native-maps";
import { useMemo, useState } from "react";

const Colors = {
  tram: "#0075FF",
  tramSpecial: "#50E3C2",
  tramTemporary: "#F8E71C",
  bus: "#E85D75",
  busSpecial: "#F5A623",
  busNight: "#9013FE",
  busTemporary: "#B8E986",
  busSuburban: "#7ED321",
  busZone: "#F8E71C",
  unknown: "#D0021B",
};

const API_URL = "https://0455-176-121-80-161.ngrok-free.app";

function VehicleMarker({ vehicle, i, onPress }) {
  return (
    <MapMarker
      key={i}
      coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(vehicle.route_id, vehicle.type)}
      title={`${vehicle.line} (${vehicle.type})`}
    >
      <View
        style={[
          styles.marker,
          { backgroundColor: Colors[vehicle.type] || Colors.tram },
        ]}
      >
        <Text style={styles.markerText}>{vehicle.line}</Text>
      </View>
    </MapMarker>
  );
}

export default function MapView({ style, initialRegion, vehicles }) {
  const [mapRegion, setMapRegion] = useState(initialRegion);
  const [routeShape, setRouteShape] = useState(null); // holds array of {latitude, longitude}
  const [routeColor, setRouteColor] = useState("#0075FF");

  const validVehicles = useMemo(() => {
    return vehicles.filter(
      (v) => v.lat !== 0 && v.lon !== 0 && !isNaN(v.lat) && !isNaN(v.lon)
    );
  }, [vehicles]);

  // Fetch route shape by route_id
  async function fetchRouteShape(routeId, type) {
    try {
      console.log(`${API_URL}/shapes/${routeId}`);
      const response = await fetch(`${API_URL}/shapes/${routeId}`);
      if (!response.ok) {
        throw new Error("Failed to fetch route shape");
      }
      const data = await response.json();
      const shapeCoords = data.map((point) => ({
        latitude: point.lat,
        longitude: point.lon,
      }));
      setRouteShape(shapeCoords);
      setRouteColor(Colors[type] || Colors.tram); // Set color based on type
      console.log(routeId)
    } catch (error) {
      console.error("Error fetching route shape:", error);
      setRouteShape(null);
    }
  }

  return (
    <Maps
      style={style}
      initialRegion={initialRegion}
      onRegionChangeComplete={setMapRegion}
      showsUserLocation={true}
      showsMyLocationButton={true}
      showsCompass={false}
      showsScale={false}
      showsTraffic={false}
      showsIndoors={false}
      mapType="standard"
      pitchEnabled={false}
      rotateEnabled={false}
    >
      {validVehicles.map((vehicle, i) => (
        <VehicleMarker
          key={i}
          i={i}
          vehicle={vehicle}
          onPress={() => {
            fetchRouteShape(vehicle.line, vehicle.type);

          }}
        />
      ))}

      {routeShape && (
        <Polyline
          coordinates={routeShape}
          strokeColor={routeColor}
          strokeWidth={4}
          lineJoin="round"
        />
      )}
    </Maps>
  );
}

const styles = StyleSheet.create({
  marker: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    opacity: 0.9,
    shadowRadius: 4,
    elevation: 5,
  },
  markerText: {
    color: "white",
    fontSize: 12,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
