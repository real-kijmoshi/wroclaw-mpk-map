# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.
This app is SDK 57: React Native 0.86, React 19.2. Do not guess an API from an older SDK's docs —
`expo-maps`, the WebView bridge and the native map props all changed on the way here.

## The app

`wroclive/` is the whole mobile client: a live map of Wrocław's trams and buses
for iOS, Android and web, reading the API in `../server`. It was previously the
`app/` directory; nothing else calls it that.

## Commands

```bash
npm install
npm run lint
npm run typecheck    # tsc --noEmit
npx expo export --platform web --output-dir dist   # compile check + working preview
npx expo start
npx expo-doctor              # run after any dependency change
npx expo install --fix       # pins expo-* to the SDK
```

CI runs lint, typecheck and the web export (see `.github/workflows/ci.yml`).
Every app request goes through `apiGet()` in `src/lib/api.ts`, which retries the
server's 503 cold start and validates every payload — do not call `fetch` from a
component.

## The map

Three surfaces, all behind one declarative `MapSurfaceProps` contract
(`src/components/map-surface.types.ts`). The screen (`src/app/index.tsx`)
imports `MapView` from `src/components/map-view` and never knows which surface
it got:

- **`map-view.tsx` / `map-view.ios.tsx` → `native-map.tsx`** — the native
  surface, `react-native-maps`, on both Android and iOS. It is **included in
  Expo Go** (SDK 57 docs), so this is the live screen everywhere native. Google
  Maps on Android, MapKit on iOS, with an OSM `UrlTile` option in
  `src/lib/preferences.ts`. Custom markers freeze `tracksViewChanges` and
  re-enable it only while an appearance change is re-captured — that is the
  native form of "move markers, don't rebuild them".
- **`apple-map.ios.tsx` → `expo-maps`** — a MapKit surface via `expo-maps`
  (SDK 57, **alpha**, *not* in Expo Go). It is **not wired into the live
  screen**; it exists for a future switch. It must stay behind the
  `appleMapsAvailable` runtime check (`requireOptionalNativeModule('ExpoMaps')`)
  and a guarded `require('expo-maps')` — importing it at module scope crashes
  the bundle. `apple-map.tsx` is the non-iOS stub.
- **`map-view.web.tsx` → `osm-map.tsx` → `live-map.web.tsx`** — the Leaflet
  page (`src/lib/map-html.ts`), rendered in a browser `<iframe>`. On native the
  same page is hosted in a `WebView` by `live-map.tsx` when the web fallback is
  chosen. `map-html.ts` mirrors `server/views/map.html`'s `renderVehicles()`:
  a `Map` of id → marker that is moved between polls, never rebuilt.

Keep shared behaviour in the declarative contract. Native-specific marker and
camera work belongs in `native-map.tsx`; Leaflet bridge changes belong in
`osm-map.tsx` and `map-html.ts`.

## Rules that cost real bugs

- **Commands to the Leaflet page are queued until it is ready.** The page's
  "ready" message can beat React's listener, and a `srcDoc` iframe can finish
  loading before `onLoad` is attached; miss both and the queue never drains —
  a map with tiles and no vehicles. The web host polls for the page's handler
  (`window.__wroclive`) because that, not a load event, is the real
  precondition. Only the newest command of each kind is kept while loading.
- **Markers are moved, never rebuilt.** Rebuilding made the whole fleet blink
  every ten seconds, closed whatever was open, and lost the selection. Headings
  are bucketed to 15° so a redraw is not on every degree of GPS jitter.
- **The theme is sent as a command, not baked into the page.** The HTML is
  generated once; everything the theme touches is a CSS variable so `setTheme`
  can reach it. Baking a colour in left the background light behind dark tiles.
- **The heading goes with every `/shapes/:line` request.** Both directions of a
  line share the street, so position alone picks the wrong one about half the
  time — wrong terminus, stop list the vehicle never reaches.
- **Line colours must clear 4.5:1 against white text.** `LINE_COLOR` in
  `src/lib/lines.ts` stays in step with `LINE_COLOR` in `server/views/map.html`;
  change both together.
- **Polish has three plural forms.** `plural()` in `src/lib/format.ts` picks
  between them; "1 pojazdów" reads as broken software.
- **Amber is for countdowns.** `theme.amber` is the one loud colour in the app;
  use weight or spacing elsewhere.
- **Do not pass a computed height alongside an animated transform.** The web
  build drops the separate `{ height }` object, so the sheet grew to its content
  and hung off the top. `Sheet` sizes itself with a percentage — see the comment
  on `SHEET_FRACTION`.
- **The server says when it does not know.** MPK's feed has no trip id, so the
  run is inferred; when it cannot be identified there is no delay, only remaining
  running time — the sheet shows "Brak rozkładu", not a plausible-looking number.

## Layout

| Path | |
| --- | --- |
| `src/app/` | expo-router screens: `index` (the map), `lines`, `alerts`, `settings` |
| `src/lib/api.ts` | The only way to the server, plus all payload validation |
| `src/lib/map-html.ts` | The Leaflet page: generated HTML, message bridge, marker logic |
| `src/lib/lines.ts` | Line colours and category labels |
| `src/lib/selection.ts` / `preferences.ts` | Line filter and settings, persisted |
| `src/lib/config.ts` | API URL (`EXPO_PUBLIC_API_URL` wins) and poll intervals |
| `src/components/map-view*.tsx` | Platform pick for `MapView` |
| `src/components/native-map.tsx` | `react-native-maps` surface |
| `src/components/apple-map*.tsx` | `expo-maps` MapKit surface (unused, keep guarded) |
| `src/components/osm-map.tsx`, `live-map*.tsx` | Leaflet surface: prop→command bridge, WebView/iframe host |
