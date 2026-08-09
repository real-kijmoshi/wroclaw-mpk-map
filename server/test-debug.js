const { GtfsStore } = require('./src/gtfs/store');
const { describeVehicle } = require('./src/progress');
const { buildFixtureZip } = require('./test/fixtures/gtfs');
const { secondsToTime } = require('./src/gtfs/parse');

(async () => {
  const gtfs = new GtfsStore();
  await gtfs.build(buildFixtureZip());
  gtfs.status.state = 'ready';

  const vehicle = {
    id: '4-1',
    line: '4',
    type: 'tram',
    lat: 51.11,
    lon: 17.032,
    heading: 90,
  };

  // Use same time as the test suite: 08:07 Warsaw on 2026-06-15 (Monday)
  const testNow = new Date('2026-06-15T06:07:00.000Z');
  const result = describeVehicle(gtfs, vehicle, { limit: 40, now: testNow });
  console.log('=== With test time (08:07 Warsaw) ===');
  console.log('delaySeconds:', result?.delaySeconds);
  console.log('tripId:', result?.tripId);
  console.log('scheduleMatched:', result?.scheduleMatched);

  // Use current time
  const result2 = describeVehicle(gtfs, vehicle, { limit: 40 });
  console.log('=== With current time (', new Date().toISOString(), ') ===');
  console.log('delaySeconds:', result2?.delaySeconds);
  console.log('tripId:', result2?.tripId);
  console.log('scheduleMatched:', result2?.scheduleMatched);

  // Check variant trips
  const match = gtfs.matchVariant(vehicle.line, vehicle.lat, vehicle.lon, { heading: vehicle.heading });
  console.log('=== matchVariant ===');
  console.log('shapeId:', match?.variant.shapeId);
  console.log('trips length:', match?.variant?.trips?.length);
  if (match?.variant?.trips) {
    console.log('=== first 5 trips ===');
    for (let i = 0; i < Math.min(5, match.variant.trips.length); i++) {
      const tripIdx = match.variant.trips[i];
      const t = gtfs.trips[tripIdx];
      const start = gtfs.tripStart[tripIdx];
      const activeToday = t ? gtfs.isServiceActive(t.serviceId, testNow) : 'no trip';
      const activeNow = t ? gtfs.isServiceActive(t.serviceId, new Date()) : 'no trip';
      console.log(`  trip[${i}]: id=${t?.id}, serviceId=${t?.serviceId}, start=${start} (${secondsToTime(start)}), active_today=${activeToday}, active_now=${activeNow}`);
    }
  }
})();
