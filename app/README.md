# WroMapa — mobile app

Expo app showing MPK Wrocław trams and buses on a live map. See the
[repository README](../README.md) for the project as a whole.

## Running it

```bash
npm install
API_URL=http://localhost:3000 npm start
```

Then press `a` for Android, `i` for iOS or `w` for web. Without `API_URL` the app talks to
the default deployment in `app.config.js`.

`react-native-maps` needs native code, so a development build gives the real map on both
platforms:

```bash
eas build --profile development --platform android
```

## Configuration

The API base URL is **not** committed as a literal. It flows:

```
API_URL (env / eas.json)  ->  app.config.js extra.apiUrl  ->  api.js API_URL
```

That keeps a plain-HTTP address out of production bundles, which both stores reject
(App Transport Security on iOS, cleartext traffic on Android).

## Layout

| Path | What it does |
| --- | --- |
| `App.jsx` | State, polling loops, permission request, navigation bar |
| `api.js` | API calls with timeouts and Polish error messages |
| `theme.js` | Colours and category labels shared by every screen |
| `components/MapView.jsx` | Map, vehicle markers, route polyline, departure board |
| `components/Modal.jsx` | Swipe-to-dismiss bottom sheet |
| `components/InfoBox.jsx` | Clock and data-freshness pill |
| `modals/` | Line picker, alerts, settings |

## Building for the stores

```bash
npx expo-doctor
eas build --platform android --profile production
eas build --platform ios --profile production
eas submit --platform android
```

Bump `version` in `app.config.js` for each release; `eas.json` sets `autoIncrement` so
build numbers advance on their own.
