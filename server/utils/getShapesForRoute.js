'use strict';

var fs = require('fs');
var path = require('path');

var GTFS_PATH = path.join(__dirname, '/../data/gtfs/');

// Cache for parsed CSV files
var fileCache = {};

// Cache for route results
var routeCache = {};

// Improved CSV parser with better performance
function parseCSV(content) {
  var lines = content.trim().split('\n');
  var headers = lines[0].split(',').map(function(h) { 
    return h.trim().replace(/(^"|"$)/g, '');
  });
  
  return lines.slice(1).map(function(line) {
    var values = [];
    var current = '';
    var inQuotes = false;
    
    // Using for loop is faster than string methods for this case
    for (var i = 0; i < line.length; i++) {
      var char = line[i];
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

    // Using object literal is faster than dynamic assignment
    return headers.reduce(function(obj, header, index) {
      obj[header] = values[index] ? values[index].trim() : '';
      return obj;
    }, {});
  });
}

// Read CSV with caching
function readCSV(filename) {
  if (fileCache[filename]) {
    return fileCache[filename];
  }

  try {
    var fullpath = path.join(GTFS_PATH, filename);
    var content = fs.readFileSync(fullpath, 'utf8');
    var parsed = parseCSV(content);
    fileCache[filename] = parsed;
    return parsed;
  } catch (error) {
    console.error('Error reading file ' + filename + ':', error.message);
    return [];
  }
}

// Main function with caching and optimizations
function getShapesForRoute(routeShortName) {
  // Check cache first
  if (routeCache[routeShortName]) {
    return routeCache[routeShortName];
  }

  // 1. Get routes
  var routes = readCSV('routes.txt');
  var routeIds = routes
    .filter(function(r) { return r.route_short_name === routeShortName; })
    .map(function(r) { return r.route_id; });

  var routeIdsSet = {};
  routeIds.forEach(function(id) { routeIdsSet[id] = true; });

  if (routeIds.length === 0) {
    console.error('No route found: ' + routeShortName);
    return null;
  }

  // 2. Get trips
  var trips = readCSV('trips.txt');
  var shapeIds = {};
  trips.forEach(function(trip) {
    if (routeIdsSet[trip.route_id] && trip.shape_id) {
      shapeIds[trip.shape_id] = true;
    }
  });

  if (Object.keys(shapeIds).length === 0) {
    console.error('No shape_id found for route: ' + routeShortName);
    return null;
  }

  // 3. Get shapes
  var shapes = readCSV('shapes.txt');
  var shapesById = {};

  // Pre-filter shapes for better performance
  shapes.forEach(function(shape) {
    if (shapeIds[shape.shape_id]) {
      if (!shapesById[shape.shape_id]) {
        shapesById[shape.shape_id] = [];
      }
      shapesById[shape.shape_id].push({
        lat: parseFloat(shape.shape_pt_lat),
        lon: parseFloat(shape.shape_pt_lon),
        seq: parseInt(shape.shape_pt_sequence, 10)
      });
    }
  });

  // Sort points
  Object.keys(shapesById).forEach(function(shapeId) {
    shapesById[shapeId].sort(function(a, b) { 
      return a.seq - b.seq;
    });
  });
  
  // Cache the result
  routeCache[routeShortName] = shapesById;
  
  return shapesById;
}

// Clear caches if memory needs to be freed
getShapesForRoute.clearCache = function() {
  fileCache = {};
  routeCache = {};
};

module.exports = getShapesForRoute;

const stopsCache = {};
// Function to get stops for a route

function getStopsForRoute(routeShortName) {
  if (stopsCache[routeShortName]) {
    return stopsCache[routeShortName];
  }

  // 1. Get routes
  var routes = readCSV('routes.txt');
  var routeIds = routes
    .filter(function(r) { return r.route_short_name === routeShortName; })
    .map(function(r) { return r.route_id; });

  if (routeIds.length === 0) {
    console.error('No route found: ' + routeShortName);
    return null;
  }

  // 2. Get trips
  var trips = readCSV('trips.txt');
  var tripIds = trips
    .filter(function(t) { return routeIds.includes(t.route_id); })
    .map(function(t) { return t.trip_id; });

  if (tripIds.length === 0) {
    console.error('No trips found for route: ' + routeShortName);
    return null;
  }

  // 3. Get stop times
  var stopTimes = readCSV('stop_times.txt');
  var stops = {};

  stopTimes.forEach(function(stopTime) {
    if (tripIds.includes(stopTime.trip_id)) {
      stops[stopTime.stop_id] = {
        arrival_time: stopTime.arrival_time,
        departure_time: stopTime.departure_time,
        stop_sequence: parseInt(stopTime.stop_sequence, 10)
      };
    }
  });

  // Cache the result
  stopsCache[routeShortName] = stops;

  return stops;
}

// Export the function
module.exports.getStopsForRoute = getStopsForRoute;