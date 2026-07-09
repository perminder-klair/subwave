# SUB/WAVE native app

Native iOS + Android player for [SUB/WAVE](../README.md) — built with Expo + react-native-track-player. Full feature parity with the web player (`../web`), multi-station: enter any SUB/WAVE station's URL, switch between them, with one featured default.

## Stack

- **Expo SDK 56** (RN 0.85, React 19, New Architecture) · **expo-router** (file-based)
- **react-native-track-player** — background audio + lock-screen / CarPlay controls (Android Auto is intentionally not declared — Google Play rejected it under the Auto content policy, #477)
- **NativeWind 4** (Tailwind for RN) — reuses the web's class names + the 7 theme tokens
- **@shopify/react-native-skia** — the 120-bar waveform · sheets are core `<Modal>` (`src/components/ui/Sheet.tsx`)
- **react-native-image-colors** — cover-art ambient wash · **lucide-react-native** — icons

Native modules (track-player, skia, image-colors) ship native code, so **Expo Go won't work** — you must build a dev client.

## Develop

```bash
cd app
npm install                      # .npmrc pins legacy-peer-deps (SDK 56 react/react-dom quirk)

# One-time: build a dev client (needs EAS account; Apple Developer for iOS device)
npm i -g eas-cli && eas login
eas build --profile development --platform ios      # or android (--profile development builds an installable .apk)

# Install the dev client on a device/simulator, then:
npm start                        # expo start --dev-client
```

`npm run typecheck` mirrors the repo lint gate (`tsc --noEmit`). `npx expo-doctor` runs 21 project-health checks.

## Release & updates

Two ways to ship, decided by what a change touches:

- **JS/TS only** (components, hooks, styles, copy, logic) → **OTA** via `expo-updates`: `eas update --channel <preview|production>`. No store round-trip.
- **Native** (a dep add/upgrade, `patches/`, a config plugin, `app.json` native sections) → **new store build**: `eas build --profile production --platform <ios|android>` then `eas submit`.

`runtimeVersion.policy = "fingerprint"` hashes the native inputs (incl. `patches/`), so an OTA can only ever reach a binary with matching native code — editing the RNTP patch automatically rolls the runtime version. `fallbackToCacheTimeout: 0` keeps OTA off the launch critical path (it applies on the next cold start), which matters for a radio app opened in dead zones.

Channels map to build profiles in `eas.json` (`preview` / `production`). Store-submit configs live there too (iOS `ascAppId`; Android `secrets/play-service-account.json`, gitignored). Full runbook + the OTA-vs-binary table: [`docs/RELEASE.md`](docs/RELEASE.md). The manual pre-release device gate: [`docs/QA-CHECKLIST.md`](docs/QA-CHECKLIST.md). Step-by-step store flows are the `subwave-app-ios-release` / `subwave-app-android-release` skills.

## Configure the featured station

The default/featured station is one line in `app.json`:

```json
"extra": { "featuredStation": { "url": "https://radio.getsubwave.com", "name": "SUB/WAVE" } }
```

Listeners can still enter any station URL on first launch and switch between them (stored locally in AsyncStorage). The app talks to `{stationURL}/api/*` and streams `{stationURL}/stream.mp3` (MP3 only — same universal-floor reasoning as the web player; Opus/Ogg is skipped).

## Architecture

The structural difference from the web player: the web bakes its base URL in at build time (`NEXT_PUBLIC_API_URL`). Here the base is resolved at **runtime** from `StationContext` and threaded through `createApi(base)` (`src/lib/api.ts`). Every hook/screen reads `api`/`base` from context.

- `src/config/StationContext.tsx` — active station + recents + switch/forget (the runtime base)
- `src/theme/ThemeContext.tsx` — station theme via NativeWind `vars()`; per-listener override
- `src/audio/player.ts` + `src/hooks/usePlayer.ts` + `service.ts` — the RNTP audio layer (isolated so it's swappable)
- `src/hooks/*` — ports of the web hooks (`useStationFeed`, `useSignal`, `useNowPlayingInfo`, `useCoverColors`, `useSpectrum`)
- `src/player/*` — the player UI (TopBar, CenterStage, Waveform, TransportBar, FreqBand, drawers)
- `src/lib/{types,format,sessionFeed,tagline}.ts` — copied verbatim from `../web/lib` (source of truth noted in each file header)

## Known risks (validate in the device spike — M0)

- **react-native-track-player + New Architecture.** RN 0.85 mandates the New Architecture on **both** platforms (`app.json` no longer carries a `newArchEnabled` flag; a leftover `newArchEnabled=false` in a generated `gradle.properties` is an ignored no-op since RN 0.82). Reanimated 4.3.1 requires it. RNTP 4.1.2 isn't natively new-arch-compatible, so `patches/react-native-track-player+4.1.2.patch` carries the fix (2 source files: a Unit-returning `launch` helper in `MusicModule.kt`, and `currentReactContextCompat()` in `MusicService.kt` — without it Android crashes on the first playback event). Validated: iOS live playback on the simulator + Android `BUILD SUCCESSFUL`. See `docs/TESTING.md` → "Architecture-critical facts". The audio layer is still isolated behind `src/audio/player.ts` + `usePlayer` + `service.ts` should a swap to `expo-audio` ever be needed. (The doctor warning for this package is intentionally excluded in `package.json`.)
- **HTTP-only stations.** iOS App Transport Security blocks plain HTTP. Stations should be HTTPS; `NSAllowsLocalNetworking` is on for LAN dev against a local controller. For a non-HTTPS dev controller over Wi-Fi, add a temporary ATS exception in `app.json` → `ios.infoPlist`.
- **Background-audio review.** iOS declares `UIBackgroundModes: ["audio"]` (legitimate — live radio). Android uses RNTP's foreground service (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`).

## Verification done

- `tsc --noEmit` clean · `expo-doctor` 21/21 · `expo export` bundles cleanly for both iOS and Android.
- **iOS simulator (2026-06):** `expo run:ios` builds clean (new arch ON), installs, bundles 4075 modules, and runs the full flow — onboarding → health check (all 4 probes OK vs live getsubwave.com) → player with **live audio** (NOW PLAYING timer advances), runtime theming, cover art, Skia spectrum. RNTP works under new arch on iOS.
- **Android emulator (2026-06):** `expo run:android` (JDK 17, new arch OFF) `BUILD SUCCESSFUL`, debug APK installs. Physical-device run is proven via the `subwave-app-android` skill.
- Still device-only / not yet validated: background audio + lock-screen metadata + persona-avatar swap (needs a physical device).
- **How to run/test it all:** see [`docs/TESTING.md`](docs/TESTING.md) (local sim/emulator, physical devices, EAS cloud builds, known gotchas).
