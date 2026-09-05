import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { ApiError, apiGet, normaliseLines, normaliseLocations, normaliseShape } from '../src/lib/api.ts';
import { API_URL } from '../src/lib/config.ts';

/** A `Response` good enough for `apiGet`, without pulling in a HTTP server. */
const reply = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }) as unknown as Response;

/** Queue a series of replies; each call to fetch takes the next one. */
const fetchReturning = (...responses: Response[]) => {
  const calls: string[] = [];
  let i = 0;
  const fake = async (url: string) => {
    calls.push(url);
    return responses[Math.min(i++, responses.length - 1)];
  };
  mock.method(globalThis, 'fetch', fake);
  return calls;
};

afterEach(() => mock.restoreAll());

describe('apiGet and the boot-time 503', () => {
  // Invariant 7: for up to a minute after boot the server answers 503 with
  // {error, state}. Parsing that as data is what used to crash the line picker
  // on every cold start, so it must be retried, never returned.
  it('retries a 503 and returns the payload that follows', async () => {
    const calls = fetchReturning(
      reply(503, { error: 'Loading timetable', state: 'ingesting' }, { 'retry-after': '0' }),
      reply(200, { allTrams: ['1'], allBuses: ['A'] }, {}),
    );

    const data = await apiGet<{ allTrams: string[] }>('/lines');

    assert.equal(calls.length, 2, 'should have retried once');
    assert.deepEqual(data, { allTrams: ['1'], allBuses: ['A'] });
  });

  it('never returns the 503 body as data', async () => {
    // Eight retries are configured; a server that never finishes must raise
    // rather than hand {error, state} to a caller expecting a payload.
    fetchReturning(reply(503, { error: 'Loading timetable' }, { 'retry-after': '0' }));

    await assert.rejects(
      () => apiGet('/lines'),
      (error: ApiError) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 503);
        assert.equal(error.message, 'Loading timetable');
        return true;
      },
    );
  });

  it('gives up immediately when the caller is a poll', async () => {
    const calls = fetchReturning(reply(503, { error: 'Loading timetable' }));

    await assert.rejects(() => apiGet('/locations', { retryWhileLoading: false }));
    assert.equal(calls.length, 1, 'a poll comes round again by itself');
  });

  it('requests the path against the configured API', async () => {
    const calls = fetchReturning(reply(200, { allTrams: [], allBuses: [] }));
    await apiGet('/lines');
    assert.equal(calls[0], `${API_URL}/lines`);
  });
});

describe('apiGet conditional requests', () => {
  it('reuses the cached body on a 304', async () => {
    const path = `/locations?test=${Math.random()}`;
    fetchReturning(reply(200, { locations: [] }, { etag: '"abc"' }));
    const first = await apiGet(path);

    fetchReturning(reply(304, null, { etag: '"abc"' }));
    const second = await apiGet(path);

    assert.deepEqual(second, first, 'a 304 must reuse the payload we already hold');
  });

  it('raises rather than returning nothing for a 304 it cannot satisfy', async () => {
    fetchReturning(reply(304, null));
    await assert.rejects(() => apiGet(`/never-seen-${Math.random()}`), {
      name: 'ApiError',
    });
  });
});

describe('normaliseShape', () => {
  // Invariant 8: shape points have changed format twice. The server now emits
  // compact [lat, lon] pairs and this is the single reader. When the server
  // changed format the first time, the old reader parsed every coordinate as
  // NaN and the route silently stopped drawing — so anything that is not a
  // pair of finite numbers must be rejected loudly, not filtered to nothing.
  it('reads compact [lat, lon] pairs', () => {
    const shape = normaliseShape({ points: [[51.1, 17.03], [51.2, 17.04]] });
    assert.deepEqual(shape.points, [[51.1, 17.03], [51.2, 17.04]]);
  });

  it('rejects the GTFS column format the server stopped sending', () => {
    assert.throws(
      () => normaliseShape({ points: [{ shape_pt_lat: '51.1', shape_pt_lon: '17.03' }] }),
      { message: 'Route has no geometry' },
    );
  });

  it('rejects the {lat, lon} object format the server stopped sending', () => {
    assert.throws(() => normaliseShape({ points: [{ lat: 51.1, lon: 17.03 }] }), {
      message: 'Route has no geometry',
    });
  });

  it('drops an individual malformed point but keeps the good ones', () => {
    const shape = normaliseShape({
      points: [[51.1, 17.03], [null, 17.04], ['x', 'y'], [51.2, 17.05]],
    });
    assert.deepEqual(shape.points, [[51.1, 17.03], [51.2, 17.05]]);
  });

  it('raises on a payload that is not a shape at all', () => {
    for (const payload of [null, undefined, {}, { points: 'nope' }]) {
      assert.throws(() => normaliseShape(payload), { name: 'ApiError' });
    }
  });

  it('defaults stops to an empty list rather than undefined', () => {
    assert.deepEqual(normaliseShape({ points: [[51.1, 17.03]] }).stops, []);
  });
});

describe('normaliseLines', () => {
  it('raises when the required categories are missing', () => {
    // This is the payload the 503 used to deliver; it must never become state.
    for (const payload of [{ error: 'Loading', state: 'ingesting' }, {}, null, []]) {
      assert.throws(() => normaliseLines(payload), { name: 'ApiError' });
    }
  });

  it('keeps only the string arrays', () => {
    const lines = normaliseLines({ allTrams: ['1', '6'], allBuses: ['A'], junk: 7 });
    assert.deepEqual(lines.allTrams, ['1', '6']);
    assert.ok(!('junk' in lines));
  });
});

describe('normaliseLocations', () => {
  it('drops a vehicle with no usable position', () => {
    const { locations, count } = normaliseLocations({
      locations: [
        { id: 'a', line: '4', lat: 51.1, lon: 17.03 },
        { id: 'b', line: '4', lat: null, lon: 17.03 },
        { id: 'c' },
        'nonsense',
      ],
    });
    assert.equal(count, 1);
    assert.equal(locations[0].id, 'a');
  });

  it('carries the occupancy the Kłosok feed states', () => {
    // GTFS-RT gives these for the suburban operator; they survive the wire so
    // a surface can draw them.
    const { locations } = normaliseLocations({
      locations: [
        {
          id: 'klosok:1',
          line: '917',
          lat: 51.1,
          lon: 17.03,
          occupancyStatus: 'MANY_SEATS_AVAILABLE',
          occupancyPercentage: 35,
        },
      ],
    });
    assert.equal(locations[0].occupancyStatus, 'MANY_SEATS_AVAILABLE');
    assert.equal(locations[0].occupancyPercentage, 35);
  });

  it('raises on a payload that is not a fleet', () => {
    assert.throws(() => normaliseLocations({ error: 'Loading' }), { name: 'ApiError' });
  });
});
