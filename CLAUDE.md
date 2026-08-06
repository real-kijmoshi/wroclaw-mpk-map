# CLAUDE.md

Context for Claude Code working in this repo. Read this before changing anything.

## What this is

Live map of Wrocław's trams and buses. Two halves:

- `server/` — Express (CommonJS, Node ≥ 22). Discovers and ingests the city's
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

**2. `/od2/6/` returns file ids, not files.**
The dataset payload is `{id: 6, active: true, pliki: [119, 117, 121, …]}` —
about 66 bare integers, ordered newest upload first. Each one has to be
resolved separately, and no metadata endpoint has been found — `/od2/6/<id>/`
is a 404. The download URL is `https://open-data.cui.wroclaw.pl/hdb/download/<id>/`
(`GTFS_DOWNLOAD_BASE`), which is what the portal's "Pobierz" buttons point at.
Only the first `GTFS_MAX_FILE_LOOKUPS` ids are resolved; nothing older can be
the timetable in force. `resolveFileEntries()` probes a few endpoint shapes and
then reuses whichever answered rather than probing per file.

**3. The archive is the authority on its own dates.**
Filenames are a convention and the metadata endpoint may not answer at all —
`/od2/6/<id>/` is a 404 in production. `readEffectiveWindow()` reads
`feed_info.txt` (or the span of `calendar.txt`) out of the downloaded zip, and
`isInForce()` is what the download loop uses to skip a future-dated snapshot
when the candidates arrive without names. If nothing is in force, the first
valid archive is used anyway — a stale timetable beats none.

**4. The feed archive contains future-dated timetables.**
The archive holds every dated snapshot, not just the current one. On 2026-07-30 the
listing already carried `GTFS_01082026`, effective two days later. Taking the
newest entry serves a schedule that is not in force and shows wrong departure
times with no error anywhere. Selection is *latest effective date ≤ today* —
`orderByEffectiveDate()`. Observed live on 2026-07-31: the portal listed
`GTFS_01082026` alongside `GTFS_25072026`, and only the latter was in force.
Tests are pinned to that date and to 2026-08-01; if you change selection logic
and those fail, you have reintroduced the bug.

**5. Look tables up by file name, not by path.**
Some publishers ship `shapes.txt` at the root and others nest it in a folder
(`GTFS/shapes.txt`). `zip.getEntry('shapes.txt')` silently misses the nested
layout, which then reads as a feed with no route geometry — the dane.gov.pl
mirror was rejected in production for exactly this. Go through `findEntry()`.

**6. Snapshots are not uniformly complete.**
The archive interleaves ~11 MB feeds with ~6 MB ones, and a short snapshot can
be missing `shapes.txt`, which leaves the map with no route geometry at all —
looking like a rendering bug rather than a data problem. `assertComplete()` runs
per candidate inside the download loop and falls through to the next. Keep the
validation inside that loop.

**7. The server answers 503 while ingesting.**
For up to a minute after boot, `/lines` and friends return `{error, state}` with
status 503 and a `Retry-After` header. The app once parsed that as data and set
it as the line list, which crashed the picker on every cold start. **Every** app
request goes through `apiGet()` in `app/api.js`, which retries 503 with backoff;
`normaliseLines()` validates the payload before it reaches state. Do not call
`fetch` directly in a component.

**8. Shape points have changed format twice.**
GTFS column names (`shape_pt_lat`) → `{lat, lon}` → compact `[lat, lon]` pairs.
When the server switched the first time, the map kept reading the old names,
every coordinate parsed as `NaN`, the filter dropped them all, and `<Polyline>`
silently rendered nothing. `toCoordinates()` accepts all three — if you change
the wire format again, change it there and nowhere else.

**9. `/shapes/:line` stays backwards compatible.**
It returns the verbose legacy payload by default and the compact one only for
`?format=compact`, so app builds already on people's phones keep working after
a server deploy.

**10. Amber is for countdowns.**
`color.amber` in `app/theme.js` is reserved for departure minutes. It is the one
loud colour in the app and it works because nothing else competes for it. If you
need emphasis elsewhere, use weight or spacing.

**11. Line colours must clear 4.5:1 on white.**
The original palette put white text on `#F8E71C` at roughly 1.4:1 — illegible in
the sunlight you are standing in at a stop. Check any new value before adding it
to `lineColor`.

**12. `npm test` uses an unquoted glob on purpose.**
`node --test test/*.test.js`. The runner only expands globs itself from Node 22;
quoting the pattern passes it through literally and the job fails in 0s on
anything older. Let the shell expand it.

**13. Anything the server schedules must be stoppable.**
`stopBackgroundWork()` exists because the cron task keeps the event loop alive,
so `test/boot.test.js` hung forever without it.

**14. Do not reintroduce `react-native-maps` (or `react-native-map-clustering`,
which pins an old copy of it).**
`react-native-maps` is native-only — it needs a custom dev-client build, which
Expo Go does not run. Scanning into plain Expo Go showed no map at all, no
crash, nothing in the console: the JS still ran and fetched `/locations`
fine, the native module just was not there to render into. The map is a
WebView showing plain HTML (Leaflet) instead — `app/components/mapHtml.js` —
which is why Expo Go works again. `react-native-map-clustering` has not been
published since 2021 on top of that.

**15. Do not declare capabilities the app does not use.**
`expo-notifications` was in the config with an iOS usage string and no code
behind it. An unused permission is an App Review question you cannot answer.

**16. `expo-updates` and `expo-dev-client` have no imports, and are not dead
weight.**
Invariant 15 does not reach them: both are wired up through config rather than
code, so a grep for imports finds nothing and they look removable. `eas.json`
names a `channel` on the preview and production profiles, and `app.config.js`
carries the matching `updates.url` and `runtimeVersion` — without
`expo-updates` installed, `eas build` warns that the channel does nothing and
then errors with `You need to be on SDK 46 or higher, and use expo-updates >=
0.14.4 to use appVersion runtime policy`. The development profile sets
`developmentClient: true`, which needs `expo-dev-client` for the same reason.
Both are pinned by `expo install`, so bump them with `npx expo install --fix`
and not by hand.

**17. A vehicle's direction cannot be decided by distance alone.**
Both directions of a line run down the same street, and a tram line runs on
rails a few metres apart — so whichever variant `matchVariant()` finds nearer is
decided by GPS noise, and half the time it is the one going the other way. That
is not a cosmetic error: it announces the opposite terminus and a stop list the
vehicle will never reach. The heading is folded into the score
(`HEADING_PENALTY_METERS` in `server/src/gtfs/store.js`), which is why
`/shapes/:line` takes `?heading=` and why both the app and `views/map.html` send
it. The penalty is graded by the cosine of the angle rather than a cutoff at
90°, because a heading is noisy and a hard threshold flips the answer on a bend.

**18. MPK's feed has no trip id, so the run is inferred — and may be unknown.**
`describeVehicle()` in `server/src/progress.js` projects the position onto the
matched shape, turns metres into seconds through each stop's `alongMeters` /
`arrivalOffset`, and then asks which of the shape's departures would be exactly
there right now. Beyond `MAX_DELAY_SECONDS` (45 min) no run is claimed: the
nearer explanation is a different departure, and guessing produces a confident
"18 minut spóźnienia" that is really the next tram running on time. When no run
matches, `scheduled` is null everywhere and only `etaSeconds` — remaining
scheduled running time from the vehicle's real position — is served. Never
substitute the variant's own sample times there; they belong to some other
departure. This all rests on every trip of a shape sharing one relative profile,
which is true of this feed and is what makes the offsets reusable.

**19. `/map` is a second client, and the app's rules apply to it too.**
`server/views/map.html` is a full client — line filters, alerts, routes,
departures, a followed vehicle's direction and remaining stops — that just
happens to be one file with no build step. It has already reproduced two bugs
from this list on its own: it kept the pre-2026 rainbow palette long after
invariant 11 retired it (white on `#F8E71C`, about 1.4:1), and it parsed the
boot-time 503 as data the way invariant 7 describes, rendering categories out
of `{error, state}`. When you change `lineColor` in `app/theme.js`, change
`LINE_COLOR` here; when a payload shape changes, check both readers. It also
stops click propagation on its own markers by hand — without that a tap on a
stop reaches the map's click handler, which clears the very route the stop
belongs to.

**20. `views/map.html` moves its markers; it does not rebuild them.**
The browser map used to clear the marker layer and recreate every vehicle on
each ten-second poll. The whole fleet blinked, anything open closed, and the
selection was lost — and it costs more than moving the markers that are already
there. `renderVehicles()` keeps a `Map` of id → marker, moves what moved, and
only touches the icon when the look actually changes (heading is bucketed to
15°, or a marker redraws on every degree of GPS jitter). Everything reaching
`innerHTML` goes through `escapeHtml()`, because line and stop names come from
upstream feeds. `app/components/mapHtml.js` is the same page rendered inside
the mobile app's WebView and deliberately mirrors this logic rather than
reimplementing it — `setVehicles()` there is `renderVehicles()` by another
name, same `Map`-of-markers, same 15° bucketing.

## Fragile by nature

The default (and, out of the box, only) alerts source is `@AlertMPK` on X —
see the `NitterProvider` paragraph below. `parsePage()` in
`server/src/alerts.js` can also scrape
`wroclaw.pl/komunikacja/zmiany-w-komunikacji`, a page verified to carry live
disruptions, but `ALERT_PAGES` is empty by default; set `ALERT_PAGE_URLS` to
add it (or another page) back as an extra source. `mpk.wroc.pl/komunikaty` was
a guess and 404s; `/o-mpk/aktualnosci` exists but is corporate news. The page
provider is an HTML scrape and the Nitter provider depends on a mirror staying
up — both are the most likely thing here to break, for different reasons.

It fails soft: when every provider fails the previous list stays in place, and
the reason shows up in `/health` under `alerts.providers[].lastError`. If alerts
go stale, check that field first — then, for the X source, `npm run
scrape:nitter`, and for a configured page, the keyword lists in `parsePage()`.
A configured page that serves RSS is auto-detected and parsed as a feed
instead.

A notice's body is the text between its headline link and the next link on the
page. A fixed-size lookahead instead runs into the following notice and appends
its body to this one, which reads as one alert describing two disruptions.

A headline only becomes an alert when it names something going wrong
(`DISRUPTION_WORDS`) *and* transport appears in the headline or its lead
(`TRANSPORT_WORDS`). Accepting a bare `tramwaj`/`autobus`/`linia` matches every
press release, so pointing the scraper at a news page produced "MPK kupuje nowe
tramwaje" as a service alert. A fake disruption is worse than a missing one —
it sends people looking for a replacement bus that does not exist. Transport is
checked across headline *and* lead because real notices often say "Zmiana
organizacji ruchu na ulicy X" and only list the affected lines in the body.

The X API is not usable as a source: reading someone else's timeline needs a
paid tier, which is what silently emptied `/alerts` for a year in the first
place. `@AlertMPK` posts real disruptions, though, and `NitterProvider` in
`server/src/alerts.js` reads them through a Nitter mirror's RSS feed
(`<instance>/<username>/rss`) instead of scraping X directly — Nitter is an
alternative X front end that republishes public profiles as plain RSS, which
`parseFeed()` (the same function every other feed source in this file uses)
already parses: no browser, no regex-scraped HTML, no reverse-engineered
endpoint. It is the default and, out of the box, only alerts source
(`NITTER_ENABLED` defaults to `true`; set it to `false` to turn it off).

The fragility moved rather than disappeared. Parsing is no longer the weak
point — RSS is a stable, documented format — but public Nitter instances are
themselves unreliable and disappear with no warning (this is a known property
of the Nitter ecosystem, not specific to this project). That is why
`NITTER_INSTANCE_URLS` is a list tried in order, same pattern as every other
multi-source config in this project (invariant 1): a deploy should not depend
on exactly one public mirror staying up forever. `toXPostUrl()` rewrites each
post's permalink from the mirror's own domain to `x.com`, so a link handed to
a user still resolves after the mirror that served it goes down.

Because a dead mirror reads as "zero posts," not a crash, a silent failure
here is easy to miss; that is why `parsePage()` above stays available as a
fallback/extra source via `ALERT_PAGE_URLS`. **A deploy with every configured
Nitter instance down, and no page-scrape source configured, gets zero alerts
until someone notices and adds another instance or a page.** `npm run
scrape:nitter` (and `npm run doctor`, which checks every configured instance)
are manual, non-test ways to check the real feed before relying on it — the
automated suite can't, since it has no network; `test/alerts.test.js` instead
pins `parseFeed()` against a fixture captured from a real Nitter response
(attributed `<guid>`, CDATA description with a nested `<a>`) to cover the
parsing, which is the part that can be tested without a network call.

`parseFileListing()` is deliberately shape-agnostic — it walks the JSON looking
for url-ish and name-ish fields rather than hardcoding a schema, because the CUI
portal's response format is not documented anywhere verifiable. On startup the
log prints which snapshot it chose:

```
catalogue lists 18 snapshot(s); using OtwartyWroclaw_rozklad_jazdy_GTFS_25072026
```

If that count is 0 or the name looks wrong, the parser needs adjusting to the
real payload — that is the first thing to check when the feed goes stale. The
warning prints the payload's keys and a sample; capture the whole thing with
`curl -s https://api.open-data.cui.wroclaw.pl/od2/6/ | head -c 2000`.

The scraped page is built with Tilda, whose photo tiles wrap a per-tile
`<style>` block inside the anchor itself. `stripHtml()` removes `<style>` and
`<script>` blocks along with their content, not just their tags — stripping
tags alone left raw CSS text (`@media screen and (max-width: 767px) {…}`)
sitting in a notice's title in production. The page's own header links back to
itself with a title that reads exactly like a disruption ("Zmiany w
komunikacji"); `parsePage()` drops any notice whose link resolves to the page
URL itself for that reason.

Wrocław has real lines numbered 1, 6, 11 and 21. A day-of-month next to those
numbers ("Od **1** sierpnia", "**21**.07.2026", "od **6** lipca", "(**11** - 16
lipca)") is not a reference to those lines, but matching against the
known-lines set alone cannot tell the difference — the number really is a
valid line, just not the one in that sentence. `extractAffectedLines()` strips
recognized Polish date expressions (`POLISH_DATE`) before tokenizing,
specifically because this produced phantom line badges on notices that were
correctly about other lines. The date-range form has to be matched as one unit
("D1 - D2 miesiąc") ahead of the single-day form in the alternation — observed
live on a notice reading "(11 - 16 lipca)": the single-day pattern matched only
"16 lipca" and left the range's opening "11" behind as a phantom line 11.

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

`react-native-webview` has no web build target, so `app/metro.config.js` swaps
it for `app/.preview/webview-stub.js` **on web only**. Unlike the old
`react-native-maps` stub this is not a fake: the map itself is plain HTML
(`app/components/mapHtml.js`, Leaflet), so a browser can render it for real
inside an `<iframe>`. The stub only replaces the native WebView *host* —
`injectJavaScript` and `onMessage` are bridged over `window.postMessage`
instead of the native channel. `npx expo export --platform web` is therefore
both a real compile check and an actual working preview of the map, not just
everything around it. If you change the native ↔ web message shape in
`MapView.jsx` or `mapHtml.js`, keep both sides of the bridge (the stub's
`postMessage` relay and `mapHtml.js`'s own `window.addEventListener('message')`
fallback) in step, or the preview goes silent where the app still works.

The page the bundle is rendered into is `app/public/index.html`, which Expo's
metro web bundler picks up as the HTML template (it injects the favicon and the
script tag into it). It is where `viewport-fit=cover` lives, and that one
attribute is what makes `env(safe-area-inset-*)` — and therefore every
`useSafeAreaInsets()` value in the web build — anything other than zero.

```bash
cd app && API_URL=http://localhost:3000 npx expo export --platform web --output-dir /tmp/web
python3 -m http.server 4620 --directory /tmp/web
```

The map itself renders for real, vehicles included — it is the same HTML page
the phone would load, in an iframe instead of a native WebView.

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
