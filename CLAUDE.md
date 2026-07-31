# CLAUDE.md

Context for Claude Code working in this repo. Read this before changing anything.

## What this is

Live map of Wrocław's trams and buses. Two halves:

- `server/` — Express (CommonJS, Node ≥ 20). Discovers and ingests the city's
  GTFS feed, polls MPK for vehicle positions, scrapes service notices.
- `app/` — Expo SDK 57 (React Native 0.86, React 19.2). iOS + Android.

## Commands

```bash
# server
cd server && npm install
npm test            # no network needed
npm run lint
npm run doctor      # checks every upstream source against the real internet
npm start           # first boot takes 30–60s (feed discovery + ingest)
curl localhost:3000/health   # says what actually loaded

# app
cd app && npm install
npx expo start
npx expo-doctor              # run after any dependency change
npx expo install --fix       # pins expo-* to the SDK
```

Tests must pass before you commit. They are fast and need no network — there is
no excuse for skipping them.

## Invariants

These are not style preferences. Each one is a bug that already happened.

**1. Never hardcode a GTFS download URL.**
Resolution lives in `server/src/gtfs/catalogue.js`: the CUI data API
(`api.open-data.cui.wroclaw.pl/od2/6/`) → the legacy CKAN instance → the
dane.gov.pl mirror. A hardcoded resource UUID on the old `wroclaw.pl/open-data`
portal is precisely what killed this project when the city retired that portal
in April 2026. `GTFS_URLS` exists as a debugging escape hatch; setting it in
production re-creates the original failure, and the server logs a warning when
it is set.

**2. The feed archive contains future-dated timetables.**
`/od2/6/` returns every dated snapshot, not the current one. On 2026-07-30 the
listing already carried `GTFS_01082026`, effective two days later. Taking the
newest entry serves a schedule that is not in force and shows wrong departure
times with no error anywhere. Selection is *latest effective date ≤ today* —
`orderByEffectiveDate()`. Tests are pinned to both 2026-07-30 and 2026-08-01; if
you change selection logic and those fail, you have reintroduced the bug.

**3. Snapshots are not uniformly complete.**
The archive interleaves ~11 MB feeds with ~6 MB ones, and a short snapshot can
be missing `shapes.txt`, which leaves the map with no route geometry at all —
looking like a rendering bug rather than a data problem. `assertComplete()` runs
per candidate inside the download loop and falls through to the next. Keep the
validation inside that loop.

**4. The server answers 503 while ingesting.**
For up to a minute after boot, `/lines` and friends return `{error, state}` with
status 503 and a `Retry-After` header. The app once parsed that as data and set
it as the line list, which crashed the picker on every cold start. **Every** app
request goes through `apiGet()` in `app/api.js`, which retries 503 with backoff;
`normaliseLines()` validates the payload before it reaches state. Do not call
`fetch` directly in a component.

**5. Shape points have changed format twice.**
GTFS column names (`shape_pt_lat`) → `{lat, lon}` → compact `[lat, lon]` pairs.
When the server switched the first time, the map kept reading the old names,
every coordinate parsed as `NaN`, the filter dropped them all, and `<Polyline>`
silently rendered nothing. `toCoordinates()` accepts all three — if you change
the wire format again, change it there and nowhere else.

**6. `/shapes/:line` stays backwards compatible.**
It returns the verbose legacy payload by default and the compact one only for
`?format=compact`, so app builds already on people's phones keep working after
a server deploy.

**7. Amber is for countdowns.**
`color.amber` in `app/theme.js` is reserved for departure minutes. It is the one
loud colour in the app and it works because nothing else competes for it. If you
need emphasis elsewhere, use weight or spacing.

**8. Line colours must clear 4.5:1 on white.**
The original palette put white text on `#F8E71C` at roughly 1.4:1 — illegible in
the sunlight you are standing in at a stop. Check any new value before adding it
to `lineColor`.

**9. `npm test` uses an unquoted glob on purpose.**
`node --test test/*.test.js`. The runner only expands globs itself from Node 22;
quoting the pattern passes it through literally and the job fails in 0s on
anything older. Let the shell expand it.

**10. Anything the server schedules must be stoppable.**
`stopBackgroundWork()` exists because the cron task keeps the event loop alive,
so `test/boot.test.js` hung forever without it.

**11. Do not reintroduce `react-native-map-clustering`.**
It was imported nowhere, has not been published since 2021, and pins an old
`react-native-maps`. It would block the next SDK upgrade the same way it blocked
this one.

**12. Do not declare capabilities the app does not use.**
`expo-notifications` was in the config with an iOS usage string and no code
behind it. An unused permission is an App Review question you cannot answer.

## Fragile by nature

`parsePage()` in `server/src/alerts.js` scrapes MPK's service-notice pages.
There is no API — the X/Twitter timeline it used to read has needed a paid tier
since 2023, which is why `/alerts` silently returned `[]` for a year. HTML
scraping is the most likely thing here to break.

It fails soft: when every provider fails the previous list stays in place, and
the reason shows up in `/health` under `alerts.providers[].lastError`. If alerts
go stale, check that field first, then the keyword lists in `parsePage()`. A page
that serves RSS is auto-detected and parsed as a feed instead.

`parseFileListing()` is deliberately shape-agnostic — it walks the JSON looking
for url-ish and name-ish fields rather than hardcoding a schema, because the CUI
portal's response format is not documented anywhere verifiable. On startup the
log prints which snapshot it chose:

```
catalogue lists 18 snapshot(s); using OtwartyWroclaw_rozklad_jazdy_GTFS_25072026
```

If that count is 0 or the name looks wrong, the parser needs adjusting to the
real payload — that is the first thing to check when the feed goes stale. Capture
it with `curl -s https://api.open-data.cui.wroclaw.pl/od2/6/ | head -c 2000`.

## How to work here

- **Add a test for every bug you fix.** Not ceremony. `findStopsNear` uses real
  haversine distances rather than a lat/lon grid specifically because a degree of
  longitude is ~0.63 of a degree of latitude at Wrocław's latitude, and a naive
  grid under-searches east and west; the test pins that.
- **Do not gate PRs on third-party uptime.** Any job that reaches out to MPK or
  the city portal belongs on a schedule that opens an issue, not on a merge gate.
  US-based runners plus a municipal WAF will block merges for reasons unrelated
  to the diff.
- **Prefer failing soft on upstream, loudly on our own bugs.** A stale feed
  should keep serving the last good data and say so in `/health`. A programming
  error should throw.
- Keep the app's Polish copy in Polish, sentence case, no filler.

## Previewing the app without a device

`react-native-maps` is native-only, so the app cannot actually run in a browser.
`app/metro.config.js` swaps it for `app/.preview/maps-stub.js` **on web only**,
which makes `npx expo export --platform web` both a real compile check and a way
to render every other part of the UI:

```bash
cd app && API_URL=http://localhost:3000 npx expo export --platform web --output-dir /tmp/web
python3 -m http.server 4620 --directory /tmp/web
```

The map area will be an empty grey box. That is the stub, not a bug.

## Open work

- Nothing here has been run against the real MPK or city endpoints — the sandbox
  this was built in blocks them. `npm run doctor` from a normal network is the
  first thing to do, and it will say which sources answer.
- The app has not been run on a simulator or device. `npx expo start` is the real
  check — especially the font load and the departures sheet's clearance above the
  tab bar.
- Production still runs the pre-2026 server and has never been redeployed.
- Before store submission: backend on HTTPS with a real hostname, `API_URL` set
  in the EAS production profile, privacy policy URL, Play Data Safety and Apple
  privacy labels.
