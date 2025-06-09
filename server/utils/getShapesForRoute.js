const fs = require('fs');
const path = require('path');

const GTFS_PATH = path.join(__dirname, '/../data/gtfs/');

// Prosty parser CSV (bez zewnętrznych pakietów)
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines.shift().split(',').map(h => h.trim().replace(/(^"|"$)/g, ''));
  return lines.map(line => {
    // Obsługa przecinków w cudzysłowie
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);
    // Mapowanie do obiektu
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = values[i] ? values[i].trim() : '';
    }
    return obj;
  });
}

// Funkcja do odczytu pliku CSV i parsowania
function readCSV(filename) {
  const fullpath = path.join(GTFS_PATH, filename);
  const content = fs.readFileSync(fullpath, 'utf8');
  return parseCSV(content);
}

// Główna funkcja
function getShapesForRoute(routeShortName) {
  // 1. Wczytujemy routes.txt
  const routes = readCSV('routes.txt');

  // Znajdź route_id pasujące do routeShortName
  const routeIds = routes
    .filter(r => r.route_short_name === routeShortName)
    .map(r => r.route_id);

  if (routeIds.length === 0) {
    console.error(`Nie znaleziono trasy: ${routeShortName}`);
    return null;
  }

  // 2. Wczytujemy trips.txt
  const trips = readCSV('trips.txt');

  // Znajdź shape_id dla route_id
  const shapeIds = new Set();
  trips.forEach(trip => {
    if (routeIds.includes(trip.route_id) && trip.shape_id) {
      shapeIds.add(trip.shape_id);
    }
  });

  if (shapeIds.size === 0) {
    console.error(`Nie znaleziono shape_id dla trasy: ${routeShortName}`);
    return null;
  }

  // 3. Wczytujemy shapes.txt
  const shapes = readCSV('shapes.txt');

  // Zbierz punkty shape dla znalezionych shape_id
  const shapesById = {};
  shapes.forEach(shape => {
    if (shapeIds.has(shape.shape_id)) {
      if (!shapesById[shape.shape_id]) shapesById[shape.shape_id] = [];
      shapesById[shape.shape_id].push({
        lat: parseFloat(shape.shape_pt_lat),
        lon: parseFloat(shape.shape_pt_lon),
        seq: parseInt(shape.shape_pt_sequence, 10)
      });
    }
  });

  // Posortuj punkty wg sequence
  for (const shapeId in shapesById) {
    shapesById[shapeId].sort((a, b) => a.seq - b.seq);
  }

  return shapesById;
}

module.exports = getShapesForRoute;
