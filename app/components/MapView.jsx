import { StyleSheet, Text, View } from "react-native";
import Maps, { Marker as MapMarker, Polyline } from "react-native-maps";
import { useMemo, useState } from "react";
import { API_URL } from "../const.json";

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
  busExpress: "#FF6B35",
  unknown: "#D0021B",
};

function VehicleMarker({ vehicle, i, onPress }) {
  return (
    <MapMarker
      key={i}
      coordinate={{ latitude: vehicle.lat, longitude: vehicle.lon }}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(vehicle.line, vehicle.type, vehicle.lat, vehicle.lon)} // Pass vehicle position
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

function StopMarker({ stop, routeColor, onPress }) {
  const handleStopPress = () => {
    console.log(`Stop pressed: ${stop.name} (ID: ${stop.id})`);
    if (onPress) {
      onPress(stop);
    }
  };

  return (
    <MapMarker
      key={`stop-${stop.id}`}
      coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
      anchor={{ x: 0.5, y: 1 }}
      onPress={handleStopPress}
      title={stop.name}
      description={`Arrival: ${stop.arrivalTime || 'N/A'}`}
    >
      <View style={styles.stopMarkerContainer}>
        <View style={[styles.stopMarker, { borderColor: routeColor }]}>
          <View style={[styles.stopDot, { backgroundColor: routeColor }]} />
        </View>
        <View style={[styles.stopNameContainer, { borderColor: routeColor }]}>
          <Text style={styles.stopNameText} numberOfLines={2}>
            {stop.name}
          </Text>
        </View>
      </View>
    </MapMarker>
  );
}

export default function MapView({ style, initialRegion, vehicles }) {
  const [mapRegion, setMapRegion] = useState(initialRegion);
  const [routeShape, setRouteShape] = useState(null);
  const [routeColor, setRouteColor] = useState("#0075FF");
  const [routeStops, setRouteStops] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [routeDirection, setRouteDirection] = useState(null); // Store route direction info

  const validVehicles = useMemo(() => {
    return vehicles.filter(
      (v) => v.lat !== 0 && v.lon !== 0 && !isNaN(v.lat) && !isNaN(v.lon)
    );
  }, [vehicles]);

  const handleStopPress = (stop) => {
    console.log('Stop marker pressed:', stop);
    // TODO: Add your stop details functionality here
  };

  // Enhanced fetch route shape with vehicle position
async function fetchRouteShape(line, type, vehicleLat = null, vehicleLon = null) {
  try {
    console.log(`Fetching shape for line: ${line}${vehicleLat && vehicleLon ? ` at position (${vehicleLat}, ${vehicleLon})` : ''}`);
    
    // Build URL with vehicle position if available
    let url = `${API_URL}/shapes/${line}`;
    if (vehicleLat && vehicleLon) {
      url += `?lat=${vehicleLat}&lon=${vehicleLon}`;
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch route shape: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Handle GTFS data structure
    if (data.shapePoints && Array.isArray(data.shapePoints)) {
      const shapeCoords = data.shapePoints.map((point) => ({
        latitude: parseFloat(point.shape_pt_lat),
        longitude: parseFloat(point.shape_pt_lon),
      })).filter(coord => !isNaN(coord.latitude) && !isNaN(coord.longitude));
      
      setRouteShape(shapeCoords);
      setRouteColor(Colors[type] || Colors.tram);
      setSelectedRoute(line);
      setRouteDirection(data.direction || null); // Store direction info
      
      // Process stops if available
      let stopCoords = [];
      if (data.stops && Array.isArray(data.stops)) {
        stopCoords = data.stops
          .filter(stopData => stopData.stop && stopData.stop.stop_lat && stopData.stop.stop_lon)
          .map(stopData => ({
            id: stopData.stop.stop_id,
            name: stopData.stop.stop_name,
            latitude: parseFloat(stopData.stop.stop_lat),
            longitude: parseFloat(stopData.stop.stop_lon),
            arrivalTime: stopData.arrival_time,
            departureTime: stopData.departure_time
          }))
          .filter(stop => !isNaN(stop.latitude) && !isNaN(stop.longitude));
        
        setRouteStops(stopCoords);
      } else {
        setRouteStops([]);
      }
      
      console.log(`Successfully loaded ${shapeCoords.length} shape points for line ${line}`);
      if (data.stops && stopCoords) {
        console.log(`Loaded ${stopCoords.length} stops for line ${line}`);
      }
      if (data.direction) {
        console.log(`Route direction: ${data.direction}`);
      }
      
      // // Auto-fit map to show the route
      // if (shapeCoords.length > 0) {
      //   fitMapToRoute(shapeCoords);
      // }
      
    } else {
      // Fallback for legacy data format
      console.warn("Received legacy data format, attempting to parse...");
      if (Array.isArray(data)) {
        const shapeCoords = data.map((point) => ({
          latitude: parseFloat(point.lat || point.shape_pt_lat),
          longitude: parseFloat(point.lon || point.shape_pt_lon),
        })).filter(coord => !isNaN(coord.latitude) && !isNaN(coord.longitude));
        
        setRouteShape(shapeCoords);
        setRouteColor(Colors[type] || Colors.tram);
        setSelectedRoute(line);
        setRouteDirection(null);
        setRouteStops([]);
        
        if (shapeCoords.length > 0) {
          fitMapToRoute(shapeCoords);
        }
      } else {
        throw new Error("Invalid data format received");
      }
    }
  } catch (error) {
    console.error("Error fetching route shape:", error);
    setRouteShape(null);
    setRouteStops([]);
    setSelectedRoute(null);
    setRouteDirection(null);
  }
}

  // // Helper function to fit map to route
  // function fitMapToRoute(shapeCoords) {
  //   if (shapeCoords.length === 0) return;

  //   const lats = shapeCoords.map(coord => coord.latitude);
  //   const lons = shapeCoords.map(coord => coord.longitude);
    
  //   const minLat = Math.min(...lats);
  //   const maxLat = Math.max(...lats);
  //   const minLon = Math.min(...lons);
  //   const maxLon = Math.max(...lons);
    
  //   const latDelta = (maxLat - minLat) * 1.3; // Add 30% padding
  //   const lonDelta = (maxLon - minLon) * 1.3;
    
  //   const centerLat = (minLat + maxLat) / 2;
  //   const centerLon = (minLon + maxLon) / 2;
    
  //   const newRegion = {
  //     latitude: centerLat,
  //     longitude: centerLon,
  //     latitudeDelta: Math.max(latDelta, 0.01), // Minimum zoom level
  //     longitudeDelta: Math.max(lonDelta, 0.01),
  //   };
    
  //   setMapRegion(newRegion);
  // }

  // Clear route display
  function clearRoute() {
    setRouteShape(null);
    setRouteStops([]);
    setSelectedRoute(null);
    setRouteDirection(null);
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Route info banner */}
      {selectedRoute && (
        <View style={styles.routeInfoBanner}>
          <Text style={styles.routeInfoText}>
            Line {selectedRoute}
            {routeDirection && ` - ${routeDirection}`}
          </Text>
          <Text style={styles.routeInfoSubtext}>
            {routeStops.length} stops • Tap map to clear
          </Text>
        </View>
      )}
      
      <Maps
        style={style}
        region={mapRegion} 
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
        onPress={clearRoute}
      >
        {/* Vehicle markers */}
        {validVehicles.map((vehicle, i) => (
          <VehicleMarker
            key={`vehicle-${i}`}
            i={i}
            vehicle={vehicle}
            onPress={(line, type, lat, lon) => {
              if (selectedRoute === line) {
                clearRoute(); // Toggle off if same route selected
              } else {
                fetchRouteShape(line, type, lat, lon); // Pass vehicle position
              }
            }}
          />
        ))}

        {/* Route polyline */}
        {routeShape && routeShape.length > 0 && (
          <Polyline
            coordinates={routeShape}
            strokeColor={routeColor}
            strokeWidth={4}
            lineJoin="round"
            lineCap="round"
          />
        )}

        {/* Stop markers along the route */}
        {routeStops.map((stop) => (
          <StopMarker
            key={`stop-${stop.id}`}
            stop={stop}
            routeColor={routeColor}
            onPress={handleStopPress}
          />
        ))}
      </Maps>
    </View>
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
  stopMarkerContainer: {
    alignItems: "center",
    justifyContent: "flex-end",
  },
  stopMarker: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "white",
    borderWidth: 3,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  stopDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stopNameContainer: {
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 4,
    minWidth: 60,
    maxWidth: 120,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  stopNameText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#333",
    textAlign: "center",
    lineHeight: 12,
  },
  routeInfoBanner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingVertical: 12,
    paddingHorizontal: 16,
    paddingTop: 50,
    zIndex: 1000,
  },
  routeInfoText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 2,
  },
  routeInfoSubtext: {
    color: "rgba(255, 255, 255, 0.8)",
    fontSize: 12,
  },
});