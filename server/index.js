const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const TwitterFetcher = require('./TwitterFetcher'); 

const fetch = require("node-fetch");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const cron = require("node-cron");
const { DateTime } = require("luxon");

class WroclawGTFS {
  constructor() {
    this.url = "https://www.wroclaw.pl/open-data/87b09b32-f076-4475-8ec9-6020ed1f9ac0/OtwartyWroclaw_rozklad_jazdy_GTFS.zip";
    this.data = {};
    this.isInitialized = false;
    this.refreshData();
    this.setupCron();
  }

  async refreshData() {
    try {
      console.log(`[${new Date().toISOString()}] Refreshing GTFS data...`);
      const response = await fetch(this.url);
      if (!response.ok) throw new Error(`${response.statusText}`);

      const zip = new AdmZip(await response.buffer());
      const entries = zip.getEntries();

      const parsed = {};
      for (const entry of entries) {
        if (entry.entryName.endsWith(".txt")) {
          const content = entry.getData().toString("utf8");
          
          parsed[entry.entryName.replace(".txt", "")] = parse(content, {
            columns: header => header.map(h => h.trim()),
            skip_empty_lines: true,
          });
        }
      }

      this.data = parsed;
      this.isInitialized = true;
      console.log("✅ GTFS data refreshed");
    } catch (err) {
      console.error("❌ Failed to refresh GTFS data:", err);
    }
  }

  setupCron() {
    const times = ["0 8 * * *", "0 16 * * *"];
    times.forEach(cronTime => {
      cron.schedule(
        cronTime,
        () => {
          const now = DateTime.now().setZone("Europe/Warsaw");
          console.log(`⏰ Scheduled refresh at ${now.toFormat("HH:mm")}`);
          this.refreshData();
        },
        { timezone: "Europe/Warsaw" }
      );
    });
  }

  // Enhanced method to get ALL variants of a route
  getAllRouteVariants(routeShortName) {
    const { routes, trips, shapes, stop_times, stops } = this.data;
    if (!routes || !trips || !shapes || !stop_times || !stops) return null;

    const route = routes.find(r => r.route_short_name === routeShortName);
    if (!route) return null;

    const matchingTrips = trips.filter(t => t.route_id === route.route_id);
    if (!matchingTrips.length) return null;

    // Group trips by shape_id to get different variants
    const variantsByShape = {};
    
    matchingTrips.forEach(trip => {
      if (!variantsByShape[trip.shape_id]) {
        variantsByShape[trip.shape_id] = [];
      }
      variantsByShape[trip.shape_id].push(trip);
    });

    const variants = [];

    Object.keys(variantsByShape).forEach(shapeId => {
      const tripsForShape = variantsByShape[shapeId];
      const representativeTrip = tripsForShape[0]; // Use first trip as representative

      // Get shape points
      const shapePoints = shapes
        .filter(s => s.shape_id === shapeId)
        .sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));

      // Get stops for this variant
      const tripStops = stop_times
        .filter(st => st.trip_id === representativeTrip.trip_id)
        .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence))
        .map(st => ({
          stop: stops.find(s => s.stop_id === st.stop_id),
          arrival_time: st.arrival_time,
          departure_time: st.departure_time,
          stop_sequence: st.stop_sequence
        }));

      // Determine direction/variant name based on first and last stops
      const firstStop = tripStops[0]?.stop?.stop_name || '';
      const lastStop = tripStops[tripStops.length - 1]?.stop?.stop_name || '';
      const directionName = `${firstStop} → ${lastStop}`;

      variants.push({
        shape_id: shapeId,
        direction: directionName,
        trip_headsign: representativeTrip.trip_headsign || directionName,
        shapePoints,
        stops: tripStops,
        tripCount: tripsForShape.length
      });
    });

    return {
      route_short_name: routeShortName,
      route_id: route.route_id,
      variants: variants
    };
  }

  // Keep the original method for backward compatibility
  getShapeByRoute(routeShortName) {
    const allVariants = this.getAllRouteVariants(routeShortName);
    if (!allVariants || !allVariants.variants.length) return null;
    
    // Return the first variant (maintains existing behavior)
    const firstVariant = allVariants.variants[0];
    return {
      shapePoints: firstVariant.shapePoints,
      stops: firstVariant.stops
    };
  }

  // New method to get the best matching route variant based on vehicle position
  getBestRouteVariant(routeShortName, vehicleLat, vehicleLon) {
    const allVariants = this.getAllRouteVariants(routeShortName);
    if (!allVariants || !allVariants.variants.length) return null;

    let bestVariant = null;
    let minDistance = Infinity;

    // Calculate distance from vehicle to each route variant
    allVariants.variants.forEach(variant => {
      if (!variant.shapePoints || variant.shapePoints.length === 0) return;

      // Find the closest point on this variant to the vehicle
      const closestDistance = Math.min(...variant.shapePoints.map(point => {
        return this.calculateDistance(
          vehicleLat, 
          vehicleLon, 
          parseFloat(point.shape_pt_lat), 
          parseFloat(point.shape_pt_lon)
        );
      }));

      if (closestDistance < minDistance) {
        minDistance = closestDistance;
        bestVariant = variant;
      }
    });

    return bestVariant ? {
      shapePoints: bestVariant.shapePoints,
      stops: bestVariant.stops,
      direction: bestVariant.direction,
      shape_id: bestVariant.shape_id
    } : null;
  }

  // Helper method to calculate distance between two points (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  toRadians(degrees) {
    return degrees * (Math.PI/180);
  }

  getStopTimesByStop(stopId) {
    const { stop_times, trips, stops } = this.data;
    if (!stop_times || !trips || !stops) return [];

    const targetStop = stops.find(s => s.stop_id === stopId);
    if (!targetStop) return [];

    return stop_times
      .filter(st => st.stop_id === stopId)
      .map(st => {
        const trip = trips.find(t => t.trip_id === st.trip_id);
        return {
          route_id: trip?.route_id,
          trip_id: st.trip_id,
          arrival_time: st.arrival_time,
          departure_time: st.departure_time,
        };
      });
  }

  // Get all routes for categorization
  getAllRoutes() {
    if (!this.data.routes) return [];
    return this.data.routes.map(route => route.route_short_name).filter(Boolean);
  }

  // Get all stops
  getAllStops() {
    if (!this.data.stops) return [];
    return this.data.stops;
  }
}

// Initialize GTFS data handler
const gtfsHandler = new WroclawGTFS();

// Initialize Twitter fetcher for alerts
const twitter = new TwitterFetcher({
  userId: "296212741", // MPK Wrocław Twitter ID
})
twitter.init();

// Store vehicle locations
const locations = {
    locations: [],
    lastUpdated: null
};

// System status tracking
const systemStatus = {
  lines: {
    fetched: 0,
    lastFetch: null,
    trams: 0,
    buses: 0
  },
  vehicles: {
    tracked: 0,
    lastUpdate: null
  },
  shapes: {
    rendered: 0,
    cached: 0
  },
  server: {
    started: null,
    uptime: 0
  }
};

const app = express();

app.use(cors({
    origin: "*",
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Initialize lines object with proper structure
const lines = {
  tram: [],
  tramSpecial: [],
  tramTemporary: [],
  allTrams: [],
  bus: [],
  busNight: [],
  busSuburban: [],
  busTemporary: [],
  busZone: [],
  busExpress: [],
  busSpecial: [],
  allBuses: [],
  unknown: []
};

const shapes = new Map(); // Store shapes cache

// Define express lines set
const expressLines = new Set(['A', 'C', 'D', 'K', 'N', "a", "c", "d", "k", "n"]);

// Update system status helper
const updateSystemStatus = () => {
  systemStatus.lines.fetched = Object.values(lines).flat().length;
  systemStatus.lines.trams = lines.allTrams.length;
  systemStatus.lines.buses = lines.allBuses.length;
  systemStatus.vehicles.tracked = locations.locations.length;
  systemStatus.shapes.cached = shapes.size;
};

const lineToType = (line) => {
    if (line.startsWith("T")) {
        return "tram";
    } else if (expressLines.has(line)) {
        return "busExpress";
    } else if (/^\d+$/.test(line)) {
        const lineInt = parseInt(line, 10);
        if (lineInt >= 0 && lineInt < 40) {
            return "tram";
        } else if (lineInt >= 70 && lineInt < 100) {
            return "tramTemporary";
        } else if (lineInt >= 200 && lineInt < 300) {
            return "busNight";
        } else if (lineInt >= 600 && lineInt < 700) {
            return "busSuburban";
        } else if (lineInt >= 700 && lineInt < 800) {
            return "busTemporary";
        } else if (lineInt >= 900 && lineInt < 1000) {
            return "busZone";
        } else {
            return "bus";
        }
    } else if (line.startsWith("B")) {
        return "busSpecial";
    } else {
        return "unknown";
    }
}

const categorizeLines = (rawLines) => {
  // Create fresh categories object
  const categories = {
    tram: [],
    tramSpecial: [],
    tramTemporary: [],
    allTrams: [],
    bus: [],
    busNight: [],
    busSuburban: [],
    busTemporary: [],
    busZone: [],
    busExpress: [],
    busSpecial: [],
    allBuses: [],
    unknown: []
  };

  rawLines.forEach(line => {
    const type = lineToType(line);
    switch (type) {
      case "tram":
        categories.tram.push(line);
        categories.allTrams.push(line);
        break;
      case "tramSpecial":
        categories.tramSpecial.push(line);
        categories.allTrams.push(line);
        break;
      case "tramTemporary":
        categories.tramTemporary.push(line);
        categories.allTrams.push(line);
        break;
      case "bus":
        categories.bus.push(line);
        categories.allBuses.push(line);
        break;
      case "busNight":
        categories.busNight.push(line);
        categories.allBuses.push(line);
        break;
      case "busSuburban":
        categories.busSuburban.push(line);
        categories.allBuses.push(line);
        break;
      case "busTemporary":
        categories.busTemporary.push(line);
        categories.allBuses.push(line);
        break;
      case "busZone":
        categories.busZone.push(line);
        categories.allBuses.push(line);
        break;
      case "busExpress":
        categories.busExpress.push(line);
        categories.allBuses.push(line);
        break;
      case "busSpecial":
        categories.busSpecial.push(line);
        categories.allBuses.push(line);
        break;
      default:
        categories.unknown.push(line);
    }
  });

  return categories;
};

// Updated fetchLines using the new GTFS handler
const fetchLines = async () => {
  try {
    // Wait for GTFS data to be initialized
    if (!gtfsHandler.isInitialized) {
      console.log("⏳ Waiting for GTFS data to initialize...");
      return;
    }

    console.log("📖 Processing routes from GTFS data...");
    
    // Get all routes from GTFS data
    const rawLines = gtfsHandler.getAllRoutes();
    
    if (rawLines.length === 0) {
      throw new Error("No routes found in GTFS data");
    }

    console.log(`📊 Found ${rawLines.length} routes`);
    
    // Clear shapes for fresh data
    shapes.clear();

    // Categorize lines
    const categorizedLines = categorizeLines(rawLines);
    
    // Update the global lines object
    Object.assign(lines, categorizedLines);
    
    // Update system status
    systemStatus.lines.lastFetch = new Date();
    
    console.log("✅ Lines categorized successfully");

    return lines;
  } catch (error) {
    console.error("❌ Error processing GTFS data:", error.message);
    throw error;
  }
};

const fetchLocations = async () => {
  try {
    // Check if lines are available
    if (!lines.allBuses.length && !lines.allTrams.length) {
      return;
    }

    const body = new URLSearchParams();
    
    // Add bus lines
    lines.allBuses.forEach(id => body.append('busList[bus][]', id));
    
    // Add tram lines
    lines.allTrams.forEach(id => body.append('busList[tram][]', id));
    
    const res = await axios.post(
      'https://mpk.wroc.pl/bus_position',
      body.toString(),
      { 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000 // 10 second timeout
      }
    );

    // Update locations with the response data
    locations.locations = res.data.map(vehicle => {
        return {
            lon: vehicle.y,
            lat: vehicle.x,
            line: vehicle.name,
            type: lineToType(vehicle.name),
        };
    });
    
    locations.lastUpdated = new Date().toISOString();
    systemStatus.vehicles.lastUpdate = new Date();
    
  } catch (error) {
    console.error("⚠️  Error fetching locations:", error.message);
    // Don't throw error to prevent stopping the interval
  }
};

// Start location fetching after a delay to ensure data is loaded
let locationInterval;

const startLocationFetching = () => {
  // Initial fetch after 10 seconds
  setTimeout(() => {
    fetchLocations();
    // Then fetch every 10 seconds
    locationInterval = setInterval(fetchLocations, 10 * 1000);
  }, 10000);
};

// Wait for GTFS initialization and then fetch lines
const initializeLines = async () => {
  const checkInitialization = setInterval(async () => {
    if (gtfsHandler.isInitialized) {
      clearInterval(checkInitialization);
      await fetchLines();
      startLocationFetching();
    }
  }, 1000);
};

// API endpoints
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Wrocław Public Transport API',
    endpoints: [
      { method: 'GET', path: '/lines', description: 'Get all categorized lines' },
      { method: 'GET', path: '/lines/:category', description: 'Get lines for specific category' },
      { method: 'GET', path: '/locations', description: 'Get vehicle locations' },
      { method: 'GET', path: '/shapes/:line', description: 'Get shape for specific line (supports ?lat=&lon= for best variant)' },
      { method: 'GET', path: '/shapes/:line/variants', description: 'Get all variants of a route' },
      { method: 'GET', path: '/stops/:line', description: 'Get stops for specific line' },
      { method: 'GET', path: '/stop/:id', description: 'Get schedule for specific stop' },
      { method: 'GET', path: '/alerts', description: 'Get recent alerts' },
      { method: 'GET', path: '/health', description: 'Health check' }
    ]
  });
});

app.get('/lines', (req, res) => {
  res.json(lines);
});

app.get('/lines/:category', (req, res) => {
  const category = req.params.category;
  if (lines.hasOwnProperty(category)) {
    res.json({ category, lines: lines[category] });
  } else {
    res.status(404).json({ error: 'Category not found', availableCategories: Object.keys(lines) });
  }
});

app.get('/locations', (req, res) => {
  res.json(locations);
});

// New endpoint to get all variants of a route
app.get('/shapes/:line/variants', (req, res) => {
  const line = req.params.line;
  
  if (!lines.allTrams.includes(line) && !lines.allBuses.includes(line)) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const allVariants = gtfsHandler.getAllRouteVariants(line);
  if (allVariants) {
    return res.json(allVariants);
  } else {
    return res.status(404).json({ error: 'No variants found for this line' });
  }
});

// Enhanced shapes endpoint that can find best variant based on vehicle position
app.get('/shapes/:line', (req, res) => {
  const line = req.params.line;
  const vehicleLat = req.query.lat ? parseFloat(req.query.lat) : null;
  const vehicleLon = req.query.lon ? parseFloat(req.query.lon) : null;
  
  if (!shapes.has(line) && !lines.allTrams.includes(line) && !lines.allBuses.includes(line)) {
    return res.status(404).json({ error: 'Line not found' });
  }

  // Create cache key including position if provided
  const cacheKey = vehicleLat && vehicleLon ? 
    `${line}_${vehicleLat.toFixed(4)}_${vehicleLon.toFixed(4)}` : line;

  if (shapes.has(cacheKey)) {
    return res.json(shapes.get(cacheKey));
  } else {
    let shapeData;
    
    // If vehicle position is provided, try to get the best matching variant
    if (vehicleLat && vehicleLon) {
      shapeData = gtfsHandler.getBestRouteVariant(line, vehicleLat, vehicleLon);
    } else {
      // Fallback to original method
      shapeData = gtfsHandler.getShapeByRoute(line);
    }
    
    if (shapeData) {
      shapes.set(cacheKey, shapeData);
      systemStatus.shapes.rendered++;
      updateSystemStatus();
      return res.json(shapeData);
    } else {
      return res.status(404).json({ error: 'Shape not found for this line' });
    }
  }
});

// New endpoint for stops on a route
app.get('/stops/:line', (req, res) => {
  const line = req.params.line;
  
  if (!lines.allTrams.includes(line) && !lines.allBuses.includes(line)) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const shapeData = gtfsHandler.getShapeByRoute(line);
  if (shapeData && shapeData.stops) {
    const stops = shapeData.stops.map(stopData => ({
      stop_id: stopData.stop?.stop_id,
      stop_name: stopData.stop?.stop_name,
      stop_lat: stopData.stop?.stop_lat,
      stop_lon: stopData.stop?.stop_lon,
      arrival_time: stopData.arrival_time,
      departure_time: stopData.departure_time
    }));
    
    return res.json({ line, stops });
  } else {
    return res.status(404).json({ error: 'Stops not found for this line' });
  }
});

// New endpoint for stop schedules
app.get('/stop/:id', (req, res) => {
  const stopId = req.params.id;
  
  const schedule = gtfsHandler.getStopTimesByStop(stopId);
  if (schedule.length > 0) {
    return res.json({ stop_id: stopId, schedule });
  } else {
    return res.status(404).json({ error: 'Stop not found or no schedule available' });
  }
});


app.get('/alerts', (req, res) => {
    const from = parseInt(req.query.from) || 0;
    const alerts = twitter.getAlerts(from);
    return res.json({ alerts });
});


app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    gtfsInitialized: gtfsHandler.isInitialized,
    totalLines: Object.values(lines).flat().length,
    locationsCount: locations.locations.length,
    lastUpdated: new Date().toISOString(),
    locationsLastUpdated: locations.lastUpdated
  });
});

// Static file endpoints
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, "views", 'status.html'));
});

app.get('/map', (req, res) => {
  res.sendFile(path.join(__dirname, "views", 'map.html'));
});

// Initialize data and start server
const startServer = async () => {
  try {
    systemStatus.server.started = new Date();
    
    // Initialize lines processing
    initializeLines();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server started on http://localhost:${PORT}`);

      // Cache warming after server starts
      setTimeout(() => {
        if (lines.allTrams.length > 0) {
          console.log("🔥 Warming up shape cache...");
          const randomLine = lines.allTrams[Math.floor(Math.random() * lines.allTrams.length)];
          if (randomLine) {
            const shapeData = gtfsHandler.getShapeByRoute(randomLine);
            if (shapeData) {
              shapes.set(randomLine, shapeData);
              systemStatus.shapes.rendered++;
              console.log(`✅ Cached shape for line: ${randomLine}`);
              updateSystemStatus();
            }
          }
        }
      }, 15000);
    });
  } catch (error) {
    console.error("💥 Failed to start server:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT. Graceful shutdown...');
  if (locationInterval) {
    clearInterval(locationInterval);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM. Graceful shutdown...');
  if (locationInterval) {
    clearInterval(locationInterval);
  }
  process.exit(0);
});

// Start the application
if (require.main === module) {
  startServer();
}

module.exports = { 
  lines, 
  app,
  categorizeLines,
  fetchLocations,
  gtfsHandler,
  WroclawGTFS
};