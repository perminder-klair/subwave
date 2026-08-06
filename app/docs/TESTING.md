# Testing the SUB/WAVE app on iOS and Android

How to build, run, and test the Expo app on simulators/emulators, physical
devices, and via EAS cloud builds. Read the **Architecture-critical facts**
section first — one wrong toggle and playback crashes on launch.

---

## Architecture-critical facts (read before changing native config)

### Both platforms run the New Architecture — it's mandatory in RN 0.85

RN 0.82+ **removed the ability to opt out** of the New Architecture. Both
platforms run it ON, and this is required (Reanimated 4.3.1 only works under new
arch):

- **iOS** — `Info.plist RCTNewArchEnabled = true`, Pods built `-DRCT_NEW_ARCH_ENABLED=1`.
- **Android** — a generated `android/gradle.properties` may carry a leftover
  `newArchEnabled=false`, but **Gradle ignores it** and prints:
  `Setting newArchEnabled=false … is not supported anymore since React Native 0.82
  … The application will run with the New Architecture enabled by default.`
  The line is a harmless no-op; you can delete it.

`app.json` no longer declares `newArchEnabled` (it used to say `false` — equally
a no-op). Don't rely on such flags anywhere; they do nothing on this RN version.

### Why `react-native-track-player` still works under new arch

RNTP 4.1.2 is not natively New-Architecture-compatible — out of the box, Android
playback crashes with `You should not use ReactNativeHost directly in the New
Architecture` from `MusicService`. **The fix is `patches/react-native-track-player+4.1.2.patch`**,
which makes two source edits:

- `MusicModule.kt` — routes async `@ReactMethod`s through a Unit-returning
  `launch` helper (TurboModule interop requires void-returning async methods).
- `MusicService.kt` — `currentReactContextCompat()` obtains the `ReactContext`
  from `ReactHost` (new arch) instead of the `ReactNativeHost.reactInstanceManager`
  path that throws, with an old-arch fallback.

> Do not delete this patch. Without it, Android RNTP crashes on the first
> playback event. iOS (SwiftAudioEx path) is unaffected by the crash but the
> patch is harmless there. Validated: Android `BUILD SUCCESSFUL` and iOS live
> playback both with the patch applied.

### Other load-bearing facts

- **Expo Go does not work** — native modules (RNTP, Skia, Reanimated worklets)
  ship compiled code. You must build a **dev client**.
- **Stream is MP3 only** (`{base}/stream.mp3`), same universal-floor choice as
  the web player. No Opus/Ogg.
- **No backend needed for testing** — the app defaults to the public
  `getsubwave.com` station, which is live. Onboarding pre-fills it.
- **Base URL is fully runtime** — there are no hardcoded station URLs in source.
  All API/stream URLs come from `StationContext` → `createApi(baseUrl)`.
- **Cast + AirPlay need physical hardware.** Neither Google Cast discovery nor
  the AirPlay picker works in a simulator/emulator — test with a real phone and
  a Chromecast/Nest (or HomePod/Apple TV) on the **same Wi-Fi**. On iOS the
  first tap of the cast button triggers the Local Network permission prompt
  (deny = no devices found, ever — reset via Settings → Privacy → Local
  Network). Cast hands playback OFF the phone: while a session is connected,
  RNTP is torn down and the phone is a remote — expect no lock-screen media
  controls, and the deck's Signal cell reads `Cast · <device>`.
  `react-native-google-cast` runs under the New Architecture in **compat
  (interop) mode** (v5 will be native); if a Cast API breaks after an RN/Expo
  upgrade, check the library's v5 status before patching.

---

## Prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node 20+ / npm | everything | `npm install` (uses `legacy-peer-deps`, set in `.npmrc`) |
| Xcode 16+ + CocoaPods | iOS sim/device | `xcode-select --install`, `sudo gem install cocoapods` |
| **JDK 17** | Android build | `brew install openjdk@17`. **Not** JDK 21 (Android Studio's JBR) — it fails the Gradle build with a JVM-target mismatch. |
| Android SDK + an AVD | Android emulator | via Android Studio; emulator binary at `$ANDROID_HOME/emulator` |

First-time setup:

```bash
cd app
npm install        # postinstall applies patches/ via patch-package
```

---

## Local testing — iOS simulator

The fast inner loop. No Apple Developer account required.

```bash
cd app

# Build, install, and launch on a booted simulator.
# (Boot one first via: open -a Simulator)
npx expo run:ios

# If run:ios skips the dev server (non-interactive shells do), start Metro
# yourself and open the installed app pointed at localhost:
npx expo start --dev-client --port 8081 &
xcrun simctl openurl <SIM_UDID> \
  "exp+subwave://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

**Use `localhost`, not the LAN IP**, in the deep link for simulators — the LAN
IP can time out (`xcrun simctl openurl ... code: 60`).

**Verified working** (2026-06): builds clean (0 errors), bundles 4075 modules,
renders onboarding → health check (all 4 probes OK against live getsubwave.com)
→ player with live audio (NOW PLAYING timer advances), runtime theming, cover
art, and the Skia spectrum.

---

## Local testing — Android emulator

```bash
cd app

# Boot an AVD (list them: $ANDROID_HOME/emulator/emulator -list-avds)
$ANDROID_HOME/emulator/emulator -avd <AVD_NAME> &

# Build with JDK 17 — single connected emulator is auto-selected.
# DO NOT pass `--device <adb-serial>`; expo wants an AVD name, not emulator-5554.
JAVA_HOME=/opt/homebrew/opt/openjdk@17 npx expo run:android
```

If the dev client opens against the LAN IP and can't reach Metro, set the
reverse tunnel and relaunch via localhost:

```bash
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW \
  -d "exp+subwave://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" \
  com.getsubwave.app
adb exec-out screencap -p > /tmp/screen.png   # always screenshot to verify
```

**Verified working** (2026-06): `BUILD SUCCESSFUL` with JDK 17 (new arch ON, via
the RNTP patch), debug APK installed on the emulator. (Physical-device run is
covered and proven by the `subwave-app-android` skill — see below.)

---

## Physical devices

### Android phone — use the `subwave-app-android` skill

The repo ships a skill (`.claude/skills/subwave-app-android/`) that automates
getting the app onto a connected Pixel, in two modes:

- **Dev / USB** — dev-client app loads live JS from Metro over `adb reverse`;
  hot-reload while tethered.
- **Release / embedded** — self-contained release APK (`./gradlew assembleRelease`
  with **JDK 17**) that runs unplugged over WiFi/cellular.

It handles the JDK-17 gotcha, the Metro tunnel, the deep link, and screenshots
to verify. The release APK is signed with the **debug keystore** — fine for
sideloading, **not** for Play Store.

### iOS device

Two options:
1. **Local** — open `ios/SUBWAVE.xcworkspace` in Xcode, select your device,
   set a development team (Signing & Capabilities), run. Needs a free or paid
   Apple ID for on-device signing.
2. **EAS** — `eas build --profile development-device --platform ios` (see below).

Background audio (lock screen / CarPlay / headphones) and metadata can only be
properly judged on a **physical device** — the remote-control wiring lives in
`service.ts` (Play/Pause/Stop; Next/Seek intentionally omitted for a live
stream).

### CarPlay & Android Auto — launchable in-car apps

Both car platforms now get a real SUB/WAVE app on the car screen: a Stations
list (featured + saved recents, the same `carStations` view on both platforms)
→ tap → tune → the system now-playing screen, fed by the metadata RNTP already
pushes (`useNowPlayingInfo`). The shared tune path is `src/car/carTune.ts`
(works from the headless service — a car cold start never mounts the phone UI);
`usePlayer`'s station-change effect *adopts* a car-initiated switch instead of
stopping it (`streamBelongsTo` guard).

- **iOS (CarPlay)** — `react-native-carplay` templates; `plugins/withCarPlay.js`
  generates the scene manifest, `CarSceneDelegate`/`PhoneSceneDelegate` Swift
  files, and the `com.apple.developer.carplay-audio` entitlement on prebuild.
  Test in the **CarPlay Simulator** (Simulator app → **I/O → External Displays
  → CarPlay**) — simulator builds skip provisioning, so this works **before**
  Apple grants the entitlement. **Device builds fail codesigning until the
  grant lands** (apply at <https://developer.apple.com/contact/carplay/>,
  Account Holder, category Audio; then enable CarPlay on the App ID under
  Additional Capabilities and regenerate profiles — EAS can't sync this
  capability). Until then `eas.json` device profiles strip the entitlement via
  `SUBWAVE_NO_CARPLAY_ENTITLEMENT=1`; delete those lines after the grant.
  **SDK-upgrade caveat**: the generated `PhoneSceneDelegate` re-parents the
  AppDelegate's React root into the scene window — re-verify against Expo's
  AppDelegate template on every SDK bump.
- **Android (Android Auto)** — the RNTP fork's Media3 `MediaLibraryService`
  serves the browse tree (`src/car/browseTree.ts`; taps/voice land as
  `Event.RemotePlayId`/`RemotePlaySearch` in `service.ts`);
  `plugins/withAndroidAuto.js` supplies `automotive_app_desc.xml` + the car
  meta-data. Test with the **Desktop Head Unit** (Android Studio; enable Auto
  developer mode → "Unknown sources") or a real head unit.

> ⚠ **Android Auto must stay OFF Google Play.** The earlier manifest-only
> declaration (#444) drew a Play **enforcement** on 20 Jun 2026 — *"Category
> not permitted — media apps that use TTS engine readout for content are not
> permitted at this time"* — and the build was pulled (#477). The AI DJ *is*
> TTS readout, so the now-compliant browse tree does not cure the policy
> objection. The `production` profile therefore sets `SUBWAVE_NO_ANDROID_AUTO=1`
> to strip the declaration from Play-bound builds; dev / `preview` (internal
> APK) / sideloaded builds keep Android Auto working. Revisit the gate only if
> Google's "at this time" policy changes, or to attempt an appeal armed with
> the compliant `MediaLibraryService` implementation.

---

## EAS cloud builds (for distributing to testers)

Use EAS when testers can't build locally — TestFlight (iOS) or a shareable
internal APK (Android). `eas.json` already defines the profiles, and the
project is already linked (`extra.eas.projectId` is set in `app.json`); the only
interactive piece left is **auth**, which must be done by the project owner.

### One-time setup (owner runs these)

```bash
npm i -g eas-cli
eas login                 # your Expo account
cd app                    # project is already linked — `eas init` is only
                          # needed again if the owner/projectId ever changes
```

`eas.json` uses `appVersionSource: remote`, so build/version numbers are managed
on the EAS servers (`production` auto-increments) — you don't hand-edit
`ios.buildNumber` / `android.versionCode`.

### Build profiles (already configured in `eas.json`)

| Profile | Output | Account needs |
|---|---|---|
| `development` | dev client, iOS **simulator** | EAS only |
| `development-device` | dev client, physical device | iOS: Apple Developer ($99/yr) for device provisioning |
| `preview` | internal: Android **APK**, iOS non-simulator | Android: none (EAS-managed keystore). iOS: Apple Developer |
| `production` | store builds, auto-incremented | Apple Developer + Play Console |

### Example: shareable Android APK for testers (no Apple account)

```bash
eas build --profile preview --platform android
# EAS returns a URL; testers download + sideload the APK.
```

### Example: iOS TestFlight

```bash
eas build --profile production --platform ios     # needs Apple Developer
eas submit --profile production --platform ios     # uploads to App Store Connect
```

> **OTA is wired up.** `expo-updates` is installed, `app.json` has the `updates`
> block + `runtimeVersion.policy = "fingerprint"`, and `eas.json` gives `preview`
> and `production` a `channel`. JS-only changes ship over-the-air with
> `eas update --channel <channel>` — no new build. Native changes (deps,
> `patches/`, config plugins, `app.json` native sections) still need a store
> build; the fingerprint runtime version guarantees an OTA can't land on a binary
> with mismatched native code. Full decision table + commands: [`RELEASE.md`](./RELEASE.md).

---

## Known issues / gotchas

- **`patches/react-native-track-player+4.1.2.patch`** is the RNTP new-arch fix
  (2 source files — see "Architecture-critical facts"). It was previously bloated
  to 229 files with accidental Gradle build artifacts; **slimmed to just the 2
  `.kt` source files** (2026-06) and re-verified with a clean `BUILD SUCCESSFUL`.
  Keep it lean — never run `patch-package` after a Gradle build has populated
  `node_modules/react-native-track-player/android/build/`, or it recaptures the
  junk.
- **JDK 21 fails the Android build.** Always `JAVA_HOME=/opt/homebrew/opt/openjdk@17`.
- **`LegacySurfaceTexture is not attached!`** in Android logcat is **noise** from
  the Skia visualizer surface, not a crash.
- **Gradle is pinned to 8.14.3** via `plugins/withGradleVersion.js` — RN's
  bundled Gradle plugins reference an API removed in Gradle 9.
- **`expo run:ios` non-interactively prints "Skipping dev server"** and then
  fails the final deep-link open — the build/install still succeeded; just start
  Metro and open via `localhost` (above).

---

## Validation status (2026-06)

| Check | iOS | Android |
|---|---|---|
| `tsc --noEmit` | ✅ | ✅ |
| Native build | ✅ simulator (new arch ON) | ✅ emulator + APK (new arch ON, JDK 17) |
| RNTP slim patch (2 files) | ✅ live playback | ✅ `BUILD SUCCESSFUL` after slim |
| Install + launch | ✅ | ✅ (emulator install) |
| JS bundle | ✅ 4075 modules | ✅ build path |
| Onboarding → health check | ✅ all 4 probes OK | (same JS; via skill on device) |
| Player + **live audio** | ✅ timer advances | proven on device via skill |
| Runtime theming, cover art, spectrum | ✅ | — |
| Background audio / lock screen | ⏳ device-only — not yet validated | ⏳ device-only |
