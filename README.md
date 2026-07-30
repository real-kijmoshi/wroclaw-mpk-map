# Wrocław MPK Map

Real-time tracking for Wrocław's trams and buses: an Expo app and the API that feeds it.
Vehicle positions come from MPK Wrocław's public endpoint, timetables and route shapes from
the city's GTFS feed, and disruption notices from public RSS feeds.

<div style="display: flex; gap: 10px;">
    <img src="images/screen1.jpg" alt="Map with tracked vehicles" width="260"/>
    <img src="images/screen2.jpg" alt="Line selection" width="260"/>
    <img src="images/screen3.jpg" alt="Service alerts" width="260"/>
</div>

> Not affiliated with MPK Wrocław. It reads public data the city publishes as open data.

## Quick start

```bash
# API
cd server
npm install
npm run doctor   # confirms MPK and the city portal are answering right now
npm start        # http://localhost:3000

# App (in another terminal)
cd app
npm install
API_URL=http://localhost:3000 npm start
```

Open <http://localhost:3000/map> for a browser map and <http://localhost:3000/status> for a
dashboard showing which upstream sources are live.

## Why things break, and how this handles it

Both upstream sources have moved before — the city migrated its open-data portal, and the
`bus_position` endpoint has changed shape more than once. So no URL is hardcoded in one
place:

- **Every source is a prioritised list.** The server tries each candidate in order and
  reports the one that answered on `/health`. Add a new URL at the front of `GTFS_URLS`,
  `VEHICLE_POSITION_URLS` or `ALERT_FEED_URLS` and nothing else needs changing.
- **`npm run doctor`** checks all of them from your machine and prints exactly what failed.
- **The GTFS archive is cached on disk.** If the portal is down at boot, the server starts
  with the last good timetable rather than serving nothing.
- **Vehicle records are matched by field aliases,** so a renamed `x`/`y` field does not
  silently produce an empty map.
- **A scheduled GitHub Action** runs the doctor daily and opens an issue when a required
  source stops answering.

## API

Base URL: your deployment, or `http://localhost:3000`.

| Endpoint | Description |
| --- | --- |
| `GET /lines` | All lines grouped by category (`tram`, `busNight`, `busExpress`, …) |
| `GET /lines/:category` | One category |
| `GET /locations` | Live vehicle positions. `?line=4,17` and `?type=tram` filter |
| `GET /shapes/:line` | Route shape and stops. `?lat=&lon=` picks the variant nearest a vehicle, `?format=compact` halves the payload |
| `GET /shapes/:line/variants` | Every variant of a route |
| `GET /stops?q=rynek` | Stop search, diacritic-insensitive |
| `GET /stops/:line` | Every stop served by a line |
| `GET /stop/:id` | Stop details |
| `GET /stop/:id/departures` | Next departures, filtered to services running today. `?limit=` `?within=` (minutes) |
| `GET /alerts` | Disruption notices. `?since=` (ms epoch) `?line=` |
| `GET /health` | Status of every upstream source and index |
| `GET /map`, `GET /status` | Browser map and status dashboard |

`/shapes/:line` returns the verbose legacy payload by default so app builds already on
people's phones keep working; `?format=compact` is what the current app requests.

## Repository layout

```
app/                 Expo app (SDK 57, React Native 0.86)
  api.js             API client — base URL comes from Expo config, not a hardcoded IP
  components/        Map, bottom sheet, status pill
  modals/            Line picker, alerts, settings
server/
  index.js           Entry point: starts HTTP first, loads data in the background
  src/config.js      Every tunable and every upstream URL list
  src/gtfs/          Download, parse, index and query the GTFS feed
  src/vehicles.js    Live position polling and normalisation
  src/alerts.js      RSS/Atom providers (X/Twitter optional)
  src/routes.js      HTTP endpoints
  scripts/doctor.js  Upstream connectivity check
  test/              Unit and HTTP tests, no network required
```

## Development

```bash
cd server
npm test       # unit + HTTP integration tests against an in-memory GTFS fixture
npm run lint
npm run dev    # restarts on change
```

Tests build a small GTFS archive in memory, so they run offline and in CI.

## Deploying

The server holds the whole timetable in memory. Budget roughly 400 MB with the departure
index enabled, about half that with `GTFS_BUILD_STOP_INDEX=false`.

```bash
docker build -t wroclaw-mpk-api ./server
docker run -p 3000:3000 -v gtfs-cache:/app/data wroclaw-mpk-api
```

`server/render.yaml` deploys it to Render as-is. Any host works — it is a plain Node
process with no database. Mount a volume at `/app/data` so the cached GTFS archive
survives restarts.

See [`server/.env.example`](server/.env.example) for every setting.

## Publishing the app

`app/app.config.js` holds the store metadata; the API URL comes from `API_URL` at build
time (set per profile in `app/eas.json`), so no plain-HTTP address ships in the bundle.

```bash
cd app
npx expo-doctor                                    # config and dependency check
eas build --platform android --profile production
eas submit --platform android
```

Before the first submission you still need to, outside this repo:

- create the Play Console and App Store Connect listings,
- provide a privacy policy URL (the app collects nothing; location stays on the device),
- upload screenshots and a feature graphic,
- point `API_URL` in `eas.json` at your deployed API.

## Data sources

- Timetables: [Otwarte Dane Wrocław — GTFS](https://opendata.cui.wroclaw.pl/dataset/rozkladjazdytransportupublicznegoplik_data)
- Vehicle positions: `POST https://mpk.wroc.pl/bus_position`
- Disruptions: public RSS feeds (configurable)

Check the terms of use of each source before deploying publicly.

## License

MIT — see [LICENSE](LICENSE).
