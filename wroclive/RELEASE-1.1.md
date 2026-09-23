# Wroclive 1.1 release runbook

Run these commands from `wroclive/`. The app is configured for Expo SDK 57,
`com.kijmoshi.wroclive`, the `kijmoshi` EAS project, and the production API at
`https://api.wroclive.kijmoshi.xyz`. Version 1.1.0 changes native dependencies,
so existing 1.0 binaries cannot receive it over the air. Build new binaries.

## What ships in 1.1

App Store "Co nowego" (paste as is):

```
• Ulubione przystanki — gwiazdka przy przystanku, a na starcie od razu najbliższe odjazdy.
• Widżety na ekranie głównym i blokady, z czasem dojścia na przystanek.
• Powiadomienie ok. 2 minuty przed przyjazdem i odliczanie na ekranie blokady (Live Activity).
• „Prowadź pieszo” i „Wyjdź za … min” na tablicy odjazdów.
• Udostępnianie przystanków i pojazdów — link działa także bez aplikacji.
• Szybsze pozycje pojazdów i dokładniejsze odliczanie.
• Szybkie akcje po przytrzymaniu ikony aplikacji.
• Poprawki dostępności (VoiceOver) i drobne usprawnienia.
```

Dependencies: Expo SDK 57 is the newest stable SDK (58 is still a preview
and is not a release base), and every package sits on the version SDK 57
expects — `npx expo-doctor` reports no version mismatches. `npm audit` lists
moderate advisories in two transitive packages that cannot be fixed without
breaking Expo: `uuid` inside `xcode` (build-time tooling only, never in the
app) and `decode-uri-component` inside `expo-router`'s URL parsing (worst case,
a malformed link slows the phone that opened it). Both clear when Expo ships
updated dependencies; `npm audit fix --force` would downgrade Expo and must not
be run. The app declares its required-reason APIs in `ios.privacyManifests`
(`app.json`), which App Store Connect checks on upload.

## Before building

1. Deploy the server change first. Check `https://api.wroclive.kijmoshi.xyz/health`:
   `gtfs.state` should be `ready`, `gtfs.fromCache` should be `false`, and
   `gtfs.effectiveStart` should identify the latest schedule in force.
2. Commit and push the reviewed 1.1 source. Build and publish updates from that
   same commit. Keep unrelated working tree edits out of the release.
3. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npx expo-doctor`, and
   `npx expo export --platform web --output-dir dist`. Run `npm test` and
   `npm run lint` in `../server` too.
4. Run `eas whoami` and `eas build:version:get --platform all`. The EAS remote
   iOS build number was 6 before this release; the production profile increments
   it automatically. There was no Android remote version yet.

The API address is baked into the JavaScript bundle. EAS Build gets it from
`eas.json`; EAS Update uses EAS environment variables. Set the same public value
for preview and production once in the EAS project:

```sh
eas env:set --name EXPO_PUBLIC_API_URL --value https://api.wroclive.kijmoshi.xyz --environment preview --visibility plaintext
eas env:set --name EXPO_PUBLIC_API_URL --value https://api.wroclive.kijmoshi.xyz --environment production --visibility plaintext
eas env:list preview
eas env:list production
```

The app also has this production URL as a fallback. The explicit EAS variables
make the build and update environments match and keep future URL changes clear.

## Build and check 1.1

```sh
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

1.1 also adds an iOS widget extension (`ExpoWidgetsTarget`) and an App Group
(`group.com.kijmoshi.wroclive`). EAS reads both from the `expo-widgets` plugin
and provisions them on the first iOS build — let it create the App Group and
the extension's profile when it asks. Nothing else in App Store Connect needs
setting up: the app sends no push, so no APNs key is needed.

**Live Activity push (optional).** To keep the lock-screen countdown right
while the app is suspended, create an APNs auth key (Apple Developer → Keys →
Apple Push Notifications service) and set `APNS_KEY_ID`, `APNS_TEAM_ID` and
`APNS_PRIVATE_KEY_PATH` on the server — see `server/.env.example`. Use
`APNS_PRODUCTION=false` for a server that preview/development builds talk to.
`/health.liveActivities` says whether it is enabled. Without a key everything
still works; the countdown just follows the last estimate while the phone is
locked. The app now carries the push entitlement for this, so EAS will enable
Push Notifications on the App ID on the first build.

**App Store privacy labels.** Data used to track you: none. Data linked to
you: none. Location is used on the device only and never sent, so it is not
"collected". The one judgement call is the Live Activity push token (only when
the server has an APNs key): it leaves the phone but is held in memory only
while it is needed to update that one ride. Apple's definition of "collect"
excludes data kept only as long as needed to service the request in real
time, which is the argument for declaring nothing. If in doubt, declare
Identifiers → Device ID, used for App Functionality, not linked to the user,
not used for tracking. The privacy policy (`landing/privacy.html`) describes
the token either way.

Install both preview builds. Check first launch, location denied and granted,
light and dark map, vehicle movement, line and stop selection, departures,
alerts, settings, background/resume, and a cold start while the API is loading.
New in 1.1, check too: starring a stop (it appears under "Ulubione" and in the
widget), sharing a stop and a vehicle (the link opens `map.html` on that stop
or vehicle), tapping a stop in a vehicle's list (notification permission is
asked then, not at launch; the banner arrives about two minutes before; on
iOS a Live Activity counts down on the lock screen), adding the "Odjazdy"
widget and tapping it (opens that stop), and the fleet fading when the phone
goes offline. Then the second batch: the widget on the lock screen and its
"Ulubiony przystanek" setting (long-press → Edytuj widżet), "Prowadź pieszo" and
"Wyjdź za … min" on a stop board with location on, the home-screen quick
actions (long-press the icon), the armed-alert card in the vehicle sheet and on
the home sheet, and — with an APNs key on the preview server — a locked phone's
Live Activity still moving when the tram is held up. Background refresh
cannot be forced on a release build; leave a widget on the home screen
overnight and check it the next morning.
Expo Go does not test EAS Update; use the installed preview builds for that.

To exercise OTA before production, make a small visible JavaScript-only change
on the same 1.1 native dependencies, then run:

```sh
eas update --channel preview --environment preview --message "1.1 OTA smoke test"
eas update:list --branch preview
```

Open each preview app, use **Ustawienia → Aktualizacje** to fetch the update,
then force close and reopen. Confirm the changed UI appears. The app also checks
on launch and resume, and applies a downloaded update after a long background
interval or on the next cold start. Confirm the running update ID in Settings.

After the preview passes, build store binaries from the reviewed commit:

```sh
eas build --platform ios --profile production
eas build --platform android --profile production
eas build:list --limit 5
```

Check that both builds say app version `1.1.0` and channel `production`. Native
dependencies changed in this release, so keep `runtimeVersion.policy` as
`fingerprint`. An OTA is delivered only when platform and runtime fingerprint
match the installed binary.

Upload the approved binaries for store testing:

```sh
eas submit --platform ios --profile production --latest
eas submit --platform android --profile production --latest
```

Apple still requires TestFlight/App Store Connect review and release actions;
Google Play requires its testing/release track actions. Submitting is not the
same as making the release public.

## OTA after 1.1 is installed

For JavaScript, styles, and asset changes that need no new native dependency or
permission, test on `preview` first. Publish the same tested update to
production only after verifying the output runtime matches a 1.1 production
build:

```sh
eas update --channel preview --environment preview --message "Describe the fix"
eas update:list --branch preview
eas update --channel production --environment production --message "Describe the fix"
eas update:list --branch production
```

Publish from a clean, reviewed commit. If the preview and production environments
and runtime fingerprints are identical, `eas update:republish --channel preview
--destination-channel production --message "Promote tested fix"` can promote the
exact tested bundle instead of creating a new one.

If an OTA is faulty, run `eas update:rollback` and select the production channel
and the previous update or embedded build. Check `eas update:list --branch
production` afterward. A native change needs another store build, never OTA.

References: [EAS Update setup](https://docs.expo.dev/eas-update/getting-started/),
[update deployment](https://docs.expo.dev/eas-update/deployment/),
[environment variables](https://docs.expo.dev/eas/environment-variables/usage/),
[rollback](https://docs.expo.dev/eas-update/rollbacks/).
