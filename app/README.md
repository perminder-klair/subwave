# SUB/WAVE native app

Native iOS + Android player for [SUB/WAVE](../README.md) — built with Expo + react-native-track-player. Full feature parity with the web player (`../web`), multi-station: enter any SUB/WAVE station's URL, switch between them, with one featured default.

## Stack

- **Expo SDK 56** (RN 0.85, React 19, New Architecture) · **expo-router** (file-based)
- **react-native-track-player** — background audio + lock-screen / CarPlay / Android Auto controls
- **NativeWind 4** (Tailwind for RN) — reuses the web's class names + the 7 theme tokens
- **@shopify/react-native-skia** — the 120-bar waveform · **@gorhom/bottom-sheet** — drawers
- **react-native-image-colors** — cover-art ambient wash · **lucide-react-native** — icons

Native modules (track-player, skia, image-colors, bottom-sheet) ship native code, so **Expo Go won't work** — you must build a dev client.

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
- `src/player/*` — the player UI (TopBar, CenterStage, Waveform, TransportBar, DotRail, drawers)
- `src/lib/{types,format,sessionFeed,tagline}.ts` — copied verbatim from `../web/lib` (source of truth noted in each file header)

## Known risks (validate in the device spike — M0)

- **react-native-track-player + New Architecture.** SDK 56 mandates the New Architecture; RNTP 4.1.x is not *officially* declared New-Arch-compatible (it runs through the RN interop layer). This is the single biggest thing to verify on a real device build. The audio layer is deliberately isolated behind `src/audio/player.ts` + `usePlayer` — if RNTP misbehaves under New Arch, swapping to `expo-audio` touches only those two files + `service.ts`. (The doctor warning for this package is intentionally excluded in `package.json`.)
- **HTTP-only stations.** iOS App Transport Security blocks plain HTTP. Stations should be HTTPS; `NSAllowsLocalNetworking` is on for LAN dev against a local controller. For a non-HTTPS dev controller over Wi-Fi, add a temporary ATS exception in `app.json` → `ios.infoPlist`.
- **Background-audio review.** iOS declares `UIBackgroundModes: ["audio"]` (legitimate — live radio). Android uses RNTP's foreground service (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`).

## Verification done

- `tsc --noEmit` clean · `expo-doctor` 21/21 · `expo export` bundles cleanly for both iOS and Android.
- Not yet validated (needs a device build + a live station): background audio, lock-screen metadata + persona-avatar swap, the RNTP/New-Arch question above.
