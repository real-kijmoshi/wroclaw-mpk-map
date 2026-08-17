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

- **`map-view.ios.tsx` → `native-map.tsx`** — the native surface,
  `react-native-maps`, on **iOS only**. It is **included in Expo Go** (SDK 57
  docs), so this is the live screen on iPhone. The renderer there is MapKit —
  Apple's map, no API key — with an OSM `UrlTile` option in
  `src/lib/preferences.ts`. Custom markers freeze `tracksViewChanges` and
  re-enable it only while an appearance change is re-captured — that is the
  native form of "move markers, don't rebuild them".
- **`map-view.tsx` → `osm-map.tsx`** — Android. `react-native-maps` renders
  through the **Google Maps SDK** on Android and offers no other provider (its
  OSM setting is a tile layer over a Google map, so the SDK still initialises
  and a store build still needs a Maps key). This project ships no Google Maps,
  so Android gets the same Leaflet page as the web build and
  `platformMapAvailable` is `false` — there is one surface, so Settings hides
  the provider choice and the map hides its layers button. See invariant 14 in
  the root `AGENTS.md`.
- **`apple-map.ios.tsx` → `expo-maps`** — a MapKit surface via `expo-maps`
  (SDK 57, **alpha**, *not* in Expo Go). It is **not wired into the live
  screen**; it exists for a future switch. It must stay behind the
  `appleMapsAvailable` runtime check (`requireOptionalNativeModule('ExpoMaps')`)
  and a guarded `require('expo-maps')` — importing it at module scope crashes
  the bundle. `apple-map.tsx` is the non-iOS stub.
- **`map-view.web.tsx` → `osm-map.tsx` → `live-map.web.tsx`** — the same Leaflet
  page (`src/lib/map-html.ts`), rendered in a browser `<iframe>` instead of a
  `WebView`. `map-html.ts` mirrors `server/views/map.html`'s `renderVehicles()`:
  a `Map` of id → marker that is moved between polls, never rebuilt.

Note which of these ship: the Leaflet page is **not** a preview-only artefact.
It is Android's live surface, so a regression in `map-html.ts` or in the
`live-map.tsx` bridge is a regression on real phones, not just in `expo export`.

Keep shared behaviour in the declarative contract. Native-specific marker and
camera work belongs in `native-map.tsx`; Leaflet bridge changes belong in
`osm-map.tsx` and `map-html.ts`.

## The design system

Sizes, radii, shadows, the type ramp and the motion constants live in
`src/constants/design.ts`; colour lives in `src/constants/theme.ts`. Reach for a
token, never a number — twelve components hand-rolling `fontSize: 17/19/21/23/26`
inline is what made the app read as a template, and three of them each carried
their own copy of the same `Platform.select` shadow.

- **`ThemedText` takes a ramp step, not a size.** `display · title · headline ·
  body · callout · subhead · footnote · caption`, with `weight` as its own prop.
  A component that needs a size the ramp does not have needs a ramp step.
- **Grouped lists come from `src/components/list.tsx`** — `Section`, `Row`,
  `Choice`, `LinkRow`, `Divider`, `RowIcon`. One row height, one divider inset,
  one card radius across settings, alerts, lines and search.
- **Chrome over the map does not follow the phone's colour scheme.** Satellite
  and hybrid tiles are a dark photograph in *either* scheme, so a light-scheme
  phone on hybrid was painting black icons and grey secondary text onto a
  near-black image — the HUD subtitle and the whole control stack were
  invisible. `useMapChrome()` picks the material from what the map is drawing;
  `MapChrome` in `theme.ts` carries the tokens, and its alphas are set by the
  *worst-case* backdrop (a sunlit river under the dark material, night imagery
  under the light one), not by the average one.
- **`Glass` has no transparent variant.** `chrome` floats over the map and holds
  text, `control` is a map button, `panel` sits inside a sheet. The `clear`
  variant this replaced is the direct cause of the unreadable HUD.

## The map surface

`src/app/index.tsx` is a map, a two-button control rail, and one sheet.

- **The sheet is never dismissed — in the sheet layout** (`map-sheet.tsx`).
  Three detents — collapsed (search + live status), medium, full — and dragging
  below the collapsed one puts the selection away rather than taking the sheet
  off screen. It replaced a top HUD card, a four-button tower and a separate
  selection sheet, all competing for the same map.
- **There are two layouts, and only the chrome differs**
  (`preferences.layout`, chosen in Settings). `sheet` is the above. `classic`
  is the arrangement that preceded it, kept because some riders want the bottom
  two thirds of the map back: `src/components/classic-chrome.tsx` draws the
  status pill, filter chip and search across the top and the button tower
  (layers, lines, alerts, settings, locate) down the right edge, and `MapSheet`
  takes its `presented={false}` — the one case where it does leave the screen,
  because there it belongs to the selection rather than to the app. Everything
  above the render in `index.tsx` is shared: same polls, same selection, same
  map surface. Do not fork the screen to add to one of them.
  - The classic chrome is rebuilt, not restored. The original hardcoded
    `theme.text` onto glass floating over the map, which is precisely the
    combination `useMapChrome()` exists to prevent — black icons on satellite
    imagery. Anything added to that file asks `useMapChrome()`, the same as
    `map-controls.tsx` does.
  - The sheet keeps drawing the *last* selection while it slides away
    (`lingering` in `index.tsx`). Cleared with the selection, it slid an empty
    glass panel down the screen.
- **It publishes `visibleHeight` through `useDerivedValue`, every frame.** The
  map controls ride on it instead of the hardcoded "188 for a vehicle, 262 for a
  stop" offsets. Writing that value from the pan handler alone is not enough:
  the detent also changes programmatically, and the controls stayed anchored
  where the sheet used to be and were then covered by it.
- **Marker tiers** (`native-map.tsx`, mirrored in `map-html.ts` and
  `server/views/map.html`). Each tier answers a different question, and none of
  them draws what a smaller scale would: `near` labelled badges, one label per
  ~46pt cell; `mid` every vehicle as a dot **with its heading tail**, so
  district zoom shows which way the network is flowing; `far` one dot per ~26pt
  cell, **sized by how many vehicles that cell holds** and carrying no heading.
  The density step is not decoration — a survivor that looked identical whether
  it stood for one bus or eight trams threw away the only thing city zoom is
  good for. No heading at `far` for the same reason: the dot speaks for the
  vehicles it swallowed as much as for itself. Vehicles are walked in id order
  so the marker that wins a cell is the same one from poll to poll — walking
  them in payload order made the survivor change every ten seconds and the map
  twinkled. Both Leaflet pages do the whole thing with class toggles and custom
  properties, so no icon is rebuilt.
- **The density steps are steps, not a scale** (`DENSITY_SIZES`). The dot's
  size is part of what every surface keys its redraw on, so a count wandering
  between 3 and 4 on each poll would re-capture the marker on each poll.
- **A vehicle is one shape, and `src/lib/vehicle-marker.ts` is its geometry.**
  The badge grows a directional tail out of its own outline; the badge never
  rotates, so the line number stays upright. Where the tail meets the badge is
  *solved per heading* (`outlineDistance()` — a ray against a rounded
  rectangle), because a badge's outline is 12pt from its centre due north and
  19pt due east: the arrow this replaced orbited at one fixed radius and so
  floated off the short sides and buried itself in the long ones, inside a
  64×64 box that was the marker's whole hit target on the native surface. All
  three surfaces draw it — `native-map.tsx` imports the module, `map-html.ts`
  interpolates its constants into the page, and `server/views/map.html` carries
  a hand copy that names it. Change a number in one, change it in all three —
  `server/test/map.test.js` compares the constants and checks the solver lands
  on the outline, the same way it compares the palette.
- **There are two marker styles, and the classic one is not a rebuild**
  (`preferences.markerStyle`, chosen in Settings next to the layout). `modern`
  is the marker above. `classic` is the tile from commit a86981d — a 40pt
  glossy badge with a chevron orbiting it at one fixed radius, the pair rotated
  together while the number is turned back upright — and its constants sit in
  the same `vehicle-marker.ts`. Two things it does *not* restore: the pastel
  palette that shipped with it (white numbers on `#7799CC` at about 2.9:1, and
  every night line the same blue — it wears `LINE_COLOR` and a keyline derived
  from it, `CLASSIC_BORDER_COLOR`), and the dot tiers, because a bare dot is a
  shape that look does not have — the thinning still decides *which* vehicles
  are drawn and every survivor keeps its badge (`alwaysLabelled` in
  `native-map.tsx`). On the Leaflet page it is one class on the vehicles pane:
  every marker already carries its keyline and its bearing as custom
  properties, so switching the setting repaints the fleet without rebuilding an
  icon, the same way the tier and the focus do. `server/views/map.html` has no
  settings and draws the modern marker only.
- **`server/views/map.html` uses `is-` prefixed marker modifiers.** That page
  has one flat class namespace and `.dot` is already the live/stale indicator
  in its status pill: a plain `.dot` on the marker picked up its grey
  background and painted a disc behind every zoomed-out vehicle.
- **The bucketed heading is the drawn heading.** Every surface rebuilds a
  marker only when the 15° bucket changes, so the raw heading must never be
  what gets drawn: `tracksViewChanges` is false on native, and a rotation the
  key does not notice is never captured to the screen at all.
- **Stops follow the viewport, not the locate button** (`use-area-stops.ts`).
  They used to load only after the rider shared their position, so panning to a
  district you were not standing in showed a map with no stops at all. The
  layer refetches only when the viewport has moved a real fraction of its own
  radius — a pan of a few metres returns the same stops and made it flicker.
- **A place is named once.** `/stops/near` answers with one record per
  platform, so a junction came back as "Galeria Dominikańska" five times and was
  printed five times across the same block, and the sheet's list read
  "Spółdzielcza 10 m / Spółdzielcza 10 m / Spółdzielcza 40 m". The map dedupes
  by name before the screen-cell pass; the list groups with `groupStopAreas()`
  in `stops-api.ts`, which needs *name and proximity* — the name alone is not
  unique in this feed. Every platform keeps its own dot: they are different
  boarding points and tapping the right one is how a rider gets the right
  direction.

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
- **Vehicles glide to a new fix, they do not appear at it.** The feed is a
  ten-second snapshot, so a marker that takes the coordinate outright jumps a
  hundred metres at every poll, the whole fleet in step. Both surfaces travel
  for `GLIDE_MS` (1000ms) instead — CSS `transition: transform` in
  `map-html.ts`, the platform's own marker animator
  (`animateMarkerToCoordinate`) in `native-map.tsx`. Two things about the native
  side: the duration must be a **whole second**, because `RNMapsMarkerView.mm`
  hands it on as integer `duration / 1000` and 900ms arrives as a zero-second
  animation; and the `coordinate` prop deliberately carries the fix the marker
  has *already arrived at*, because a live prop sets the position outright (the
  jump) while no prop at all would freeze the fleet wherever a native command
  turned out to be a no-op.
- **"Already arrived at" means after the glide, not before it.** That prop was
  a ref pinned to the previous poll, so it sat a fix behind the animator for
  ten seconds at a time. Every re-render writes it back to the native marker
  and a zoom re-renders the whole fleet — the tier and the dot size change with
  it — so zooming dropped every vehicle back to where it had been ten seconds
  earlier, the fleet jumping a poll's travel backwards in step. It is state
  that settles on a `GLIDE_MS` timer (`standingAt` in `native-map.tsx`): the
  write then lands where the animator already put the marker and changes
  nothing.
- **A native marker's box never changes size, and its shape is centred in it.**
  The anchor is not the whole story and fixing the anchor alone did not fix the
  bug: `AIRMapMarker.layoutSubviews` (react-native-maps, iOS) takes the largest
  frame its React child has ever had as the annotation view's bounds and never
  gives it back, MapKit centres *those bounds* on the coordinate, and the child
  is drawn at their top-left corner. A marker whose box shrinks therefore draws
  its shape half the lost width and height off its coordinate — permanently,
  since nothing shrinks the bounds again — and one whose box grows is displaced
  by `reactSetFrame`'s own half-the-difference compensation until the next map
  movement re-places it. That is stops walking off their kerb on every zoom;
  the earlier fix (a box tall enough for the name, dot centred, anchor dead
  centre) removed the changing *anchor* but left the changing *box*. So the dot
  is one marker of one fixed size (`STOP_DOT_BOX`) for the life of the marker,
  and the name is a **second** marker that only ever mounts and unmounts —
  mounting is the one path where the platform places the annotation itself. One
  marker with a box big enough for both states would fix the drawing and hand
  away the tap target: on the native surface the box *is* the hit target, and a
  104pt-wide one over every platform of a junction takes the taps that pick the
  direction a rider is travelling. Apple Maps ignores `anchor` and uses
  `centerOffset`; pass one per platform, never both.
- **A stop name gets two lines.** Wrocław has stops called "Dembowskiego
  (Chełmońskiego)"; on one line that is "Dembowskiego (…", which is not a stop
  anyone can look for. Both surfaces clamp at two (`numberOfLines` in
  `native-map.tsx`, `-webkit-line-clamp` in `map-html.ts`) and both reserve the
  two-line height whether or not the name uses it — a box that grows when a
  name wraps is the size change the rule above forbids.
- **Only *our* marker moves may be transitioned.** Leaflet repositions every
  marker itself at the end of a zoom and on `viewreset`, and it clears its own
  `leaflet-zoom-anim` guard *before* it does — so a blanket
  `transition: transform` on `.vehicle-marker` left the whole fleet sliding in
  from its pre-zoom position for 900ms after every zoom, vehicles visibly off
  their street. The glide is a class (`is-gliding`) that `setVehicles()` puts on
  the vehicles pane and `zoomstart`/`viewreset` take straight back off.
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
| `src/app/` | expo-router screens: `index` (the map), `lines`, `alerts`, `settings`, `search` |
| `src/constants/design.ts` | Type ramp, spacing, radii, elevation, motion |
| `src/components/map-sheet*.tsx` | The persistent sheet and its home content |
| `src/components/classic-chrome.tsx` | The classic layout's top bar and button tower |
| `src/components/list.tsx` | Section/Row/Choice/Divider, shared by every modal |
| `src/lib/api.ts` | The only way to the server, plus all payload validation |
| `src/lib/map-html.ts` | The Leaflet page: generated HTML, message bridge, marker logic |
| `src/lib/lines.ts` | Line colours and category labels |
| `src/lib/selection.ts` / `preferences.ts` | Line filter and settings, persisted |
| `src/lib/config.ts` | API URL (`EXPO_PUBLIC_API_URL` wins) and poll intervals |
| `src/components/map-view*.tsx` | Platform pick for `MapView` |
| `src/components/native-map.tsx` | `react-native-maps` surface — iOS/MapKit only |
| `src/components/apple-map*.tsx` | `expo-maps` MapKit surface (unused, keep guarded) |
| `src/components/osm-map.tsx`, `live-map*.tsx` | Leaflet surface: prop→command bridge, WebView/iframe host — ships on Android and web |
