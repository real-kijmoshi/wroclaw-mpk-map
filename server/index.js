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
    console.log("Downloading GTFS data...");
    await downloadFile(GTFS_URL, ZIP_PATH);
    console.log("Download completed.");

    console.log("Extracting ZIP file...");
    await extractZip(ZIP_PATH, EXTRACT_PATH);
    console.log("Extraction completed.");

    console.log("Reading trips data...");
    const trips = await readCsvFile('trips.txt');
    
    if (trips.length === 0) {
      throw new Error("No trips data found or trips.txt is empty");
    }

    console.log(`Found ${trips.length} trips`);
    
    // Extract unique route IDs
    const rawLines = [...new Set(trips.map(trip => trip.route_id).filter(Boolean))];

    //foreach every line, extract the shapes
    shapes.clear();

    rawLines.forEach(line => {
      const shape = getShapesForRoute(line);
      if (shape) {
        shapes.set(line, shape[Object.keys(shape)[0]]);
      } else {
        console.warn(`No shape found for line: ${line}`);
      }
    });

    // Categorize lines
    const categorizedLines = categorizeLines(rawLines);
    
    // Update the global lines object
    Object.assign(lines, categorizedLines);
    
    // Store in gtfsData for access by fetchLocations
    gtfsData.lines = lines;
    
    console.log("Lines categorized successfully:");
    console.log(`- Trams: ${lines.allTrams.length} (Regular: ${lines.tram.length}, Special: ${lines.tramSpecial.length}, Temporary: ${lines.tramTemporary.length})`);
    console.log(`- Buses: ${lines.allBuses.length} (Regular: ${lines.bus.length}, Night: ${lines.busNight.length}, Express: ${lines.busExpress.length}, etc.)`);
    console.log(`- Unknown: ${lines.unknown.length}`);

    // Clean up ZIP file
    if (fs.existsSync(ZIP_PATH)) {
      fs.unlinkSync(ZIP_PATH);
      console.log("Cleaned up temporary ZIP file");
    }

    return lines;
  } catch (error) {
    console.error("Error fetching GTFS data:", error.message);
    throw error;
  }
};

const fetchLocations = async () => {
  try {
    // Check if GTFS data is available
    if (!gtfsData.lines || (!gtfsData.lines.allBuses.length && !gtfsData.lines.allTrams.length)) {
      console.log("GTFS data not yet available, skipping location fetch");
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
    
    
  } catch (error) {
    console.error("Error fetching locations:", error.message);
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
  if (shapes.has(line)) {
    res.json(shapes.get(line));
  } else {
    res.status(404).json({ error: 'Shape not found for line', line });
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

// Initialize data and start server
const startServer = async () => {
  try {
    await fetchLines();

    setInterval(async () => {
      try {
        await fetchLines();
      } catch (error) {
        console.error("Error refreshing lines:", error.message);
      }
    }, 24 * 60 * 60 * 1000); // Refresh lines every 24 hours
    
    // Start location fetching
    startLocationFetching();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Available endpoints:`);
      console.log(`- GET /lines - Get all categorized lines`);
      console.log(`- GET /lines/:category - Get lines for specific category`);
      console.log(`- GET /locations - Get vehicle locations`);
      console.log(`- GET /health - Health check`);
      console.log(`- GET /alerts - Get recent alerts`);
      console.log(`- GET /shapes/:line - Get shape for specific line`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Graceful shutdown...');
  if (locationInterval) {
    clearInterval(locationInterval);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Graceful shutdown...');
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