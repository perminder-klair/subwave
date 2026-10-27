# Testing the SUB/WAVE app on iOS and Android

How to build, run, and test the Expo app on simulators/emulators, physical
devices, and via EAS cloud builds. Read the **Architecture-critical facts**
section first — one wrong toggle and playback crashes on launch.

---

## Architecture-critical facts (read before changing native config)

### Both platforms run the New Architecture — it's mandatory in RN 0.86

RN 0.82+ **removed the ability to opt out** of the New Architecture. Both
platforms run it ON, and this is required (Reanimated 4.5.1 only works under new
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
whose New Architecture half is two source edits (the rest of the patch is the
progress and iOS metadata fixes described below):

- `MusicModule.kt` — routes async `@ReactMethod`s through a Unit-returning
  `launch` helper (TurboModule interop requires void-returning async methods).
- `MusicService.kt` — `currentReactContextCompat()` obtains the `ReactContext`
  from `ReactHost` (new arch) instead of the `ReactNativeHost.reactInstanceManager`
  path that throws, with an old-arch fallback.

> Do not delete this patch. Without it, Android RNTP crashes on the first
> playback event. iOS (SwiftAudioEx path) is unaffected by the crash but the
> patch is harmless there. Validated: Android `BUILD SUCCESSFUL` and iOS live
> playback both with the patch applied.

The patch also fixes live song progress (#857). RNTP 4.1.2's Android bridge
ignores `elapsedTime`; KotlinAudio normally reports ExoPlayer's continuous
stream position. `NowPlayingProgress` wraps only the session-facing player,
retaining the existing remote-control interception. KotlinAudio 2.1.0's private
`NotificationManager.player` and `mediaSessionConnector` fields are pinned by
consumer ProGuard rules. Recheck this adapter when upgrading either dependency.
The iOS metadata patch clears omitted song-clock fields and preserves artwork
on progress-only refreshes, while retaining `isLiveStream` and the LIVE controls.
These changes require a new binary, not an OTA update.

For a device smoke test, play a track with a known duration and inspect
`adb shell dumpsys media_session`: its duration should be the song's duration
in milliseconds, and position should match the app's elapsed time, including
the advertised listener buffer. Check that artwork remains visible during
progress refreshes and changes with the track/persona. During DJ speech and
on a track with no duration, the previous song's progress must disappear.
Repeat after a track change, screen lock, reconnect, and tune-out/tune-in.
Verify a release build too, so the reflection keep rules are exercised.
On iOS, confirm the LIVE controls, artwork, and Live Activity still work;
Cast should still tear down the local session. Bluetooth display of artwork
and progress must also be checked in the car.

### The app uses the UIScene life cycle

An app built with the **iOS 27 SDK** (Xcode 27) that has no scene manifest is
killed at launch on iOS 27, in
`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. The SDK 57
template still starts React Native from the app delegate, so `expo-build-properties`
`ios.enableSceneSupport` (Expo's own SDK 57 opt-in, expo 57.0.23+) does what the
SDK 58 template does: a scene manifest naming Expo's `ExpoAppSceneDelegate` (it
creates the window, starts React Native and forwards URL and lifecycle events to
the app delegate), and an app delegate that only creates the factory. Drop the
option with the SDK 58 upgrade; it warns and does nothing there.

EAS builds SDK 57 with **Xcode 26.6** (the `sdk-57` image) unless `eas.json`
names another, so a default store build has none of the iOS 27-only code
(`AudioSchemaIntents.swift`). Shipping that needs an Xcode 27 image
(`macos-tahoe-26.6-xcode-27.1`, also `latest`).

### Other load-bearing facts

- **Expo Go does not work** — native modules (RNTP, Skia, Reanimated worklets)
  ship compiled code. You must build a **dev client**.
- **MP3 is the default** (`{base}/stream.mp3`). The SIGNAL picker offers AAC on
  both platforms and Opus/FLAC on Android when the station advertises the mount.
  iOS cannot demux Ogg. Cast always uses MP3.
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
- **The Android Cast SDK is pinned** (`androidPlayServicesCastFrameworkVersion`
  on the `react-native-google-cast` plugin in `app.json`). The library defaults
  to `play-services-cast-framework:+`, so every build takes Google's newest, and
  23.0.0 pulls `androidx.mediarouter:mediarouter:1.9.0-beta01`, which needs
  compileSdk 37 and AGP 9.1: `:app:checkReleaseAarMetadata` fails the build.
  Raise the pin alongside an Expo SDK upgrade that moves compileSdk/AGP, and
  ship it in a binary for both platforms, because the plugin options are in the
  shared app config, so the pin is in the iOS fingerprint too.

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

On Android, `PlaybackService` must **never resolve**. It runs as RNTP's
headless JS task, and React Native fires JS timers behind a paused activity only
while a headless task is active. Every background poll is a timer, including the
`/now-playing` poll that feeds lock-screen and Bluetooth metadata. RN 0.85 never
registered `HeadlessJsTaskSupport` under bridgeless, so the task never finished.
RN 0.86 (Expo SDK 57) registers it, and app 1.6.0 shipped with metadata frozen
behind the lock screen until the phone was unlocked. Device check: tune in, lock
the phone, and wait through a track change. The notification (or a Bluetooth
head unit) should show the new title without unlocking.

### CarPlay — Now-Playing in the car (iOS only)

Scope is **Tier 1**: control the *already-playing* stream from the dash (metadata,
artwork, play/pause/stop). There is **no launchable in-car app icon** — start the
stream in the phone app first, then connect the car. RNTP feeds the iOS surface
(`MPNowPlayingInfoCenter`), so CarPlay needs **no extra app-side wiring**.

- **iOS** — run on a device, or use the **CarPlay Simulator** (Simulator app →
  **I/O → External Displays → CarPlay**). Start the stream, open the CarPlay
  screen → SUB/WAVE shows under **Now Playing** with title/artist/album + artwork;
  Play/Pause work; no scrubber (the `isLiveStream` track hides it). On iOS 26+
  the Live Activity's `.small` card also appears on the CarPlay Dashboard.

> **Android Auto is intentionally not declared.** The earlier
> `plugins/withAndroidAuto.js` declaration (#444) was **rejected by Google Play**
> (20 Jun 2026) under the Auto App Quality Guidelines: media apps that use a TTS
> engine to read out content aren't permitted on Android Auto, which is exactly
> what SUB/WAVE's AI DJ does. The declaration was removed so the Android build
> stays Play-compliant. iOS CarPlay is unaffected (separate `MPNowPlayingInfoCenter`
> path, no manifest declaration). Revisit only if Google's policy changes **and**
> a compliant `MediaBrowserService` browse tree is added.

### Live Activity — Lock Screen, Dynamic Island, Apple Watch (iOS only)

The on-air card. A **widget extension target** (`targets/live-activity/`, wired by
`@bacons/apple-targets`) plus a **local Expo module** (`modules/live-activity/`)
that drives ActivityKit, started and stopped by `src/hooks/useLiveActivity.ts`.

The reason it exists is the **Apple Watch**: React Native does not run on watchOS,
so a real watch app is a second, Swift-only codebase. iOS 18+ mirrors an iPhone
Live Activity into the **watch Smart Stack** for free, and iOS 26 puts it on the
**CarPlay Dashboard** too, with no CarPlay entitlement. One target, no watchOS
project, no second release path.

Both of those surfaces draw the **`.small` activity family** (`SmallView`), not
the lock-screen view. Without the opt-in they fall back to the Dynamic Island's
compact views, an 18pt cover and a clock. The opt-in,
`supplementalActivityFamilies([.small])`, is iOS 18 API on a 17.0 target, so it
lives on its own widget (`SubwaveLiveActivityWithSmall`) and `index.swift`
registers exactly one of the two. CarPlay renders Live Activities
non-interactive, which is why `SmallView` has no heart.

**The floor is iOS 17** (the widget target builds at 17.0 for the interactive
heart). `isLiveActivitySupported()` is the only gate; below it the app behaves
exactly as it did before and the OS Now Playing card is untouched.

What is easy to get wrong:

- **`SubwaveLiveAttributes.swift` is compiled twice** — once into the widget, once
  into the Expo module — because the two are different Swift modules and neither
  can import the other. ActivityKit matches an activity to its widget by the type
  NAME, not its module, which is why two copies work; it is the same split Apple's
  own app/extension template has. `npm test` fails if they drift. A mismatched
  `ContentState` does **not** fail the build — the card just silently stops
  rendering on device, which is a miserable thing to debug.
- **`_shared/` is load-bearing.** `LikeTrackIntent.swift` must compile into the
  **main app target** as well as the widget — that is what `_shared/` means to
  `@bacons/apple-targets`, and it is what makes the heart work at all, because a
  `LiveActivityIntent` runs in the app's process (waking it if suspended). If the
  intent ends up in the widget target only, the button does nothing. Confirm the
  generated project lists it under the app target after a prebuild.
- **The widget gets no network turn.** Cover art is downloaded by the app into the
  `group.com.getsubwave.app` container and handed to the widget as a *filename*.
  Miss the App Group entitlement on either side and every cover silently falls
  back to the drawn disc mark.
- **Version lockstep.** App Store Connect rejects an upload whose extension
  `CFBundleShortVersionString` differs from the app's. `eas.json` uses
  `autoIncrement` with remote `appVersionSource`; check the widget target picks up
  the same version on the first production build rather than at submit time.
- **The heart fills on the next feed poll (≤5s), not instantly.** Deliberate: the
  intent hands the tap back to JS so the like goes out through the app's own
  `StationApi` — no station URL and no SecureStore credential in an app extension —
  and the controller rejects a stale tap, so a heart that fills and then un-fills
  would be worse than one that fills a beat late.

Iterate on it like any other native change: `npx expo prebuild -p ios --clean`,
then `xed ios` and pick the **SUB/WAVE Live** scheme — `SubwaveLiveActivity.swift`
carries a `#Preview` so the layout can be worked on without a device. It cannot
run in Expo Go, and the Dynamic Island needs a Pro-class device or the matching
simulator.

### App Intents — Siri, Shortcuts, Spotlight (iOS only)

"Tune in" and "Tune out" are `AudioPlaybackIntent`s with Siri phrases
("Tune in to SUB/WAVE", "Play SUB/WAVE"). The system runs an audio intent in the
**app's** process without bringing it forward, launching it into the background
when it is not running. iOS 18 adds the **tune control** (`TuneControl.swift`),
a toggle for Control Center, the Lock Screen and the Action button, driven by
`ToggleTuneIntent` through the same bridge. **Request a song** ("Request a song
on SUB/WAVE") has Siri ask what to play, sends it through the request drawer's
own `POST /request` and polling, and reads back the DJ's answer. It waits up to
10 s for the match, then says the request is in. **What's playing** and **Like
this song** both mean the track the listener is hearing: while the app is
playing, that is the previous track for the stream buffer's length after a
change (`src/lib/heard-track.ts`, the rule `useStationFeed` promotes tracks by).
The like goes through `POST /like`, which refuses a song that has ended, and
the in-app heart and the Live Activity fill straight away (`like-events.ts`).
The Live Activity's own heart is `LikeTrackIntent`, hidden from Shortcuts so
there is one "like" action there.

**Saved stations** reach Siri, Shortcuts and Spotlight (iOS 18) as entities
(`StationEntities.swift`): "Play Night Shift on SUB/WAVE", Tune in's Station
parameter, and a Spotlight result that opens the app tuned to it. Swift cannot
read the station store, so `StationContext` mirrors names and credential-free
bases into the App Group (`setStations`), and the module then calls the
app-target `SubwaveStationIndex.reindex` by class name to refresh Spotlight and
the Siri phrases. A switch away from the active station is JS
(`src/intents/tune.ts`): it writes the store, stops the old stream, starts the
new one, and only then tells `StationContext`, so `usePlayer` finds the
playing stream already belongs to the new base (`streamBelongsTo`) and keeps
it. On iOS 27, `AudioSchemaIntents.swift` exposes the same stations to Siri's
audio search.

The intents are thin. Each hands its action to JS and waits for the answer:

- `targets/live-activity/_shared/`: the intents, and the Siri phrases in
  `SubwaveShortcuts.swift`.
- `targets/live-activity/_shared/SubwaveIntentBridge.swift`: posts the request,
  re-posts until acknowledged, waits for the reply.
- `modules/app-intents/`: the Expo module that acknowledges, holds requests
  until JS subscribes, and posts JS's reply back.
- `src/intents/`: the JS that does the work, registered from `index.ts` beside
  the playback service, not from a screen.

What is easy to get wrong:

- **The two Swift halves meet on NotificationCenter names, matched by string.**
  `_shared/` also compiles into the widget extension, which cannot import the
  module's pod. Change a name on one side, change it on the other.
- **The Siri phrases must not compile into the widget.** A second
  `AppShortcutsProvider` in the extension made Shortcuts fail a shortcut with a
  parameter to ask for ("Couldn't find AppShortcutsProvider"), though Tune in
  still ran. `SubwaveShortcuts.swift` and `RequestSongIntent.swift` sit inside
  `#if canImport(ExpoModulesCore)`, true only in the app target, because only it
  links the Expo pods. Check the widget's `Metadata.appintents` lists no
  shortcuts after a change there.
- **Intents must compile into the app target**, which is what `_shared/` does.
  App Intents metadata is extracted per target, and an intent the system cannot
  find in the app does not exist to Siri or Shortcuts.
- **A cold start depends on JS booting in the background.** The app uses the
  UIScene life cycle (`ios.enableSceneSupport`), so React Native starts
  when a scene connects. iOS connects one for an intent launch even though the
  app is never shown, so JS boots (checked on iOS 18.5 and 27). If an intent
  ever times out cold, look there first.
- **`usePlayer` must adopt audio it did not start.** A cold tune-in can reach
  Playing before any screen mounts, so the hook reads the player's state on
  mount. A tune-out goes through `externalTuneOut()`, or the hook reads the
  Stopped event as a dead stream and reconnects.
- **ActivityKit refuses a background app.** `liveactivitiesd` logs "Requester
  is not foreground" and the card never appears, though the audio plays.
  Inside a `LiveActivityIntent`'s run the request is allowed, which is why
  `TuneInIntent` is one and `tune.ts` holds its answer (up to 2 s) until the
  card has been asked for. `useLiveActivity` also retries when the app comes
  forward, for a tune-in that missed the window.
- **The control cannot ask the player.** It reads an on-air flag in the App
  Group that `usePlayer` writes through `setOnAir`, which also reloads the
  control. An app killed mid-song leaves the flag on until the next tap or
  launch. The flag key and the control kind are matched by string between
  `TuneControl.swift` and the app-intents module.
- **A control never resolves parameters.** `ToggleTuneIntent` is built with
  `init(turningOn:)`; an instance with `value` unset installs and renders, then
  does nothing when tapped.

Test it cold, in a **Release** build: a Debug dev client loads its bundle from
Metro and the dev launcher, which a background launch does not exercise the way
the shipped app does. Kill the app, run **Tune in** from the Shortcuts app, and
confirm audio starts with the app still in the background; then open the app
and check the transport shows it as on air.

Test **Request a song** and **Like this song** against a local stand-in, never
a live station: a test request really queues and the DJ may announce it, and a
like stars the song in the station's Navidrome. Any server answering
`/api/health`, `POST /api/request`, `GET /api/request/:id`, `/api/now-playing`,
`/api/state` and `POST /api/like` will do; add it in onboarding as
`http://localhost:<port>`. **What's playing** only reads, so a live station is
fine, and the place to check the lag: tune in, wait for `/api/now-playing` to
change, and ask at once; it should name the previous track. Keep test files
out of `ios/build/`, which `expo prebuild` wipes.


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

- **`patches/react-native-track-player+4.1.2.patch`** contains the RNTP new-arch
  and media-session progress fixes (see "Architecture-critical facts"). It was previously bloated
  to 229 files with accidental Gradle build artifacts; slimmed in 2026-06 and
  re-verified with a clean `BUILD SUCCESSFUL` before the progress fix was added.
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
| RNTP New Architecture patch | ✅ live playback | ✅ `BUILD SUCCESSFUL` after slim |
| Install + launch | ✅ | ✅ (emulator install) |
| JS bundle | ✅ 4075 modules | ✅ build path |
| Onboarding → health check | ✅ all 4 probes OK | (same JS; via skill on device) |
| Player + **live audio** | ✅ timer advances | proven on device via skill |
| Runtime theming, cover art, spectrum | ✅ | — |
| Background audio / lock screen | ⏳ device-only — not yet validated | ⏳ device-only |
