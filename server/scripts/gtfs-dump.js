'use strict';

/**
 * Digest of every query-visible value the GTFS store produces, for
 * differential testing between versions. Output is deterministic JSON.
 *
 * Usage: node scripts/gtfs-dump.js > before.json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { GtfsStore } = require('../src/gtfs/store');

const hashPoints = (points) => crypto.createHash('sha1').update(Buffer.from(points.buffer)).digest('hex');

const main = async () => {
  const zipPath =
    process.argv[2] ?? path.join(require('../src/config').gtfs.cacheDir, 'gtfs.zip');
  const store = new GtfsStore();
  await store.build(fs.readFileSync(zipPath));

  const variants = {};
  for (const [line, list] of store.variantsByLine) {
    variants[line] = list.map((variant) => ({
      shapeId: variant.shapeId,
      directionId: variant.directionId,
      headsign: variant.headsign,
      direction: variant.direction,
      lengthMeters: Math.round(variant.lengthMeters),
      tripCount: variant.tripCount,
      trips: [...variant.trips],
      pointsHash: hashPoints(variant.points),
      stops: variant.stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        alongMeters: Math.round(stop.alongMeters * 100) / 100,
        arrivalOffset: stop.arrivalOffset,
        departureOffset: stop.departureOffset,
        arrival: stop.arrival,
        departure: stop.departure,
      })),
    }));
  }

  const now = new Date('2026-08-01T12:00:00+02:00');
  const sampleStops = [...store.stopsById.keys()].slice(0, 60);
  const departures = {};
  for (const stopId of sampleStops) {
    departures[stopId] = store.getDepartures(stopId, { now, limit: 10 }).map((entry) => ({
      line: entry.line,
      headsign: entry.headsign,
      departure: entry.departure,
      inSeconds: entry.inSeconds,
      serviceDay: entry.serviceDay,
      tripId: entry.tripId,
    }));
  }

  const matches = [];
  for (const line of store.variantsByLine.keys()) {
    for (let i = 0; i < 8; i += 1) {
      const lat = 51.05 + ((i * 37) % 100) / 1000;
      const lon = 16.97 + ((i * 53) % 100) / 1000;
      const heading = (i * 47) % 360;
      const match = store.matchVariant(line, lat, lon, { heading });
      matches.push({
        line,
        lat,
        lon,
        heading,
        shapeId: match?.variant.shapeId ?? null,
        distance: match?.projection ? Math.round(match.projection.distance) : null,
        along: match?.projection ? Math.round(match.projection.along) : null,
        index: match?.projection?.index ?? null,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        counts: store.status.counts,
        tripStart: [...store.tripStart.slice(0, 200)],
        tripEnd: [...store.tripEnd.slice(0, 200)],
        stopTimesTrip: [...store.stopTimes.trip.slice(0, 5000)],
        stopTimesArrival: [...store.stopTimes.arrival.slice(0, 5000)],
        stopTimesDeparture: [...store.stopTimes.departure.slice(0, 5000)],
        departuresByStop: [...store.departuresByStop].map(([stopId, rows]) => [
          stopId,
          [...rows.slice(0, 200)],
        ]),
        variants,
        departures,
        matches,
      },
      null,
      0,
    ),
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
