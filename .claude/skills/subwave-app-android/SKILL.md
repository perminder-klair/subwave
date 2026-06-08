---
name: subwave-app-android
description: Get the SUB/WAVE mobile app (the Expo project in `app/`) onto a physical Android phone and confirm it runs. Use this skill whenever the user wants to install, reinstall, sideload, run, or load the app on a connected Android device or "their pixel" — by any phrasing. Covers both modes: (1) dev/live — run over USB/cable with Metro so code edits hot-reload on the phone ("run it on my phone", "see my edits live", "test my changes with hot reload", "point it at the metro server"); and (2) standalone/release — build a self-contained APK that runs unplugged over WiFi/cellular ("production build", "release apk", "test it in the wild", "hand off the phone"). Also handles the "app crashed / I deleted it, reinstall fresh" case. Manages adb, the Metro reverse tunnel, the dev-client deep link, and the JDK-17 release build (Android Studio's bundled JDK 21 fails the build). Always screenshots to verify. Do NOT use this for the Docker radio stack (controller/liquidsoap/web) — that's `subwave-control` / `subwave-deploy`. Android phone app only (no iOS).
---

# SUB/WAVE Android app runner

Get the SUB/WAVE Expo app onto a connected Android phone and confirm it's
running. Two paths, picked by intent:

- **USB / dev** — the dev-client app loads JS live from Metro on this machine
  over an `adb reverse` tunnel. Hot reload, instant edits, but the phone must
  stay tethered and Metro must keep running.
- **Embedded / release** — a release APK with the JS bundle baked in. Build
  once, install, unplug. Runs in the wild over WiFi/cellular with no Metro and
  no cable. This is "production mode" / "see how it feels for real".

If the user is iterating on code, they want **dev**. If they want to live with
the app, hand it to someone, or judge the real feel, they want **release**.
When it's genuinely ambiguous, ask.

## Paths and facts you need

This skill is checked into the SUB/WAVE repo. Derive the repo root once — don't
hardcode it:

```bash
REPO=$(git -C "<this skill's base directory>" rev-parse --show-toplevel)
APP="$REPO/app"   # the Expo project
```

`<this skill's base directory>` is the absolute path shown as "Base directory
for this skill" when the skill loads. Shell state does **not** persist between
command blocks, so re-derive `$REPO`/`$APP` (or substitute their values) each
time.

Fixed facts about the app:

| Thing | Value |
|---|---|
| App package id | `com.getsubwave.app` |
| URL scheme | `subwave` |
| Metro port | `8081` |
| Debug (dev-client) APK | `$APP/android/app/build/outputs/apk/debug/app-debug.apk` |
| Release APK | `$APP/android/app/build/outputs/apk/release/app-release.apk` |
| Default station | public `getsubwave.com` — **no local backend needed** |

**adb** lives in the Android SDK. Resolve it once; don't assume it's on `PATH`:

```bash
ADB=$(command -v adb || echo "$HOME/Library/Android/sdk/platform-tools/adb")
"$ADB" devices    # expect a line like: <serial>  device
```

If `adb devices` shows nothing under "List of devices attached", the phone
isn't connected/authorized — stop and tell the user to plug in and accept the
USB-debugging prompt. Everything below needs at least one device in `device`
state.

## Why a screenshot, every time

Android happily reports a process as "running" while the JS layer is showing a
red error screen, a white blank, or a stale cached bundle. The only honest
confirmation is to look. After any launch, take a screenshot and actually read
it:

```bash
OUT=/tmp/subwave-screen.png
"$ADB" exec-out screencap -p > "$OUT"
```

Then view `$OUT`. You should see the player (now-playing, album art, the
visualizer) or another real app screen — not a redbox or blank. Note: the
phone has no `curl`, so don't try to probe the app over the network from the
device; the screenshot is the check.

---

## Path A — USB / dev (live JS from Metro)

Goal: dev-client app on the phone rendering JS served by Metro on this machine,
hot-reloading on edits.

### A1 — Ensure the dev-client app is installed

```bash
"$ADB" shell pm list packages | grep -q com.getsubwave.app && echo INSTALLED || echo MISSING
```

If MISSING, install the prebuilt debug APK (fast — no rebuild):

```bash
"$ADB" install -r "$APP/android/app/build/outputs/apk/debug/app-debug.apk"
```

If that APK doesn't exist, build it (slower, needs JDK 17 — see the build notes
in Path B): `cd "$APP" && JAVA_HOME=/opt/homebrew/opt/openjdk@17 npx expo run:android`.
`expo run:android` also installs and starts Metro, so if you go that route you
can skip the rest of Path A.

> If the device currently has the **release** build installed, its signature
> differs from the debug build and `adb install -r` will fail with
> `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstall first:
> `"$ADB" uninstall com.getsubwave.app`.

### A2 — Open the USB reverse tunnel

This maps the phone's `localhost:8081` back to Metro on this machine, so it
works over the cable with no WiFi/IP juggling:

```bash
"$ADB" reverse tcp:8081 tcp:8081
"$ADB" reverse --list   # expect: ... tcp:8081 tcp:8081
```

The tunnel drops when the phone is unplugged/reconnected — re-run this after any
replug.

### A3 — Make sure Metro is running

Metro may already be up (e.g. from another terminal). Check before starting a
second one — a duplicate just exits on the port conflict, which is harmless but
noisy:

```bash
curl -s -m5 http://localhost:8081/status   # expect: packager-status:running
```

If it's not running, start it in the background from the app dir:

```bash
cd "$APP" && npx expo start --dev-client --port 8081
```

Run this as a background task — Metro is a long-running foreground process.
Give it a few seconds, then re-check `/status`.

### A4 — Launch the app pointed at Metro

The dev client opens a specific bundle via its deep link. With the reverse
tunnel up, the URL is plain `localhost:8081`:

```bash
"$ADB" shell am start -a android.intent.action.VIEW \
  -d "subwave://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" \
  com.getsubwave.app
```

(`am start` may print `Warning: Activity not started, its current task has been
brought to the front` — that's fine, it means the app was already foregrounded.)

### A5 — Verify

```bash
"$ADB" shell pidof com.getsubwave.app          # non-empty pid
"$ADB" exec-out screencap -p > /tmp/subwave-screen.png
```

View the screenshot. Player UI = success. A redbox usually means a Metro/bundle
error — read Metro's output (the background task log, or `$APP/.expo/dev/logs/start.log`)
for the stack trace.

---

## Path B — Embedded / release (standalone, no cable)

Goal: a self-contained APK the user can run unplugged. The JS bundle is built
into the APK, so there's no Metro and no tunnel.

### B1 — Build the release APK (the JDK-17 gotcha)

The single most important fact: **build with JDK 17.** Android Studio's bundled
JBR is JDK **21**, and this project pins Java compatibility to 17. Building with
21 fails with a Kotlin/Java JVM-target mismatch:

```
Inconsistent JVM-target compatibility ... 'compileReleaseJavaWithJavac' (17)
and 'compileReleaseKotlin' (21).
```

Use Homebrew's `openjdk@17` (install with `brew install openjdk@17` if absent):

```bash
cd "$APP/android"
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH="$JAVA_HOME/bin:$PATH"
java -version            # confirm 17.x before building
./gradlew assembleRelease
```

This takes a few minutes on a clean build, ~1 min incremental. Run it as a
background task and wait for `BUILD SUCCESSFUL`. `gradlew` won't find Java on
its own in a non-interactive shell — always set `JAVA_HOME` in the same block.

**Skip the rebuild if nothing changed.** The release APK only needs rebuilding
when app JS/config changed since it was last built. Check first:

```bash
APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] && find "$APP/src" "$APP/app.json" "$APP/index.ts" -newer "$APK" -type f 2>/dev/null | head
```

If that prints nothing and the APK exists, it's current — install it as-is. If
it prints changed files, rebuild.

### B2 — Install and prove it's standalone

The release APK is signed with a different key than the dev build, so remove any
existing install first. Removing the reverse tunnel before launch *proves* the
app isn't secretly leaning on Metro:

```bash
"$ADB" uninstall com.getsubwave.app 2>/dev/null   # ok if it wasn't installed
"$ADB" reverse --remove-all                        # drop any Metro tunnel
"$ADB" install "$APP/android/app/build/outputs/apk/release/app-release.apk"
```

### B3 — Launch like a normal installed app

No deep link — just start it the way the launcher would:

```bash
"$ADB" shell monkey -p com.getsubwave.app -c android.intent.category.LAUNCHER 1
```

### B4 — Verify

```bash
"$ADB" shell pidof com.getsubwave.app
"$ADB" logcat -d -t 200 | grep -iE "FATAL|AndroidRuntime" | tail   # expect empty
"$ADB" exec-out screencap -p > /tmp/subwave-screen.png
```

View the screenshot. Then tell the user they can unplug — the app runs over
WiFi/cellular on its own.

---

## Known issues / things that bite

- **JDK 21 fails the release build.** Covered above. Always `JAVA_HOME` to
  `openjdk@17` for `assembleRelease`. (Dev builds via `expo run:android` are
  also happier on 17.)
- **Release is signed with the debug keystore.** `android/app/build.gradle`
  points the `release` build type at `signingConfigs.debug`. Fine for sideloading
  and judging the real feel; **not** acceptable for Play Store distribution —
  that needs a real release keystore. Mention this if the user talks about
  shipping/publishing.
- **`react-native-track-player` + New Architecture crash.** If `newArchEnabled`
  is ever flipped to `true` (`app.json` and `android/gradle.properties` both
  currently `false`), the app crashes on playback events with
  `You should not use ReactNativeHost directly in the New Architecture` from
  `MusicService`. Keep new arch off until the track-player version supports it.
- **`LegacySurfaceTexture is not attached!` in logcat is noise.** It comes from
  the Skia visualizer's graphics surface, not a crash. Ignore it.
- **No backend required.** The app defaults to the public `getsubwave.com`
  station, so it plays without the local Docker stack running.

## Quick reference

| Want | Path |
|---|---|
| Edit code and see it live on the phone | A (USB/dev) |
| Reinstall the dev app after deleting it | A1 (`adb install -r` the debug APK) |
| Run unplugged / judge real feel / hand off the phone | B (release) |
| "Production build" / "in the wild" | B (release) |
| Rebuild release after JS changes | B1 (JDK 17 + `assembleRelease`) |
