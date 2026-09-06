'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');

const config = require('../src/config');
const logger = require('../src/logger');
const { GtfsStore } = require('../src/gtfs/store');
const { VehicleTracker, bearing, normalizeVehicle } = require('../src/vehicles');
const { buildFixtureZip } = require('./fixtures/gtfs');

// A dependency-free fake clock for the scheduling tests below: it swaps in an
// ordered timer queue that we advance on demand, flushing microtasks between
// ticks so promise-backed poll loops settle before we assert. Restored on
// uninstall() so the rest of this file keeps the real clock.
const installFakeClock = () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let now = 0;
  const timers = [];
  const flushMicrotasks = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve();
  };
  const advance = async (ms) => {
    now += ms;
    for (let guard = 0; guard < 100; guard += 1) {
      timers.sort((a, b) => a.fireAt - b.fireAt);
      let fired = false;
      for (const t of timers) {
        if (!t.cancelled && t.fireAt <= now) {
          t.cancelled = true;
          const result = t.cb();
          fired = true;
          if (result && typeof result.then === 'function') await result.catch(() => {});
        }
      }
      await flushMicrotasks();
      if (!fired && !timers.some((t) => !t.cancelled && t.fireAt <= now)) return;
    }
  };
  global.setTimeout = (cb, delay, ...args) => {
    const entry = { fireAt: now + (delay ?? 0), cb, args, cancelled: false };
    timers.push(entry);
    return entry;
  };
  global.clearTimeout = (handle) => {
    if (handle && !handle.cancelled) handle.cancelled = true;
  };
  return {
    advance,
    uninstall: () => {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      timers.length = 0;
    },
  };
};

describe('normalizeVehicle', () => {
  it('maps the MPK payload, where x is latitude', () => {
    const vehicle = normalizeVehicle({ x: 51.107, y: 17.038, name: '4', k: 8123, type: 'tram' });
    assert.equal(vehicle.lat, 51.107);
    assert.equal(vehicle.lon, 17.038);
    assert.equal(vehicle.line, '4');
    assert.equal(vehicle.type, 'tram');
    assert.equal(vehicle.id, '4-8123');
  });

  it('accepts alternative field names', () => {
    const vehicle = normalizeVehicle({ latitude: 51.1, longitude: 17.0, line: '128' });
    assert.equal(vehicle.line, '128');
    assert.equal(vehicle.type, 'bus');
  });

  it('uppercases letter lines so they match the timetable', () => {
    // MPK's feed reports express lines ("A", "K", "N") in lowercase, while the
    // GTFS route_short_name — and therefore /lines and the app's line picker —
    // carries them uppercase. The filter, the route matcher and the merge all
    // compare exact values, so the live name has to be normalised to match.
    const vehicle = normalizeVehicle({ x: 51.1, y: 17.0, name: 'a', k: 1 });
    assert.equal(vehicle.line, 'A');
    assert.equal(vehicle.type, 'busExpress');
    assert.equal(vehicle.id, 'A-1');
  });

  it('rejects positions outside Wrocław', () => {
    assert.equal(normalizeVehicle({ x: 0, y: 0, name: '4' }), null);
    assert.equal(normalizeVehicle({ x: 52.23, y: 21.0, name: '4' }), null, 'that is Warsaw');
    assert.equal(normalizeVehicle({ x: 'n/a', y: 'n/a', name: '4' }), null);
  });

  it('rejects records without a line', () => {
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0 }), null);
    assert.equal(normalizeVehicle({ x: 51.1, y: 17.0, name: '  ' }), null);
  });

  it('never throws on junk', () => {
    assert.equal(normalizeVehicle(null), null);
    assert.equal(normalizeVehicle('nope'), null);
    assert.equal(normalizeVehicle(undefined), null);
  });

  it('derives a stable id when the vehicle number is missing', () => {
    const a = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    const b = normalizeVehicle({ x: 51.1, y: 17.0, name: '4' });
    assert.equal(a.id, b.id);
  });
});

describe('bearing', () => {
  it('points north when moving north', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.2, 17.0)) < 1);
  });

  it('points east when moving east', () => {
    assert.ok(Math.abs(bearing(51.1, 17.0, 51.1, 17.1) - 90) < 1);
  });
});

describe('VehicleTracker against a stand-in endpoint', () => {
  const lines = { allTrams: ['4'], allBuses: ['128'] };

  /**
   * Serves the endpoint the way MPK does: an unrecognised body encoding gets
   * an empty list rather than an error status.
   *
   * @param {(body: string) => object[] | null} handler
   */
  const startEndpoint = (handler) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handler(body) ?? []));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  };

  const originalSources = config.vehicles.sources;
  const servers = [];

  const trackerFor = async (handler) => {
    const server = await startEndpoint(handler);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];
    return new VehicleTracker(() => lines);
  };

  before(() => {
    // fetch() would otherwise be sent through any proxy configured in the env.
    process.env.NO_PROXY = '127.0.0.1,localhost';
  });

  after(() => {
    config.vehicles.sources = originalSources;
    servers.forEach((server) => server.close());
  });

  it('reads positions from the typed body encoding', async () => {
    const tracker = await trackerFor((body) =>
      body.includes('busList%5Bbus%5D%5B%5D')
        ? [{ name: '128', type: 'bus', x: 51.09, y: 17.03, k: 1 }]
        : [],
    );

    await tracker.poll();
    assert.equal(tracker.status.encoding, 'typed');
    assert.equal(tracker.snapshot.count, 1);
  });

  it('falls back to the flat encoding when the typed one is rejected', async () => {
    // This is the failure the old client could not survive: the endpoint
    // answers 200 with an empty list instead of an error.
    const tracker = await trackerFor((body) =>
      body.includes('busList%5B%5D%5B%5D')
        ? [{ name: '4', type: 'tram', x: 51.11, y: 17.03, k: 2 }]
        : [],
    );

    await tracker.poll();
    assert.equal(tracker.status.encoding, 'flat');
    assert.equal(tracker.snapshot.locations[0].line, '4');
  });

  it('keeps the last snapshot and records the error when every encoding fails', async () => {
    const tracker = await trackerFor(() => []);

    await tracker.poll();
    assert.equal(tracker.status.consecutiveFailures, 1);
    assert.match(tracker.status.lastError, /typed:.*flat:/s);
    assert.deepEqual(tracker.snapshot.locations, []);
    assert.equal(tracker.snapshot.stale, true);
  });

  /**
   * MPK's own feed carries no side number, so a vehicle only learns what it is
   * once an Open Data record is merged onto it. Everything else stays without a
   * `fleet` block rather than carrying a row of nulls on every poll.
   */
  it('attaches roster attributes to a vehicle that has a side number', async () => {
    const tracker = await trackerFor((body) =>
      body.includes('busList')
        ? [{ name: '4', type: 'tram', x: 51.11, y: 17.03, k: 11 }]
        : [],
    );

    await tracker.poll();
    assert.equal(tracker.snapshot.locations[0].fleet, undefined, 'nothing known from MPK alone');

    tracker.openDataFleet.set('open-data:2915', {
      id: 'open-data:2915',
      line: '4',
      type: 'tram',
      lat: 51.11,
      lon: 17.03,
      vehicleNumber: 2915,
      brigade: '1',
      positionUpdatedAt: new Date().toISOString(),
      updatedAt: Date.now(),
    });
    await tracker.poll();

    const [vehicle] = tracker.snapshot.locations;
    assert.equal(vehicle.vehicleNumber, 2915);
    assert.equal(vehicle.fleet.model, 'Moderus Beta MF 24 AC');
    assert.equal(vehicle.fleet.airConditioning, true);
    assert.equal(vehicle.fleet.wheelchair, true);
  });

  it('adds a heading once a vehicle has visibly moved', async () => {
    let step = 0;
    const tracker = await trackerFor(() => {
      step += 1;
      return [{ name: '4', type: 'tram', x: 51.11 + step * 0.002, y: 17.03, k: 7 }];
    });

    await tracker.poll();
    assert.equal(tracker.snapshot.locations[0].heading, null, 'no heading from one fix');

    await tracker.poll();
    assert.equal(tracker.snapshot.locations[0].heading, 0, 'moved north');
  });

  it('advances lastUpdated on every poll but keeps mapRevision on a quiet poll', async () => {
    // lastUpdated is the only field that changes every poll. The full /locations
    // format carries it, so fullRevision must advance and the full body gets a
    // fresh ETag. The map format's body cache is keyed on mapRevision, so it
    // still answers 304 — the app stops re-downloading the whole fleet every
    // ten seconds.
    let lat = 51.11;
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: lat, y: 17.03, k: 3 }]);

    await tracker.poll();
    const first = tracker.snapshot.lastUpdated;
    const mapRev0 = tracker.mapRevision;
    const fullRev0 = tracker.fullRevision;
    assert.ok(first, 'a successful poll stamps lastUpdated');

    await tracker.poll();
    assert.notEqual(tracker.snapshot.lastUpdated, first, 'lastUpdated advances every poll');
    assert.equal(tracker.mapRevision, mapRev0, 'mapRevision frozen on a quiet poll');
    assert.equal(tracker.fullRevision, fullRev0 + 1, 'fullRevision advances on a quiet poll');

    lat += 0.01; // the tram moves
    await tracker.poll();
    assert.notEqual(tracker.snapshot.lastUpdated, first, 'a moved vehicle advances lastUpdated');
    assert.equal(tracker.mapRevision, mapRev0 + 1, 'mapRevision advances on a content change');
  });

  it('attaches the destination and next stop when a timetable is loaded', async () => {
    const gtfs = new GtfsStore();
    await gtfs.build(buildFixtureZip());
    gtfs.status.state = 'ready';

    // Between Świdnicka and Oporów on the outbound leg of tram 4.
    const server = await startEndpoint(() => [{ name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 }]);
    servers.push(server);
    config.vehicles.sources = [`http://127.0.0.1:${server.address().port}/bus_position`];

    const tracker = new VehicleTracker(() => lines, { gtfs });
    await tracker.poll();

    const [vehicle] = tracker.snapshot.locations;
    assert.equal(vehicle.trip.towards, 'Oporów');
    assert.equal(vehicle.trip.nextStop.name, 'Oporów');
    assert.equal(vehicle.trip.previousStop.name, 'Świdnicka');
    assert.equal(tracker.status.described, 1);
  });

  it('serves positions with no trip information when there is no timetable', async () => {
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: 51.1, y: 17.0215, k: 9 }]);
    await tracker.poll();

    assert.equal(tracker.snapshot.locations[0].trip, null);
    assert.equal(tracker.status.described, 0);
  });

  it('answers getVehicle in O(1) from the current snapshot only', async () => {
    let lat = 51.11;
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: lat, y: 17.03, k: 5 }]);

    assert.equal(tracker.getVehicle('4-5'), null, 'nothing before the first poll');

    await tracker.poll();
    assert.equal(tracker.getVehicle('4-5').id, '4-5');
    assert.equal(tracker.getVehicle('4-nope'), null);

    lat += 0.01;
    await tracker.poll();
    assert.equal(tracker.getVehicle('4-5').lat, lat, 'the id map is rebuilt every poll');
  });

  it('records rolling performance metrics for every poll', async () => {
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: 51.11, y: 17.03, k: 8 }]);
    await tracker.poll();

    const snap = tracker.performanceSnapshot();
    for (const name of [
      'totalPollMs',
      'fetchMs',
      'normalizationMs',
      'openDataMergeMs',
      'descriptionMs',
      'snapshotBuildMs',
      'incomingVehicleCount',
      'acceptedVehicleCount',
      'descriptionsReused',
      'descriptionsRecomputed',
    ]) {
      assert.ok(snap[name], `metric ${name} exists`);
      assert.equal(snap[name].count, 1, `${name} recorded once`);
      assert.ok(Number.isFinite(snap[name].latest), `${name}.latest is a number`);
    }
    assert.equal(snap.incomingVehicleCount.latest, 1);
    assert.equal(snap.acceptedVehicleCount.latest, 1);

    await tracker.poll();
    assert.equal(tracker.performanceSnapshot().totalPollMs.count, 2, 'metrics accumulate');
  });

  it('never runs a poll while the previous one is still running', async () => {
    const originalInterval = config.vehicles.pollIntervalMs;
    const originalOpenDataUrl = config.vehicles.openDataUrl;
    config.vehicles.pollIntervalMs = 5;
    config.vehicles.openDataUrl = null;

    const tracker = new VehicleTracker(() => lines);
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    tracker.poll = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      completed += 1;
      return tracker.status;
    };
    tracker.pollOpenData = async () => tracker.openDataStatus;

    tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    tracker.stop();

    config.vehicles.pollIntervalMs = originalInterval;
    config.vehicles.openDataUrl = originalOpenDataUrl;

    assert.equal(maxInFlight, 1, 'a slow poll never overlaps its successor');
    assert.ok(completed >= 2, `expected the loop to poll more than once, got ${completed}`);
  });

  it('does not re-arm the loop when stop() lands during an in-flight poll', async () => {
    const originalOpenDataUrl = config.vehicles.openDataUrl;
    config.vehicles.openDataUrl = null;

    let polls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tracker = new VehicleTracker(() => lines);
    tracker.poll = async () => {
      polls += 1;
      await gate;
      return tracker.status;
    };
    tracker.pollOpenData = async () => tracker.openDataStatus;

    tracker.start();
    assert.equal(polls, 1, 'the immediate first poll has started');

    tracker.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 60));

    config.vehicles.openDataUrl = originalOpenDataUrl;
    assert.equal(polls, 1, 'no poll starts after stop(), even one queued behind another');
  });

  it('surfaces per-source health across polls', async () => {
    const originalSources = config.vehicles.sources;
    const originalOpenDataUrl = config.vehicles.openDataUrl;
    config.vehicles.openDataUrl = null;

    const failing = await startEndpoint(() => []);
    servers.push(failing);
    const working = await startEndpoint(() => [
      { name: '4', type: 'tram', x: 51.11, y: 17.03, k: 2 },
    ]);
    servers.push(working);
    const failingUrl = `http://127.0.0.1:${failing.address().port}/bus_position`;
    const workingUrl = `http://127.0.0.1:${working.address().port}/bus_position`;
    config.vehicles.sources = [failingUrl, workingUrl];

    const tracker = new VehicleTracker(() => lines);

    await tracker.poll();
    assert.equal(tracker.status.source, workingUrl, 'the working source answers');
    assert.equal(tracker.status.sources.length, 2);

    const [failingHealth, workingHealth] = tracker.status.sources;
    assert.equal(failingHealth.url, failingUrl);
    assert.equal(failingHealth.consecutiveFailures, 1);
    assert.match(failingHealth.lastError, /no vehicles/);
    assert.ok(failingHealth.lastAttemptAt);
    assert.equal(failingHealth.backoff, false);
    assert.equal(workingHealth.consecutiveFailures, 0);
    assert.ok(workingHealth.lastSuccessAt);

    // The last good source is tried first on the next poll, so the fleet is
    // served without waiting on the known-dead one.
    await tracker.poll();
    assert.equal(tracker.status.source, workingUrl);
    assert.equal(
      tracker.status.sources[0].consecutiveFailures,
      1,
      'the failing source is not hammered on every poll',
    );

    config.vehicles.sources = originalSources;
    config.vehicles.openDataUrl = originalOpenDataUrl;
  });

  it('mapRevision stays put when the fleet is unchanged', async () => {
    const rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await trackerFor(() => rows);

    await tracker.poll();
    const mapRev = tracker.mapRevision;
    const fullRev = tracker.fullRevision;
    assert.equal(tracker.pollRevision, 1, 'poll revision advances on every accepted poll');
    assert.equal(mapRev, 1, 'content revision advances on first poll');

    await tracker.poll(); // identical fleet
    assert.equal(tracker.mapRevision, mapRev, 'quiet poll does not advance mapRevision');
    assert.equal(tracker.fullRevision, fullRev + 1, 'quiet poll advances fullRevision (lastUpdated changed)');
    assert.equal(tracker.pollRevision, 2, 'poll revision still advances');
  });

  it('mapRevision advances on each visible field change', async () => {
    let rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await trackerFor(() => rows);

    await tracker.poll();
    const mapRev0 = tracker.mapRevision;

    // Movement
    rows = [{ name: '4', type: 'tram', x: 51.12, y: 17.032, k: 1 }];
    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0 + 1, 'movement advances mapRevision');

    // Unchanged fleet keeps revision
    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0 + 1, 'quiet poll does not advance mapRevision');

    // Heading change (move far enough to trigger bearing calc)
    rows = [{ name: '4', type: 'tram', x: 51.12, y: 17.04, k: 1 }];
    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0 + 2, 'heading change advances mapRevision');

    // Vehicle added
    rows = [
      { name: '4', type: 'tram', x: 51.12, y: 17.04, k: 1 },
      { name: '128', type: 'bus', x: 51.09, y: 17.03, k: 99 },
    ];
    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0 + 3, 'added vehicle advances mapRevision');

    // Vehicle removed: age out the departed vehicle so the drop logic fires.
    const oldVehicle = tracker.mpkFleet.get('128-99');
    assert.ok(oldVehicle, 'the second vehicle was accepted into the fleet');
    oldVehicle.updatedAt = Date.now() - config.vehicles.staleAfterMs * 2 - 1;
    rows = [{ name: '4', type: 'tram', x: 51.12, y: 17.04, k: 1 }];
    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0 + 4, 'removed vehicle advances mapRevision');
  });

  it('does not advance mapRevision when only updatedAt changes', async () => {
    // updatedAt is a per-poll freshness timestamp, not content. On a quiet poll
    // it must not advance mapRevision (the map body cache stays valid), but
    // fullRevision DOES advance because lastUpdated (snapshot-level) changes
    // and the full format carries it.
    const rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await trackerFor(() => rows);

    await tracker.poll();
    const mapRev0 = tracker.mapRevision;
    const fullRev0 = tracker.fullRevision;
    const ts0 = tracker.snapshot.locations[0].updatedAt;

    await tracker.poll();
    assert.equal(tracker.mapRevision, mapRev0, 'unchanged fleet keeps mapRevision');
    assert.equal(tracker.fullRevision, fullRev0 + 1, 'quiet poll advances fullRevision');
    assert.notEqual(tracker.snapshot.locations[0].updatedAt, ts0, 'updatedAt still ticks');
  });

  it('publishes source and stale on the first successful poll', async () => {
    const tracker = await trackerFor(() => [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }]);

    assert.equal(tracker.snapshot.source, null, 'before the first poll, source is null');
    assert.equal(tracker.snapshot.stale, false);

    await tracker.poll();
    assert.equal(tracker.status.source, config.vehicles.sources[0]);
    assert.equal(tracker.snapshot.source, config.vehicles.sources[0], 'snapshot reflects the successful source immediately');
    assert.equal(tracker.snapshot.stale, false);
  });

  it('clears stale immediately on recovery from a failure', async () => {
    let rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    const tracker = await trackerFor(() => rows);
    await tracker.poll();
    assert.equal(tracker.snapshot.stale, false);

    // Poll fails (empty list = every encoding fails)
    rows = [];
    await tracker.poll();
    assert.equal(tracker.snapshot.stale, true);
    assert.equal(tracker.status.consecutiveFailures, 1);

    // Recovery on the very next poll
    rows = [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }];
    await tracker.poll();
    assert.equal(tracker.status.consecutiveFailures, 0);
    assert.equal(tracker.snapshot.stale, false, 'stale clears immediately, no extra poll needed');
  });

  it('falls back to a working source and reflects it in snapshot.source', async () => {
    const originalOpenDataUrl = config.vehicles.openDataUrl;
    config.vehicles.openDataUrl = null;

    const failing = await startEndpoint(() => []);
    const working = await startEndpoint(() => [{ name: '4', type: 'tram', x: 51.11, y: 17.032, k: 1 }]);
    servers.push(failing, working);
    config.vehicles.sources = [
      `http://127.0.0.1:${failing.address().port}/bus_position`,
      `http://127.0.0.1:${working.address().port}/bus_position`,
    ];

    const tracker = new VehicleTracker(() => lines);
    await tracker.poll();
    assert.equal(tracker.status.source, config.vehicles.sources[1], 'the working source answers');
    assert.equal(tracker.snapshot.source, config.vehicles.sources[1], 'snapshot reflects the fallback in the same cycle');
    assert.equal(tracker.snapshot.stale, false);

    config.vehicles.openDataUrl = originalOpenDataUrl;
    config.vehicles.sources = originalSources;
  });
});

describe('VehicleTracker poll scheduling (fake timers)', () => {
  const lines = { allTrams: ['4'], allBuses: ['128'] };
  let clock;
  let originalInterval;
  let originalOpenDataUrl;
  let originalOpenDataInterval;

  beforeEach(() => {
    originalInterval = config.vehicles.pollIntervalMs;
    originalOpenDataUrl = config.vehicles.openDataUrl;
    originalOpenDataInterval = config.vehicles.openDataPollIntervalMs;
    clock = installFakeClock();
  });

  afterEach(() => {
    clock.uninstall();
    config.vehicles.pollIntervalMs = originalInterval;
    config.vehicles.openDataUrl = originalOpenDataUrl;
    config.vehicles.openDataPollIntervalMs = originalOpenDataInterval;
  });

  // A tracker whose poll is a synchronous stand-in: it lets us count poll runs
  // without touching the network, so the clock advances deterministically.
  const trackerWithMockPoll = (poll) => {
    const tracker = new VehicleTracker(() => lines);
    tracker.poll = poll;
    return tracker;
  };

  it('start() runs one immediate poll and arms exactly one future timer', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataUrl = null;
    let polls = 0;
    const tracker = trackerWithMockPoll(async () => { polls += 1; return tracker.status; });

    tracker.start();
    await clock.advance(0);

    assert.equal(polls, 1, 'one immediate poll');
    assert.ok(tracker.timer, 'exactly one future timer is armed');
    assert.equal(tracker.openDataTimer, null, 'no open-data timer while the source is disabled');
    tracker.stop();
  });

  it('start() twice does not start a second loop', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataUrl = null;
    let polls = 0;
    const tracker = trackerWithMockPoll(async () => { polls += 1; return tracker.status; });

    tracker.start();
    tracker.start();
    await clock.advance(0);

    assert.equal(polls, 1, 'the guard at the top of start() skips the second run');
    assert.ok(tracker.timer, 'a single armed timer, not two');
    tracker.stop();
  });

  it('a completed poll re-arms exactly one next timer', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataUrl = null;
    let polls = 0;
    const tracker = trackerWithMockPoll(async () => { polls += 1; return tracker.status; });

    tracker.start();
    await clock.advance(0);
    assert.equal(polls, 1);
    assert.ok(tracker.timer, 'one future timer after the first poll settles');

    await clock.advance(1000);
    assert.equal(polls, 2, 'the single future timer fired exactly one poll');
    assert.ok(tracker.timer, 'the loop re-armed itself once');
    tracker.stop();
  });

  it('a poll that throws still arms exactly one next timer', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataUrl = null;
    let polls = 0;
    const tracker = trackerWithMockPoll(async () => { polls += 1; throw new Error('boom'); });

    const logged = [];
    const originalError = logger.error;
    logger.error = (...args) => logged.push(args.join(' '));
    try {
      tracker.start();
      await clock.advance(0);
      assert.equal(polls, 1, 'the immediate poll ran even though it threw');
      assert.ok(tracker.timer, 'a throwing poll still arms one next timer');
      assert.equal(logged.length, 1, 'the throw is logged loudly, not swallowed');
    } finally {
      logger.error = originalError;
      tracker.stop();
    }
  });

  it('stop() during an in-flight poll leaves zero future timers', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataUrl = null;
    let polls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tracker = trackerWithMockPoll(async () => { polls += 1; await gate; return tracker.status; });

    tracker.start();
    await clock.advance(0);
    assert.equal(polls, 1, 'the immediate poll is in flight');
    assert.ok(tracker.timer, 'a placeholder timer is held while the poll is in flight');

    tracker.stop();
    assert.equal(tracker.timer, null, 'stop() clears the timer immediately');

    release();
    await clock.advance(0);
    assert.equal(tracker.timer, null, 'no timer is re-armed after stop()');
    assert.equal(polls, 1, 'no second poll runs after stop()');
  });

  it('the open-data source follows the same single-owner lifecycle', async () => {
    config.vehicles.pollIntervalMs = 1000;
    config.vehicles.openDataPollIntervalMs = 1000;
    config.vehicles.openDataUrl = 'http://127.0.0.1:1/open-data';
    let mpkPolls = 0;
    let odPolls = 0;
    const tracker = new VehicleTracker(() => lines);
    tracker.poll = async () => { mpkPolls += 1; return tracker.status; };
    tracker.pollOpenData = async () => { odPolls += 1; return tracker.openDataStatus; };

    tracker.start();
    await clock.advance(0);

    assert.equal(mpkPolls, 1, 'one MPK poll');
    assert.equal(odPolls, 1, 'one open-data poll');
    assert.ok(tracker.timer, 'MPK timer armed');
    assert.ok(tracker.openDataTimer, 'open-data timer armed');

    await clock.advance(1000);
    assert.equal(mpkPolls, 2, 'one MPK re-arm');
    assert.equal(odPolls, 2, 'one open-data re-arm');

    tracker.stop();
    assert.equal(tracker.timer, null);
    assert.equal(tracker.openDataTimer, null);
  });
});
