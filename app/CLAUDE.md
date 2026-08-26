# CLAUDE.md — `app/` (native)

Loaded when working under `app/`. Station-wide architecture lives in the root `CLAUDE.md`.

### Native app (`app/`)

A separate **Expo SDK 56 / React Native** project (own `package.json`, `node_modules`, `eas.json`) — the native iOS + Android player. It ports the web player's hooks/UI to RN + NativeWind, with the same listener experience (now-playing, booth, timeline, requests, schedule, themes, a Skia visualiser). Background audio + lock-screen / CarPlay / Android Auto controls come from **`react-native-track-player`** (wrapped in `src/audio/player.ts` so it's swappable). Like the web player, it's a player for *any* station: the base URL is fully runtime (`StationContext` → `createApi(baseUrl)`), defaulting to the public station, and listeners can add stations by address. Saved station URLs are always credential-free; optional HTTP Basic Auth credentials live in Expo SecureStore and are reconstructed only in the live API client, with an explicit stream header for AVPlayer. Stream defaults to the MP3 floor (`/stream.mp3`); listeners can pick the optional Opus/FLAC/AAC mounts per station via the back panel's SIGNAL row (`lib/streamFormat.ts` gates the choice on the `/now-playing` `stream` flags AND platform decodability — iOS AVPlayer can't demux Ogg, so Opus/FLAC are Android-only; Cast stays MP3). `service.ts` wires remote Play/Pause/Stop but **not skip** (shared live stream).

Architecture-critical and easy to break — read [`app/docs/TESTING.md`](app/docs/TESTING.md) before touching native config:

- **New Architecture is mandatory** (RN 0.85 ignores `newArchEnabled=false`). Reanimated 4 requires it. RNTP 4.1.2 isn't natively new-arch-compatible, so `app/patches/react-native-track-player+4.1.2.patch` carries the fix (2 source files); without it Android crashes on the first playback event.
- **The Live Activity is native, so OTA can't reach it.** The on-air card (Lock
  Screen, Dynamic Island, and — the point — the **Apple Watch Smart Stack**, which
  iOS 18+ mirrors it into for free) is a widget extension in `targets/live-activity/`
  plus a local Expo module in `modules/live-activity/`, driven by
  `src/hooks/useLiveActivity.ts`. React Native does not run on watchOS, so this is
  the wrist without a second codebase (a real watch app is #1488). Its SwiftUI ships in the binary: an
  `expo-updates` OTA changes the hook, never the card. `SubwaveLiveAttributes.swift`
  is compiled into both targets and `npm test` fails if the copies drift — a
  mismatch silently stops the card rendering rather than failing the build. Full
  rules in [`app/docs/TESTING.md`](docs/TESTING.md).
- **`ios/` and `android/` are gitignored** (Continuous Native Generation) — regenerated from `app.json` + `assets/` by `expo prebuild` / EAS. The source of truth for icons/splash is `assets/` (disc-mark branding) + `app.json`.

Distribution is **EAS cloud builds** → iOS TestFlight + Android internal-distribution link (project `@pinku1/subwave`, bundle `com.getsubwave.app`). The repeat-release workflow lives in the `subwave-app-ios-release` and `subwave-app-android-release` skills; getting it onto a physical Android phone over USB is `subwave-app-android`. See `app/README.md`.
