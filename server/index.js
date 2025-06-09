const express = require('express');
const axios = require('axios');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const getShapesForRoute = require('./utils/getShapesForRoute');

// Ensure data directory exists
fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });

const locations = {
    locations: [],
    lastUpdated: null
}

// Store GTFS data globally so fetchLocations can access it
let gtfsData = {
  lines: null
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

const shapes = new Map(); // Store shapes for each route

// Define express lines set
const expressLines = new Set(['A', 'C', 'D', 'K', 'N', "a", "c", "d", "k", "n"]);

// Console display functions
const clearConsole = () => {
  console.clear();
};

const displayHeader = () => {
  console.log('\n' + '='.repeat(80));
  console.log('🚋 WROCŁAW PUBLIC TRANSPORT API SERVER 🚌');
  console.log('='.repeat(80));
};

const displaySystemStatus = () => {
  const now = new Date();
  const uptime = systemStatus.server.started ? 
    Math.floor((now - systemStatus.server.started) / 1000) : 0;
  
  const formatUptime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}h ${minutes}m ${secs}s`;
  };

  const formatTime = (date) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
  };

  const getTimeAgo = (date) => {
    if (!date) return 'Never';
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  console.log('\n📊 SYSTEM STATUS');
  console.log('─'.repeat(50));
  
  // Server info
  console.log(`🟢 Server Status: RUNNING | Uptime: ${formatUptime(uptime)}`);
  console.log(`⏰ Current Time: ${now.toLocaleString()}`);
  
  // Lines info
  console.log('\n🚏 LINES DATA:');
  console.log(`   Total Lines Fetched: ${systemStatus.lines.fetched}`);
  console.log(`   🚋 Trams: ${systemStatus.lines.trams} | 🚌 Buses: ${systemStatus.lines.buses}`);
  console.log(`   Last GTFS Fetch: ${formatTime(systemStatus.lines.lastFetch)} (${getTimeAgo(systemStatus.lines.lastFetch)})`);
  
  // Vehicles info
  const vehicleStatus = systemStatus.vehicles.tracked > 0 ? '🟢 ACTIVE' : '🟡 STANDBY';
  console.log('\n🚗 VEHICLE TRACKING:');
  console.log(`   Live Vehicles: ${systemStatus.vehicles.tracked} ${vehicleStatus}`);
  console.log(`   Last Update: ${formatTime(systemStatus.vehicles.lastUpdate)} (${getTimeAgo(systemStatus.vehicles.lastUpdate)})`);
  
  // Shapes info
  console.log('\n🗺️  ROUTE SHAPES:');
  console.log(`   Rendered: ${systemStatus.shapes.rendered} | Cached: ${systemStatus.shapes.cached}`);
  const efficiency = systemStatus.shapes.cached > 0 ? 
    Math.round((systemStatus.shapes.rendered / systemStatus.shapes.cached) * 100) : 0;
  console.log(`   Cache Efficiency: ${efficiency}%`);
  
  console.log('\n' + '─'.repeat(50));
};

const displayFooter = () => {
  console.log('\n🌐 API ENDPOINTS:');
  console.log('   GET  /lines          - All categorized lines');
  console.log('   GET  /lines/:cat     - Lines by category');
  console.log('   GET  /locations      - Live vehicle positions');
  console.log('   GET  /shapes/:line   - Route shapes');
  console.log('   GET  /alerts         - Service alerts');
  console.log('   GET  /health         - System health');
  console.log('\n💡 Press Ctrl+C to stop the server');
  console.log('='.repeat(80) + '\n');
};

const updateConsoleDisplay = () => {
  if(process.argv.includes('--no-console')) {
    return; // Skip console display if --no-console flag is set
  }

  clearConsole();
  displayHeader();
  displaySystemStatus();
  displayFooter();
};

// Update system status helper
const updateSystemStatus = () => {
  systemStatus.lines.fetched = Object.values(lines).flat().length;
  systemStatus.lines.trams = lines.allTrams.length;
  systemStatus.lines.buses = lines.allBuses.length;
  systemStatus.vehicles.tracked = locations.locations.length;
  systemStatus.shapes.cached = shapes.size;
  
  updateConsoleDisplay();
};

function csvToJson(csv, delimiter = ",") {
  const lines = csv.trim().split("\n");
  if (lines.length === 0) return [];

  const headers = lines[0].split(delimiter).map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter);
    const obj = {};

    if (values.length >= headers.length) {
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = values[j]?.trim() || "";
      }
      result.push(obj);
    }
  }

  return result;
}

const GTFS_URL = "https://www.wroclaw.pl/open-data/87b09b32-f076-4475-8ec9-6020ed1f9ac0/OtwartyWroclaw_rozklad_jazdy_GTFS.zip";
const ZIP_PATH = path.join(__dirname, "data", "gtfs.zip");
const EXTRACT_PATH = path.join(__dirname, "data", "gtfs");

// Utility function to read a CSV file from disk and parse it
const readCsvFile = async (filename) => {
  const filePath = path.join(EXTRACT_PATH, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filename}`);
    return [];
  }
  const csvData = await fs.promises.readFile(filePath, 'utf-8');
  return csvToJson(csvData);
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
    }
    );

  return categories;
};

const downloadFile = async (url, filePath) => {
  const response = await axios.get(url, { 
    responseType: 'stream',
    timeout: 30000 // 30 second timeout
  });
  
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

const extractZip = async (zipPath, extractPath) => {
  return new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }))
      .on('close', resolve)
      .on('error', reject);
  });
};

const fetchLines = async () => {
  try {
    console.log("🔄 Downloading GTFS data...");
    await downloadFile(GTFS_URL, ZIP_PATH);
    console.log("✅ Download completed.");

    console.log("📦 Extracting ZIP file...");
    await extractZip(ZIP_PATH, EXTRACT_PATH);
    console.log("✅ Extraction completed.");

    console.log("📖 Reading trips data...");
    const trips = await readCsvFile('trips.txt');
    
    if (trips.length === 0) {
      throw new Error("No trips data found or trips.txt is empty");
    }

    console.log(`📊 Found ${trips.length} trips`);
    
    // Extract unique route IDs
    const rawLines = [...new Set(trips.map(trip => trip.route_id).filter(Boolean))];

    // Clear shapes for fresh data
    shapes.clear();

    // Categorize lines
    const categorizedLines = categorizeLines(rawLines);
    
    // Update the global lines object
    Object.assign(lines, categorizedLines);
    
    // Store in gtfsData for access by fetchLocations
    gtfsData.lines = lines;
    
    // Update system status
    systemStatus.lines.lastFetch = new Date();
    
    console.log("✅ Lines categorized successfully");

    // Clean up ZIP file
    if (fs.existsSync(ZIP_PATH)) {
      fs.unlinkSync(ZIP_PATH);
      console.log("🧹 Cleaned up temporary ZIP file");
    }

    // Update console display
    updateSystemStatus();

    return lines;
  } catch (error) {
    console.error("❌ Error fetching GTFS data:", error.message);
    throw error;
  }
};

const fetchLocations = async () => {
  try {
    // Check if GTFS data is available
    if (!gtfsData.lines || (!gtfsData.lines.allBuses.length && !gtfsData.lines.allTrams.length)) {
      return;
    }

    const body = new URLSearchParams();
    
    // Add bus lines
    gtfsData.lines.allBuses.forEach(id => body.append('busList[bus][]', id));
    
    // Add tram lines
    gtfsData.lines.allTrams.forEach(id => body.append('busList[tram][]', id));
    
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
    
    // Update console display
    updateSystemStatus();
    
  } catch (error) {
    console.error("⚠️  Error fetching locations:", error.message);
    // Don't throw error to prevent stopping the interval
  }
};

// Start location fetching after a delay to ensure GTFS data is loaded
let locationInterval;

const startLocationFetching = () => {
  // Initial fetch after 5 seconds
  setTimeout(() => {
    fetchLocations();
    // Then fetch every 10 seconds
    locationInterval = setInterval(fetchLocations, 10 * 1000);
  }, 5000);
};

// API endpoints
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Wrocław Public Transport API',
    endpoints: [
      { method: 'GET', path: '/lines', description: 'Get all categorized lines' },
      { method: 'GET', path: '/lines/:category', description: 'Get lines for specific category' },
      { method: 'GET', path: '/locations', description: 'Get vehicle locations' },
      { method: 'GET', path: '/alerts', description: 'Get recent alerts' },
      { method: 'GET', path: '/shapes/:line', description: 'Get shape for specific line' },
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

const affectedLines = (content) => {
  //extacrt lines with space before no other requirement
  const regex = /(?:\s|^)(\d+)(?:\s|$)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

const alertsMock = [
  {
    id: 1,
    content: "Rondo Regana brak przejazdu peron 1 (awaria tramwaju) Tramaj linii 2 przekierowany na peron 2",
    timestamp: Date.now() - 3600000, // 1 hour ago
    affected: affectedLines("Rondo Regana brak przejazdu peron 1 (awaria tramwaju) Tramaj linii 2 przekierowany na peron 2")
  }
];

app.get('/alerts', (req, res) => {
  const from = req.query.from || 0;

  return res.json({
    alerts: alertsMock.filter(alert => alert.timestamp >= from).map(alert => ({
      id: alert.id,
      content: alert.content,
      timestamp: alert.timestamp,
      affected: alert.affected
    }))
  });
});

app.get('/shapes/:line', (req, res) => {
  const line = req.params.line;
  
  if(!shapes.has(line) && !lines.allTrams.includes(line) && !lines.allBuses.includes(line)) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (shapes.has(line)) {
    return res.json(shapes.get(line));
  } else {
    const shape = getShapesForRoute(line);
    if (shape) {
      shapes.set(line, shape[Object.keys(shape)[0]]); // Assuming shape is an object with a single key
      systemStatus.shapes.rendered++;
      updateSystemStatus(); // Update display when shape is rendered
      return res.json(shape[Object.keys(shape)[0]]);
    } else {
      return res.status(404).json({ error: 'Shape not found for this line' });
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    totalLines: Object.values(lines).flat().length,
    locationsCount: locations.locations.length,
    lastUpdated: new Date().toISOString(),
    locationsLastUpdated: locations.lastUpdated
  });
});

app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, "views", 'status.html'));
});

// Initialize data and start server
const startServer = async () => {
  try {
    systemStatus.server.started = new Date();
    
    await fetchLines();

    setInterval(async () => {
      try {
        await fetchLines();
      } catch (error) {
        console.error("❌ Error refreshing lines:", error.message);
      }
    }, 24 * 60 * 60 * 1000); // Refresh lines every 24 hours
    
    // Start location fetching
    startLocationFetching();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      // Initial console display
      updateConsoleDisplay();
      
      // Update display every 30 seconds
      setInterval(updateSystemStatus, 30000);

      setTimeout(() => {
        console.log("🔥 Warming up shape cache...");
        const randomLine = lines.allTrams[Math.floor(Math.random() * lines.allTrams.length)];
        if (randomLine) {
          getShapesForRoute(randomLine);
          systemStatus.shapes.rendered++;
          console.log(`✅ Cached shape for line: ${randomLine}`);
          updateSystemStatus();
        } else {
          console.warn("⚠️  No tram lines available for cache warming");
        }
      }, 5000);
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
  fetchLines, 
  lines, 
  app,
  categorizeLines,
  readCsvFile,
  fetchLocations
};