# AGENTS.md

Context for coding agents working in this repo. Read this before changing anything.

The authoritative operating guide lives here and in
[`wroclive/AGENTS.md`](wroclive/AGENTS.md) — that file carries the app-specific
rules (Expo SDK 57, the map surfaces, the WebView bridge). This file carries the
repo-wide invariants, which are historical bugs re-stated as rules.

## What this is

Live map of Wrocław's trams and buses. Two halves:

- `server/` — Express (CommonJS, Node ≥ 22). Discovers and ingests the city's
  GTFS feed, polls MPK for vehicle positions, scrapes service notices. Also
  serves the browser map at `/map` (`server/views/map.html`).
- `wroclive/` — the mobile app: Expo SDK 57 (React Native 0.86, React 19.2),
  iOS + Android + web. This directory was previously called `app/`; the
  migration is complete, so there is no `app/` directory anymore.

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
cd wroclive && npm install
npm run lint
npm run typecheck   # tsc --noEmit
npx expo export --platform web --output-dir dist   # real compile + preview build
npx expo start
npx expo-doctor              # run after any dependency change
npx expo install --fix       # pins expo-* to the SDK
```

Tests must pass before you commit. They are fast and need no network — there is
no excuse for skipping them. CI runs the same commands (see
`.github/workflows/ci.yml`).

## Invariants

These are not style preferences. Each one is a bug that already happened.
Server-only rules are unchanged from the original client; app rules name the
current `wroclive/` paths and say explicitly when the story is historical.

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
request goes through `apiGet()` in `wroclive/src/lib/api.ts`, which retries 503
with backoff; the `normalise*` functions validate every payload before it
reaches state. Do not call `fetch` directly in a component.

**8. Shape points have changed format twice.**
GTFS column names (`shape_pt_lat`) → `{lat, lon}` → compact `[lat, lon]` pairs.
When the server switched the first time, the map kept reading the old names,
every coordinate parsed as `NaN`, the filter dropped them all, and the route
silently stopped rendering. *Historical:* the old client normalised all three in
one place. *Current:* the server owns the conversion — `/shapes/:line` with
`?format=compact` emits `[lat, lon]` pairs and `normaliseShape()` in
`wroclive/src/lib/api.ts` reads exactly those (it rejects anything else). The
app always requests `?format=compact`; if the wire format ever changes again,
`normaliseShape()` is the single reader.

**9. `/shapes/:line` stays backwards compatible.**
It returns the verbose legacy payload by default and the compact one only for
`?format=compact`, so app builds already on people's phones keep working after
a server deploy. The current app (`wroclive`) requests the compact form.

**10. Amber is for countdowns.**
`theme.amber` in `wroclive/src/constants/theme.ts` is reserved for departure
minutes. It is the one loud colour in the app and it works because nothing else
competes for it. If you need emphasis elsewhere, use weight or spacing.

**11. Line colours must clear 4.5:1 on white.**
The original palette put white text on `#F8E71C` at roughly 1.4:1 — illegible in
the sunlight you are standing in at a stop. Check any new value before adding it
to `LINE_COLOR` in `wroclive/src/lib/lines.ts`, which stays in step with
`LINE_COLOR` in `server/views/map.html` (invariant 19).

**12. `npm test` uses an unquoted glob on purpose.**
`node --test test/*.test.js`. The runner only expands globs itself from Node 22;
quoting the pattern passes it through literally and the job fails in 0s on
anything older. Let the shell expand it.

**13. Anything the server schedules must be stoppable.**
`stopBackgroundWork()` exists because the cron task keeps the event loop alive,
so `test/boot.test.js` hung forever without it.

**14. `react-native-maps` is the current native map — this invariant is history.**
The old `app/` client avoided `react-native-maps` because its Expo Go build
rendered no map, and the whole client was a Leaflet page in a WebView. That
ruling does not carry over. Per the SDK 57 docs, `react-native-maps` is
**included in Expo Go**, and `wroclive/` uses it as its native surface on both
iOS and Android (`src/components/native-map.tsx`, picked by `map-view.tsx` and
`map-view.ios.tsx`). `expo-maps` (SDK 57, alpha) is installed and provides the
`apple-map.ios.tsx` MapKit surface, but that component is **not wired into the
live screen** — it exists for a future switch and must stay behind its
`appleMapsAvailable` runtime check (`requireOptionalNativeModule('ExpoMaps')`),
because `expo-maps` is *not* in Expo Go and importing it unconditionally crashes
the bundle at module scope. The Leaflet page (`wroclive/src/lib/map-html.ts`)
now belongs to the web build and to nothing else. Do not reintroduce the old
"react-native-maps must never be used" rule.

**15. Do not declare capabilities the app does not use.**
*Historical:* `expo-notifications` was in the old app's config with an iOS usage
string and no code behind it. An unused permission is an App Review question you
cannot answer. Still true today: every permission in `wroclive/app.json` maps to
real code (`expo-location` for the locate button and nearby stops).

**16. Config-wired dependencies are live dependencies — and OTA is one.**
The old app wired `expo-updates` and `expo-dev-client` through config (an
`eas.json` channel, `app.config.js` `updates.url`) rather than imports, so a
grep found no imports and they looked removable; removing them broke
`eas build`. Both are live in `wroclive/` today: `expo-dev-client` through
`eas.json`'s development profile, and `expo-updates` through `updates.url` in
`app.json` plus a `channel` on every build profile. Check `app.json` plugins
and `eas.json` before deleting a dependency you cannot find an import for.

Over-the-air updates carry **JS and assets only**. `runtimeVersion` uses the
`fingerprint` policy precisely so that is enforced rather than remembered:
change a native dependency and the fingerprint changes, so binaries already on
phones stop matching new bundles instead of loading JS that calls a native API
they do not have — which crashes on launch, before the app can fetch a fix.
Never switch that policy to `appVersion` to "unblock" a release. All of
`wroclive/src` is shippable this way, which is what makes the JS-side bugs on
this list (7, 8, 11) fixable in hours rather than in an App Review cycle; SDK
upgrades, `react-native-maps`, and anything touching permissions still need a
store build.

That cuts both ways: users sit on whatever bundle they last picked up, so the
server must change **first and compatibly**, and the app after — invariant 9 is
what makes that possible. `EXPO_PUBLIC_API_URL` is baked into the bundle, so
the backend address is now an update, not a rebuild.

`wroclive/src/lib/updates.ts` is the only module that touches `expo-updates`.
It is inert in Expo Go and dev clients (`Updates.isEnabled` is false there and
every call throws — hence the single `updatesEnabled` guard), the boot check is
never awaited so it cannot sit between the user and the map, and a downloaded
bundle is only applied after the app has been backgrounded long enough that a
reload costs nothing. Reloading mid-session throws away the camera, the
followed vehicle and the open sheet, which is invariant 20's complaint in a
different costume.

**17. A vehicle's direction cannot be decided by distance alone.**
Both directions of a line run down the same street, and a tram line runs on
rails a few metres apart — so whichever variant `matchVariant()` finds nearer is
decided by GPS noise, and half the time it is the one going the other way. That
is not a cosmetic error: it announces the opposite terminus and a stop list the
vehicle will never reach. The heading is folded into the score
(`HEADING_PENALTY_METERS` in `server/src/gtfs/store.js`), which is why
`/shapes/:line` takes `?heading=` and why both the app
(`wroclive/src/app/index.tsx` sends it in `getShape`) and `views/map.html` send
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
of `{error, state}`. When you change `LINE_COLOR` in `wroclive/src/lib/lines.ts`,
change `LINE_COLOR` here; when a payload shape changes, check both readers. It
also stops click propagation on its own markers by hand — without that a tap on a
stop reaches the map's click handler, which clears the very route the stop
belongs to. Its vehicle markers are the app's: the geometry lives in
`wroclive/src/lib/vehicle-marker.ts` and this page carries a hand copy of the
constants and the solver, because it has no build step and cannot import them.
`test/map.test.js` compares the two the same way it compares the palette — that
comparison is the only thing that keeps the copy honest.

**20. Maps move their markers; they do not rebuild them.**
The browser map used to clear the marker layer and recreate every vehicle on
each ten-second poll. The whole fleet blinked, anything open closed, and the
selection was lost — and it costs more than moving the markers that are already
there. `renderVehicles()` in `server/views/map.html` keeps a `Map` of id →
marker, moves what moved, and only touches the icon when the look actually
changes (heading is bucketed to 15°, or a marker redraws on every degree of GPS
jitter). Everything reaching `innerHTML` goes through `escapeHtml()`, because
line and stop names come from upstream feeds. The app's Leaflet page
(`wroclive/src/lib/map-html.ts`, `setVehicles()`) deliberately mirrors this
logic rather than reimplementing it — same `Map`-of-markers, same 15° bucketing.
The native surface (`wroclive/src/components/native-map.tsx`) keeps the same
cost model: custom markers freeze `tracksViewChanges` and re-enable it only
while an appearance change is being re-captured.

## Fragile by nature

**There is no default alerts source, and that is a decision, not a gap.**
`@AlertMPK` on X is the only thing publishing actual disruptions, and every
route to it needs something the operator supplies (see the X section below).
The obvious free substitute is not one: the city's notice pages
(`wroclaw.pl/komunikacja/zmiany-w-komunikacji` and friends) carry *planned*
changes — stop relocations, roadworks, event closures — and were briefly wired
in as the default before that got caught. Filling `/alerts` with things that
are not going wrong is the "a fake disruption is worse than a missing one"
rule at the level of a whole source: it buries the one notice that matters.

Those pages are still worth adding via `ALERT_PAGE_URLS` when you *want* the
planned changes alongside the incidents. Only add one carrying dated notices:
`mpk.wroc.pl/komunikaty` was a guess and 404s, and `/o-mpk/aktualnosci` exists
but is corporate news. An HTML scrape is the most likely thing here to break.

It fails soft: when every provider fails the previous list stays in place, and
the reason shows up in `/health` under `alerts.providers[].lastError`. If alerts
go stale, check that field first — then `npm run scrape:alerts`, which prints
what each configured source actually yields, and the keyword lists in
`parsePage()`. A configured page that serves RSS is auto-detected and parsed as
a feed instead.

A notice page that states its own data is read differently, and better.
Some list, per notice, the affected lines and the window the change is in
force:

```
linie: N 128 130 242 251
obowiązuje: 03.09.2026 - 08.09.2026
05.09.2026r. - przywrócenie do ruchu zatoki autobusowej Kromera (24146)
```

`parseStructuredNotices()` reads that form, and `NoticeProvider` prefers it —
feed, then stated list, then anchor scrape. It is worth the extra parser
because it retires two guesses rather than sharpening them. The line list is
*stated*, so `extractAffectedLines()` never runs for these notices and the
phantom-line bug below cannot occur on them; `AlertsService.refresh()` only
derives lines for an item that arrives without them. And the window is stated,
so a notice whose last day has passed is dropped rather than sitting at the top
of `/alerts` describing a closure that has been lifted — expiry is compared as
a Wrocław calendar date, not a UTC instant, or a notice expires up to two hours
early on the evening people are actually reading it.

It parses the page's *text*, not its markup, for the same reason
`parseFileListing()` walks the GTFS payload shape-agnostic: those three fields
are a publishing convention that outlives a redesign, and the class names
carrying them are not. The soft spot is the last notice on a page — a notice's
text runs until the next `linie:`, and the last one has nothing to stop at, so
it is capped at `MAX_NOTICE_TITLE`. If page chrome starts appearing at the end
of the final alert, that cap is why.

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
place. `@AlertMPK` posts real disruptions, though, so `XBridgeProvider` in
`server/src/alerts.js` can read them through an *RSS bridge* — any service
that republishes a public X profile as plain RSS, which `parseFeed()` (the
same function every other feed source in this file uses) already parses: no
browser, no regex-scraped HTML, no reverse-engineered endpoint.

**This provider was `NitterProvider`, hardwired to Nitter, and it is history
worth keeping.** Nitter has been discontinued; the public mirrors it was
pointed at are gone, and one that still answers serves an empty feed rather
than an error. Because a dead mirror reads as "zero posts," not a crash, that
is a silent failure — the same shape as the paid-API outage before it. It had
been the default and, out of the box, only alerts source, so a stock deploy
was left with nothing that answers. **Do not put another public bridge back in
`config.defaults.json`.** Whichever one you pick will go the same way, and the
default deploy will break again with nothing in the logs.

So: `alerts.xBridge.bridges` is empty by default and the provider is not even
constructed unless `ALERT_X_BRIDGE_URLS` names a bridge — and the intended
answer is **a bridge the operator runs**, not a public one. That is the whole
lesson of the Nitter outage restated as configuration: a bridge you host
cannot be discontinued out from under you, and it is the reason this source
ships unset rather than pointed somewhere convenient. `server/.env.example`
carries the docker one-liner. Entries are URL templates carrying `{username}`
(RSSHub publishes `/twitter/user/<name>`, a Nitter mirror published
`/<name>/rss`, a self-hosted bridge can be anything), tried in order, same
pattern as every other multi-source config here (invariant 1); an entry with
no placeholder is read as a Nitter-shaped base URL so a private mirror needs
no rewrite. An empty feed is raised as a provider failure rather
than accepted as zero alerts, so `/health` says so. `toXPostUrl()` rewrites
each post's permalink from the bridge's own domain to `x.com`, so a link
handed to a user still resolves after that bridge goes away.

**The bridge's window is not the memory.** A bridge hands over its last
`ALERT_X_MAX_POSTS` posts and nothing else, so for a while everything older
simply vanished from `/alerts` — along with, on every restart, the whole list
and every AI narrative already paid for. `AlertArchive`
(`server/src/alert-archive.js`) keeps both in `alert-archive.json` beside the
stats snapshot: `restore()` runs from `start()` before the first refresh, so
`/alerts` and `/incidents` answer from the first request, and each refresh
merges what was already known ahead of what just arrived — history first, so
dedup treats the archived copy as the original and keeps its id and URL.
`ALERTS_MAX_ITEMS` bounds the served list and therefore the history;
`ALERTS_ARCHIVE_DAYS` ages the rest out. It is a cache, not a database: a
corrupt or unwritable file costs the history and never the refresh.

**A deploy whose only configured alerts sources are down gets zero alerts
until someone notices.** `npm run scrape:alerts` (and `npm run doctor`, which
checks every configured source) are the manual, non-test ways to check the
real thing before relying on it — the automated suite can't, since it has no
network; `test/alerts.test.js` instead pins the parsing, which is the part
that can be tested without one, against **two** real bridge responses — and
keeps both on purpose. "Any bridge that republishes the profile" is only true
if more than one shape is covered, and the two differ in every field that
matters: RSSHub's `<guid>` is a `twitter.com` permalink where Nitter's was a
bare numeric id, RSSHub's `<link>` is already on `x.com` (so `toXPostUrl()`
has to be a no-op there and a rewrite on Nitter's own domain), and RSSHub
escapes entities where Nitter used CDATA with a nested `<a>`. The RSSHub
fixture also pins two things a live timeline will hand you: the channel
`<image>`, which carries its own `<title>`/`<link>` and must not read as a
post, and untagged posts — roughly half of them carry no `#AlertMPK`, so a
keyword gate here would silently drop real notices.

The configuration itself is pinned too, since that is where the Nitter
failure actually lived: no default page, no default bridge, nothing public
depended on without being asked for.

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
valid line, just not the one in that sentence. This applies only to sources
that do not state their lines — `parseStructuredNotices()` above sidesteps the
whole problem. `extractAffectedLines()` strips
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
  to the diff. The scheduled `upstream-watch` workflow is where the doctor runs;
  `ci.yml` stays offline.
- **Prefer failing soft on upstream, loudly on our own bugs.** A stale feed
  should keep serving the last good data and say so in `/health`. A programming
  error should throw.
- Keep the app's Polish copy in Polish, sentence case, no filler.
- The app's own operating rules (SDK 57, map surfaces, WebView bridge, state
  flow) are in [`wroclive/AGENTS.md`](wroclive/AGENTS.md). Read it before
  touching `wroclive/src`.

## Previewing the app without a device

The map is plain HTML, so the web build is a real preview of the map — the same
Leaflet page the phone's WebView loads, rendered in an `<iframe>` instead.
`react-native-webview` has no web target, which is fine: `live-map.web.tsx`
bridges the page over `window.postMessage` where the native `live-map.tsx` uses
`injectJavaScript`/`onMessage`. Keep both sides of the bridge in step — the
`postMessage` relay in `live-map.web.tsx`, the iframe's
`window.addEventListener('message')` fallback, and the `window.__wroclive`
handler in `map-html.ts` — or the preview goes silent where the app still works.
There is no `metro.config.js` stub and no `public/` template in `wroclive/`;
`viewport-fit=cover` lives in the generated page itself (`map-html.ts`).

```bash
cd wroclive && EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo export --platform web --output-dir /tmp/web
python3 -m http.server 4620 --directory /tmp/web
```

`npx expo export --platform web` is both a real compile check (every import
resolves) and a working preview, which is why CI runs it.

## Open work

- The app has not been run on a simulator or device. `npx expo start` is the real
  check — especially the font load and the departures sheet's clearance above the
  tab bar.
- Production still runs the pre-2026 server and has never been redeployed.
- Before store submission: backend on HTTPS with a real hostname,
  `EXPO_PUBLIC_API_URL` set in the EAS production profile, privacy policy URL,
  Play Data Safety and Apple privacy labels. Note `react-native-maps` with
  Google Maps on Android needs a Maps SDK API key and the `react-native-maps`
  config plugin before a store build (SDK 57 docs).
