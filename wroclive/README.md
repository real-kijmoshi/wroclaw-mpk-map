# wroclive

Live map of Wrocław's trams and buses. Expo SDK 57, iOS + Android + web.

Reads the API in [`../server`](../server): vehicle positions, the direction and
stop list each vehicle is running, timetable departures, and service alerts.

## Running it

The server has to be up first — it needs 30–60s on a cold start to discover and
ingest the city's GTFS feed.

```bash
cd ../server && npm install && npm start
```

Then:

```bash
npm install
npx expo start
```

The app finds the API by itself: with no configuration it uses the machine that
served the bundle, on port 3000, so a phone on the same Wi-Fi works with no
edits. Point it somewhere else with `EXPO_PUBLIC_API_URL`:

```bash
EXPO_PUBLIC_API_URL=https://api.example.com npx expo start
```

Run `npx expo-doctor` after any dependency change, and `npx expo install --fix`
to pin `expo-*` packages back to the SDK.

## What is where

The map is the app. Lines, alerts and settings are popups over it — a sheet
with detents on iOS, a modal elsewhere — not places you navigate to.

| Path | |
| --- | --- |
| `src/lib/api.ts` | Every request to the server, and the validation of every reply |
| `src/lib/map-html.ts` | The OpenStreetMap surface — a Leaflet page rendered in a WebView |
| `src/lib/lines.ts` | Line colours and category labels |
| `src/lib/selection.ts` | The line filter, persisted across launches |
| `src/lib/preferences.ts` | Settings, persisted the same way |
| `src/components/map-view.tsx` | Android `react-native-maps` surface |
| `src/components/map-view.ios.tsx` | Picks Apple Maps or the safe Leaflet fallback on iOS |
| `src/components/map-view.web.tsx` | Picks the Leaflet surface for browsers |
| `src/components/native-map.tsx` | Native markers, route polylines, MapKit/Google camera |
| `src/components/osm-map.tsx` | The Leaflet page used by the web build |
| `src/components/live-map.tsx` | Hosts that page and bridges it to React (`.web.tsx` uses an iframe) |
| `src/app/` | The map, and the three popups over it |

## Which map you get

Android uses `react-native-maps` with Google Maps. iOS uses Expo's Apple Maps
surface in a development or release build, avoiding the red MapKit rendering
artifact from `react-native-maps`; Expo Go falls back to the Leaflet map because
it does not contain `expo-maps`.

The OpenStreetMap preference uses a native `UrlTile` layer on Android and
Leaflet on iOS and web.

## Things that will bite you

**Every request goes through `apiGet()`.** The server answers 503 with a
`{error, state}` body for up to a minute after boot while it ingests the
timetable. `apiGet` retries it and the `normalise*` functions validate what
comes back, because rendering that body as data is how the line picker used to
crash on every cold start. Do not call `fetch` from a component.

**The browser map is HTML; the phone map is native.** Keep shared behaviour in
the declarative `MapSurfaceProps` contract. Native-specific marker and camera
work belongs in `native-map.tsx`; Leaflet bridge changes belong in
`osm-map.tsx` and `map-html.ts`.

**Markers are moved, never rebuilt.** `setVehicles()` keeps a `Map` of id →
marker and only redraws an icon when it would actually look different — the
heading is bucketed to 15°, or GPS jitter redraws the whole fleet every poll.
Rebuilding made every vehicle blink every ten seconds and lost the selection.
`server/views/map.html` does the same thing for the browser map; keep the two in
step.

**Dimming the fleet around a selection is one class on a pane.** Vehicles live
in their own Leaflet pane so `is-focused` can fade all of them at once without
touching a single marker — doing it per marker would be the rebuild the rule
above exists to prevent. The two markers that really did change appearance are
redrawn immediately rather than at the next poll, or the vehicle you just
tapped sits there dimmed with everything else for ten seconds.

**Colours the theme can change are CSS variables, not baked values.** The page
is generated once and `setTheme` has to be able to reach everything: the page
background was a literal, so after a theme switch it stayed light behind dark
tiles and showed through wherever tiles had not painted yet.

**Commands sent to the map page are queued until it is ready.** The page's own
"ready" message can be posted before React has a listener up, and a `srcDoc`
iframe can finish loading before `onLoad` is attached — miss both and the queue
never drains, which looks exactly like a map that draws its tiles and no
vehicles at all. The web host also polls for the page's handler for that reason.

**The heading goes with every `/shapes/:line` request.** Both directions of a
line share the street, so position alone picks the wrong one about half the
time — and that means the wrong terminus and a stop list the vehicle will never
reach.

**Line colours must clear 4.5:1 against the white text on them.** The palette in
`src/lib/lines.ts` is the same one as `LINE_COLOR` in `server/views/map.html`;
change both together. Every category is the same rounded square, on the map and
in the lists, so colour and the number are what tell lines apart.

**Polish has three plural forms.** `plural()` in `src/lib/format.ts` picks
between them; "1 pojazdów" is the kind of thing that reads as broken software.

**Amber is for countdowns.** `theme.amber` is the one loud colour in the app and
it works because nothing else competes for it. Use weight or spacing elsewhere.

**The server says when it does not know.** MPK's feed carries no trip id, so the
run is inferred from position; when it cannot be identified there is no delay
and no clock time, only remaining running time. That is why the sheet shows
"Brak rozkładu" instead of a plausible-looking number.

**Do not pass a computed height alongside an animated transform.** In the web
build the animated node's inline style is rewritten and a separate `{ height }`
object is dropped, so the sheet grew to the height of its content and hung off
the top of the screen. `Sheet` sizes itself with a percentage in its static
style instead — see the comment on `SHEET_FRACTION`.

## Web build

`npx expo export --platform web` is a real compile check *and* a working
preview: the map is plain HTML, so the browser renders the same page the phone
loads, in an iframe instead of a WebView.

```bash
EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo export --platform web --output-dir /tmp/web
python3 -m http.server 4620 --directory /tmp/web
```
