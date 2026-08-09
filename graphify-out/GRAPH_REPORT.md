# Graph Report - .  (2026-08-09)

## Corpus Check
- 166 files · ~317,246 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1373 nodes · 2494 edges · 106 communities (73 shown, 33 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 133 edges (avg confidence: 0.58)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Apple map renderer
- Server startup
- Server dependencies
- GTFS catalogue
- Progress benchmark
- Expo permissions
- App API client
- Settings screen
- Search screen
- GTFS store
- Open-data tests
- Upstream doctor
- Modal UI
- App tooling
- Alert parsing
- HTTP routes
- GTFS lifecycle
- Vehicle tracking
- App layout
- Router screens
- Admin tests
- Line badges
- GTFS archives
- Vehicle progress
- Express application
- Cache utility
- Klosok polling
- Map screen
- Vehicle benchmarks
- Open-data benchmarks
- Nitter verification
- Typed GTFS arrays
- Klosok lifecycle
- Vehicle ingestion
- Klosok GTFS tests
- Realtime updates
- Live departures
- End-to-end scenarios
- Browser map tests
- Klosok fetcher
- Upstream monitoring
- TypeScript configuration
- Geospatial utilities
- Source health
- Line categorisation
- Metrics utility
- Shape cache tests
- Stop search API
- Vehicle-detail benchmarks
- Alert tests
- Open-data vehicles
- Klosok realtime tests
- Locations cache tests
- Alert service
- Server logging
- Klosok expiry tests
- GTFS refresh tests
- Browser map client
- API tests
- Vehicle tests
- Lines screen
- App dependencies
- Server configuration
- CSV parsing
- Project reset script
- GTFS benchmarks
- GTFS diagnostics
- Native splash animation
- Web splash animation
- Continuous integration
- Dark app branding
- Brand asset variants
- App workflow screenshots
- Android adaptive icons
- Expo lint config
- Web colour scheme
- Expo package
- Expo blur package
- Expo constants package
- Expo dev client
- Expo device package
- Expo font package
- Expo glass effects
- Expo image package
- Expo linking package
- Expo location package
- Expo router package
- Expo splash package
- Expo status bar
- Expo symbols package
- Expo system UI
- Expo vector icons
- Expo web browser
- React package
- React DOM package
- Async storage package
- Gesture handler package
- Native maps package
- Reanimated package
- Safe-area package
- Native screens package
- React worklets package
- Map surface contract
- Wroclive wordmark
- Render deployment

## God Nodes (most connected - your core abstractions)
1. `GtfsStore` - 50 edges
2. `useTheme()` - 43 edges
3. `VehicleTracker` - 25 edges
4. `distanceMeters()` - 23 edges
5. `createApp()` - 22 edges
6. `KlosokService` - 21 edges
7. `fetchWithTimeout()` - 19 edges
8. `lineToType()` - 18 edges
9. `describeVehicle()` - 18 edges
10. `createRouter()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Static browser map` --semantically_similar_to--> `Server browser map client`  [INFERRED] [semantically similar]
  landing/map.html → server/views/map.html
- `WrocLive light brand identity` --semantically_similar_to--> `WrocLive mobile app icon`  [INFERRED] [semantically similar]
  landing/images/icon-light.jpeg → wroclive/assets/images/icon.png
- `SearchScreen()` --indirect_call--> `vehicle()`  [INFERRED]
  wroclive/src/app/search.tsx → server/test/vehicle-detail-cache.test.js
- `Doctor connectivity check` --conceptually_related_to--> `Server API`  [INFERRED]
  .github/workflows/upstream-watch.yml → README.md
- `Admin statistics dashboard` --references--> `Server API`  [INFERRED]
  server/views/admin.html → README.md

## Import Cycles
- 1-file cycle: `server/src/config.js -> server/src/config.js`

## Hyperedges (group relationships)
- **Browser map data-loading surface** — server_views_map_apiget, server_views_map_polling_loaders, server_views_map_rendervehicles [EXTRACTED 1.00]
- **Wroclive cross-platform map architecture** — wroclive_agents_map_surface_contract, wroclive_agents_marker_stability, wroclive_agents_leaflet_readiness [EXTRACTED 1.00]
- **Wroclive icon composition** — landing_images_wroclive_icon_assets_layer1_background_cityscape, landing_images_wroclive_icon_assets_layer2_pin_location_pin, landing_images_wroclive_icon_assets_layer3_tram_tram_illustration, landing_images_wroclive_icon_assets_layer4_wordmark_wroclive_wordmark [INFERRED 0.95]
- **WrocLive brand asset variants** — landing_images_icon_light_brand_identity, wroclive_assets_images_icon_mobile_app_icon, wroclive_assets_images_favicon_web_favicon, wroclive_assets_images_splash_icon_startup_branding [INFERRED 0.95]
- **Landing screenshots for map workflows** — landing_images_screens1_live_vehicle_map, landing_images_screens2_line_filter_sheet, landing_images_screens3_service_disruptions_sheet [INFERRED 0.95]

## Communities (106 total, 33 thin omitted)

### Community 0 - "Apple map renderer"
Cohesion: 0.05
Nodes (52): AppleMap, AppleMap, INITIAL_CAMERA, LiveMap, styles, enqueueLatest(), LiveMapHandle, LiveMapProps (+44 more)

### Community 1 - "Server startup"
Cohesion: 0.05
Nodes (35): alerts, { AlertsService }, config, { createApp }, cron, gtfs, { GtfsStore }, klosok (+27 more)

### Community 2 - "Server dependencies"
Cohesion: 0.04
Nodes (47): adm-zip, compression, cors, csv-parse, dotenv, express, fast-xml-parser, gtfs-realtime-bindings (+39 more)

### Community 3 - "GTFS catalogue"
Cohesion: 0.07
Nodes (42): CKAN_API_PATHS, config, describePayload(), effectiveDateFromName(), fetchJson(), { fetchWithTimeout }, fileEndpointsFor(), fileIdsFrom() (+34 more)

### Community 4 - "Progress benchmark"
Cohesion: 0.08
Nodes (35): benchmark(), denseDay, { inWarsaw }, line, makeVariant(), { matchTrip }, matchTripLinear(), { performance } (+27 more)

### Community 5 - "Expo permissions"
Cohesion: 0.05
Nodes (36): android.permission.ACCESS_COARSE_LOCATION, android.permission.ACCESS_FINE_LOCATION, expo-maps, backgroundColor, backgroundImage, foregroundImage, monochromeImage, adaptiveIcon (+28 more)

### Community 6 - "App API client"
Cohesion: 0.09
Nodes (35): Alerts, apiGet(), conditionalCache, Departure, Departures, getAllLocations(), getDepartures(), getLocations() (+27 more)

### Community 7 - "Settings screen"
Cohesion: 0.09
Nodes (23): Choice(), Divider(), Health, styles, Glass(), GlassProps, liquidGlass, styles (+15 more)

### Community 8 - "Search screen"
Cohesion: 0.11
Nodes (29): CategoryTab(), EMPTY_RESULTS, FailureState(), filterLines(), InlineLoading(), LineResult, LineRow(), LoadingState() (+21 more)

### Community 9 - "GTFS store"
Cohesion: 0.09
Nodes (24): AdmZip, {
  angleBetween,
  boundsOf,
  cumulativeDistances,
  distanceMeters,
  projectToPolyline,
  simplify,
}, { assertComplete, entryBuffer, findEntry, isInForce }, { categorizeLines, lineToType }, config, DAY_KEYS, { downloadGtfs }, { GrowableFloat64Array, GrowableInt32Array } (+16 more)

### Community 10 - "Open-data tests"
Cohesion: 0.10
Nodes (18): { after, before, describe, it }, assert, baseRow(), config, { createApp }, DIFF_LINE_NAMES, DIFF_TYPES, { distanceMeters } (+10 more)

### Community 11 - "Upstream doctor"
Cohesion: 0.19
Nodes (22): AdmZip, { assertComplete }, checkAlerts(), checkGtfs(), checkKlosok(), checkOpenData(), checkVehicles(), config (+14 more)

### Community 12 - "Modal UI"
Cohesion: 0.15
Nodes (14): HintRowProps, styles, ModalScreen(), ModalScreenProps, styles, styles, ThemedTextProps, ThemedView() (+6 more)

### Community 13 - "App tooling"
Cohesion: 0.09
Nodes (21): eslint-config-expo, @types/react, typescript, devDependencies, eslint, eslint-config-expo, @types/react, typescript (+13 more)

### Community 14 - "Alert parsing"
Cohesion: 0.15
Nodes (16): asArray(), config, { fetchWithTimeout, requestText }, { lineToType }, logger, NitterProvider, NoticeProvider, parseFeed() (+8 more)

### Community 15 - "HTTP routes"
Cohesion: 0.13
Nodes (21): CATEGORIES, cacheFor(), { CATEGORIES }, conditionalJson(), config, createRouter(), crypto, { describeVehicle } (+13 more)

### Community 17 - "Vehicle tracking"
Cohesion: 0.16
Nodes (4): tryEachSource(), fetchOpenDataVehicles(), summarise(), VehicleTracker

### Community 18 - "App layout"
Cohesion: 0.14
Nodes (16): MODAL_OPTIONS, RootLayout(), getLines(), usePreferences(), emit(), hydrateRecentStops(), isRecentStop(), list (+8 more)

### Community 19 - "Router screens"
Cohesion: 0.14
Nodes (13): expo-router, AlertsScreen(), styles, SettingsScreen(), Props, PollState, usePoll(), orderAlertsForSelectedLines() (+5 more)

### Community 20 - "Admin tests"
Cohesion: 0.11
Nodes (17): { after, before, describe, it }, assert, { buildFixtureZip }, { createApp }, fakeAlerts, fakeVehicles, fs, { GtfsStore } (+9 more)

### Community 21 - "Line badges"
Cohesion: 0.19
Nodes (16): LineBadge(), LineBadgeProps, SIZES, styles, StopDetails(), StopDetailsProps, styles, ThemedText() (+8 more)

### Community 22 - "GTFS archives"
Cohesion: 0.20
Nodes (11): AdmZip, assertComplete(), entryBuffer(), findEntry(), isDate(), isInForce(), { parseTable }, readEffectiveWindow() (+3 more)

### Community 23 - "Vehicle progress"
Cohesion: 0.16
Nodes (17): angleBetween(), secondsToTime(), { angleBetween, distanceMeters, projectToPolyline }, describeVehicle(), fastProjection(), firstIndexAtLeast(), { HEADING_PENALTY_METERS }, { inWarsaw, secondsToTime } (+9 more)

### Community 24 - "Express application"
Cohesion: 0.14
Nodes (15): compression, config, cors, createApp(), { createRouter }, express, logger, assert (+7 more)

### Community 25 - "Cache utility"
Cohesion: 0.14
Nodes (6): LruCache, { LruCache }, VehicleDetailCache, assert, { describe, it }, { VehicleDetailCache }

### Community 26 - "Klosok polling"
Cohesion: 0.14
Nodes (15): config, { distanceMeters }, { fetchKlosokFeed }, fullVehicleEquals(), KLOSOK_FULL_EXTRA_FIELDS, KLOSOK_MAP_FIELDS, { lineToType }, logger (+7 more)

### Community 27 - "Map screen"
Cohesion: 0.16
Nodes (15): EMPTY_STOPS, EMPTY_VEHICLES, MapScreen(), RoundButton(), Selection, shadow, styles, FleetVehicle (+7 more)

### Community 28 - "Vehicle benchmarks"
Cohesion: 0.17
Nodes (15): advance(), { bearingDegrees }, buildFleet(), { describeVehicle }, fs, { GtfsStore }, main(), path (+7 more)

### Community 29 - "Open-data benchmarks"
Cohesion: 0.18
Nodes (15): assertSameFleet(), { distanceMeters }, LINE_NAMES, main(), makeFleet(), MERGE_OPTIONS, { mergeFleet }, mergeFleetReference() (+7 more)

### Community 30 - "Nitter verification"
Cohesion: 0.15
Nodes (13): config, main(), { parseFeed }, { requestText }, config, http, https, logger (+5 more)

### Community 31 - "Typed GTFS arrays"
Cohesion: 0.15
Nodes (6): timeToSeconds(), GrowableFloat64Array, GrowableInt32Array, assert, { describe, it }, { GrowableFloat64Array, GrowableInt32Array }

### Community 33 - "Vehicle ingestion"
Cohesion: 0.14
Nodes (15): { bearingDegrees, distanceMeters }, BODY_ENCODINGS, BOUNDS, config, { describeVehicle, summarise }, {
  fetchOpenDataVehicles,
  mergeFleet,
  normalizeOpenDataRecord,
}, { fetchWithTimeout, tryEachSource, SourceHealth }, FIELD_ALIASES (+7 more)

### Community 34 - "Klosok GTFS tests"
Cohesion: 0.13
Nodes (12): AdmZip, buildKlosokFixtureZip(), { after, before, describe, it }, assert, { buildKlosokFixtureZip }, { createApp }, fakeAlerts, fakeVehicles (+4 more)

### Community 35 - "Realtime updates"
Cohesion: 0.22
Nodes (14): BOUNDS, config, findTripUpdate(), inWarsaw(), isFiniteNumber(), normaliseBearing(), parseLabel(), parseRealtime() (+6 more)

### Community 36 - "Live departures"
Cohesion: 0.15
Nodes (12): enrichDepartures(), LIVE_CLEAR, pickLiveVehicle(), { after, before, beforeEach, describe, it }, assert, { buildFixtureZip }, config, { createApp } (+4 more)

### Community 37 - "End-to-end scenarios"
Cohesion: 0.13
Nodes (12): assert, { buildFixtureZip }, config, { createApp }, { describe, it }, fakeAlerts, fixtureB, { GtfsStore } (+4 more)

### Community 38 - "Browser map tests"
Cohesion: 0.14
Nodes (12): { after, before, describe, it }, APP_PALETTE, assert, { buildFixtureZip }, contrast(), { createApp }, fs, { GtfsStore } (+4 more)

### Community 39 - "Klosok fetcher"
Cohesion: 0.16
Nodes (11): { Agent }, config, fetchKlosokFeed(), { fetchWithTimeout }, getKlosokAgent(), { Agent }, assert, config (+3 more)

### Community 40 - "Upstream monitoring"
Cohesion: 0.15
Nodes (13): Doctor connectivity check, GitHub issue reporting, Upstream watch workflow, Browser map, GTFS runtime discovery, Server API, Independent vehicle-source merging, Wrocław MPK Map (+5 more)

### Community 41 - "TypeScript configuration"
Cohesion: 0.15
Nodes (12): ./assets/*, expo-env.d.ts, expo/tsconfig.base, .expo/types/**/*.ts, **/*.ts, **/*.tsx, compilerOptions, paths (+4 more)

### Community 42 - "Geospatial utilities"
Cohesion: 0.28
Nodes (11): bearingDegrees(), boundsOf(), cumulativeDistances(), distanceMeters(), distanceToPolyline(), LON_SCALE, perpendicularDistance(), projectToPolyline() (+3 more)

### Community 43 - "Source health"
Cohesion: 0.21
Nodes (4): SourceHealth, assert, { describe, it }, { SourceHealth }

### Community 44 - "Line categorisation"
Cohesion: 0.29
Nodes (11): categorizeLines(), compareLines(), emptyCategories(), EXPRESS_LINES, isTram(), lineToType(), SPECIAL_TRAM_LINES, TRAM_CATEGORIES (+3 more)

### Community 45 - "Metrics utility"
Cohesion: 0.19
Nodes (7): Metric, { performance }, timeAsync(), timeSync(), assert, { describe, it }, { Metric, timeAsync, timeSync }

### Community 46 - "Shape cache tests"
Cohesion: 0.15
Nodes (10): assert, { buildFixtureZip }, { createApp }, { describe, it }, fakeAlerts, fakeVehicles, fixtureA, fixtureB (+2 more)

### Community 47 - "Stop search API"
Cohesion: 0.27
Nodes (11): ApiError, distanceMeters(), foldSearchText(), groupSamePlatform(), normaliseStops(), sameBoardingArea(), searchStops(), stopAreaCode() (+3 more)

### Community 48 - "Vehicle-detail benchmarks"
Cohesion: 0.24
Nodes (11): advance(), { bearingDegrees }, buildFleet(), { describeVehicle }, fs, { GtfsStore }, main(), path (+3 more)

### Community 49 - "Alert tests"
Cohesion: 0.20
Nodes (10): fingerprint(), normalizeText(), { stripHtml }, {
  AlertsService,
  extractAffectedLines,
  fingerprint,
  normalizeText,
  parseFeed,
  parsePage,
  stripHtml,
  toXPostUrl,
}, assert, config, { describe, it }, fetch() (+2 more)

### Community 50 - "Open-data vehicles"
Cohesion: 0.24
Nodes (11): BOUNDS, { distanceMeters }, { fetchWithTimeout }, FIELD_ALIASES, inBounds(), { lineToType }, normalizeOpenDataRecord(), parseWarsawDate() (+3 more)

### Community 51 - "Klosok realtime tests"
Cohesion: 0.20
Nodes (10): assert, { before, describe, it }, { buildKlosokFixtureZip }, encode(), feed(), { findTripUpdate, parseLabel, parseRealtime, pickActiveTrip, resolveEnrichment, tripDelay }, { GtfsStore }, now() (+2 more)

### Community 52 - "Locations cache tests"
Cohesion: 0.17
Nodes (10): { after, describe, it }, assert, config, { createApp }, fakeAlerts, { GtfsStore }, http, lines (+2 more)

### Community 53 - "Alert service"
Cohesion: 0.25
Nodes (3): AlertsService, extractAffectedLines(), mergeAlert()

### Community 54 - "Server logging"
Cohesion: 0.18
Nodes (6): LEVELS, assert, config, { describe, it, beforeEach, afterEach }, { KlosokService }, logger

### Community 55 - "Klosok expiry tests"
Cohesion: 0.18
Nodes (7): assert, config, { createApp }, { describe, it, beforeEach, afterEach }, { KlosokService }, { shapeCache }, startApp()

### Community 56 - "GTFS refresh tests"
Cohesion: 0.22
Nodes (9): archiveOf(), assert, { buildFixtureZip }, buildToGeneration(), { describe, it }, fixtureA, fixtureB, { GtfsStore } (+1 more)

### Community 57 - "Browser map client"
Cohesion: 0.22
Nodes (10): Wroclive landing page, Static browser map, apiGet, Server browser map client, Stop departures request, Leaflet map, Map polling loaders, renderVehicles (+2 more)

### Community 58 - "API tests"
Cohesion: 0.20
Nodes (9): shapeCache, { after, before, describe, it }, assert, { buildFixtureZip }, { createApp }, fakeAlerts, fakeVehicles, { GtfsStore } (+1 more)

### Community 59 - "Vehicle tests"
Cohesion: 0.20
Nodes (8): { after, afterEach, before, beforeEach, describe, it }, assert, { buildFixtureZip }, config, { GtfsStore }, http, logger, { VehicleTracker, bearing, normalizeVehicle }

### Community 60 - "Lines screen"
Cohesion: 0.33
Nodes (9): CategoryTabProps, LinesScreen(), styles, useGrid(), plural(), HIDDEN_CATEGORIES, labelFor(), shortLabelFor() (+1 more)

### Community 61 - "App dependencies"
Cohesion: 0.22
Nodes (9): expo-maps, react-native, react-native-web, react-native-webview, dependencies, expo-maps, react-native, react-native-web (+1 more)

### Community 62 - "Server configuration"
Cohesion: 0.22
Nodes (4): ALERT_PAGES, DEFAULTS, path, VEHICLE_SOURCES

### Community 63 - "CSV parsing"
Cohesion: 0.28
Nodes (8): CSV_OPTIONS, { parse }, { parse: parseSync }, { Readable }, splitCsvLine(), streamTable(), streamTableFast(), warsawWallClock

### Community 64 - "Project reset script"
Cohesion: 0.22
Nodes (7): exampleDirPath, fs, oldDirs, path, readline, rl, root

### Community 65 - "GTFS benchmarks"
Cohesion: 0.36
Nodes (7): fs, gc(), { GtfsStore }, main(), path, sample(), sleep()

### Community 66 - "GTFS diagnostics"
Cohesion: 0.33
Nodes (6): crypto, fs, { GtfsStore }, hashPoints(), main(), path

### Community 67 - "Native splash animation"
Cohesion: 0.29
Nodes (4): glowKeyframe, keyframe, logoKeyframe, styles

### Community 68 - "Web splash animation"
Cohesion: 0.29
Nodes (4): glowKeyframe, keyframe, logoKeyframe, styles

### Community 69 - "Continuous integration"
Cohesion: 0.50
Nodes (4): CI workflow, Docker image job, Server test job, Wroclive build job

### Community 70 - "Dark app branding"
Cohesion: 0.50
Nodes (4): Dark Wroclive app icon, Wrocław skyline icon background, Blue location pin layer, Tram illustration layer

### Community 71 - "Brand asset variants"
Cohesion: 0.50
Nodes (4): WrocLive light brand identity, WrocLive web favicon, WrocLive mobile app icon, WrocLive startup branding

### Community 72 - "App workflow screenshots"
Cohesion: 0.67
Nodes (3): Live vehicle map screen, Line filter bottom sheet, Service disruptions bottom sheet

### Community 73 - "Android adaptive icons"
Cohesion: 0.67
Nodes (3): Adaptive Android icon background, Adaptive Android icon foreground, Adaptive Android monochrome icon

## Knowledge Gaps
- **612 isolated node(s):** `cron`, `path`, `config`, `logger`, `{ createApp }` (+607 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **33 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vehicle()` connect `Open-data benchmarks` to `Klosok lifecycle`, `Search screen`, `HTTP routes`, `Vehicle tracking`, `Cache utility`, `Vehicle benchmarks`?**
  _High betweenness centrality (0.284) - this node is a cross-community bridge._
- **Why does `SearchScreen()` connect `Search screen` to `App layout`, `Open-data benchmarks`, `App API client`, `Stop search API`?**
  _High betweenness centrality (0.281) - this node is a cross-community bridge._
- **Why does `useTheme()` connect `Search screen` to `Settings screen`, `Modal UI`, `App layout`, `Router screens`, `Line badges`, `Map screen`, `Lines screen`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **What connects `cron`, `path`, `config` to the rest of the system?**
  _612 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Apple map renderer` be split into smaller, more focused modules?**
  _Cohesion score 0.053208137715179966 - nodes in this community are weakly interconnected._
- **Should `Server startup` be split into smaller, more focused modules?**
  _Cohesion score 0.05370101596516691 - nodes in this community are weakly interconnected._
- **Should `Server dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.041666666666666664 - nodes in this community are weakly interconnected._