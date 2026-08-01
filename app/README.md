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

`react-native-maps` needs native code, so Expo Go cannot show the map — a development
build (`expo-dev-client`) gives the real one on both platforms:

```bash
eas build --profile development --platform android
```

## The web build

`platforms` includes `web`, and `public/index.html` is the template Expo's metro web
bundler renders into. It is not decoration: `viewport-fit=cover` is what makes
`env(safe-area-inset-*)` report real numbers, which is where every safe-area value in
the UI comes from, and the reset kills the rubber-band scroll and pull-to-refresh that
otherwise fire whenever a drag starts on the map. Keep the react-native-web root reset
(`html, body { height: 100% }`, `#root { display: flex }`) if you edit it.

The map itself cannot render in a browser — see "Previewing the app without a device"
in [CLAUDE.md](../CLAUDE.md).

## Configuration

The API base URL is **not** committed as a literal. It flows:

```
API_URL (env / eas.json)  ->  app.config.js extra.apiUrl  ->  api.js API_URL
```

That keeps a plain-HTTP address out of production bundles, which both stores reject
(App Transport Security on iOS, cleartext traffic on Android).

`expo-updates` backs the `channel` each `eas.json` profile declares, with the
`appVersion` runtime policy: an OTA update only reaches builds whose `version` in
`app.config.js` matches, so a JS-only fix ships without a store review while a native
change still needs a new build.

## Layout

| Path | What it does |
| --- | --- |
| `App.jsx` | State, polling loops, permission request, floating tab bar |
| `api.js` | API calls with timeouts and Polish error messages |
| `theme.js` | Colours, iOS type scale, spacing, materials, springs |
| `components/MapView.jsx` | Map, vehicle markers, route polyline, route card, locate button |
| `components/Modal.jsx` | Bottom sheet: grabber, sheet header, swipe-to-dismiss |
| `components/DeparturesSheet.jsx` | The amber departure board for a tapped stop |
| `components/StatusPill.jsx` | Data-freshness pill, and the shortcut into the line picker |
| `components/Material.jsx` | Translucent surface (real backdrop blur on the web) |
| `components/PressableScale.jsx` | Press-to-shrink touchable with haptics |
| `modals/` | Line picker, alerts, settings |
| `public/index.html` | The web shell: safe areas, no overscroll, home-screen metas |

### Layout rules worth knowing

The tab bar floats over the map, so nothing may be positioned against the bottom of
the screen by hand. `App.jsx` derives one `tabBarSpace` from `TAB_BAR_HEIGHT` and the
safe-area inset, and passes it down (`bottomOffset`) to everything that has to clear
it. Sizes come from `useWindowDimensions`, never from a `Dimensions.get` read at import
time — that value is captured once and is wrong after a rotation or a browser resize.

## Building for the stores

```bash
npx expo-doctor
eas build --platform android --profile production
eas build --platform ios --profile production
eas submit --platform android
```

Bump `version` in `app.config.js` for each release; `eas.json` sets `autoIncrement` so
build numbers advance on their own.

### Signing credentials

Signing keys live on the Expo server (`credentialsSource` defaults to `remote`), tied to
the `kijmoshi` account that owns the project — nothing signing-related is or should be
committed here.

**The first iOS build has to run interactively.** EAS can only create a distribution
certificate and provisioning profile by signing in to the Apple Developer account, and it
refuses to do that without a terminal it can prompt in:

```
✔ Using remote iOS credentials (Expo server)
Distribution Certificate is not validated for non-interactive builds.
Failed to set up credentials.
Credentials are not set up. Run this command again in interactive mode.
```

That is the whole error — the build never started, and nothing in this repo can fix it.
Run the setup once from a real terminal, with an Apple Developer Program membership
(the paid one; a free account cannot issue a distribution certificate):

```bash
eas login                        # the account that owns the project
eas credentials --platform ios   # Production -> Build Credentials -> set up new
```

Then `eas build --platform ios --profile production` works, non-interactively too,
until the certificate expires a year later.

Note that `--non-interactive` is not the only way to end up in this state: EAS also goes
non-interactive when stdin is not a TTY, so the same failure appears when a build is run
from CI, from a script, or through an agent.

**Android needs none of this.** EAS generates and stores the keystore itself, without
Apple in the loop, so `eas build --platform android --profile production` runs
unattended today.

For CI, create a robot access token in the Expo dashboard and expose it as `EXPO_TOKEN`;
it replaces `eas login` but does *not* replace the one-time interactive iOS setup above.

If you would rather hold the keys yourself, put them in `app/credentials.json` and set
`"credentialsSource": "local"` on the profile. That file and the `.p12`/`.mobileprovision`
it points at are gitignored — keep it that way.
