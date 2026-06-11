# Production Readiness Plan — iOS + Android Store Release

Status of the app today: functionally complete (~85% production-ready), validated on simulator/emulator, distributed via TestFlight + EAS internal Android APK link. This document is the plan to take it to **public App Store + Google Play release**.

Decisions baked into this plan: both stores public · add **expo-updates (OTA)** · **no crash reporting, no analytics** (matches the "no trackers" privacy posture) · **manual QA checklist** (no automated test framework).

The audit found the gaps cluster into five areas:

1. **Resilience UX** — no offline/connecting banner, no root error boundary, lock-screen resume likely replays a stale buffer instead of the live edge.
2. **OTA** — expo-updates not wired; every JS fix currently needs a store build.
3. **Google Play track** — never set up: no submit config in `eas.json`, no Play Console account.
4. **Verification items** — iOS privacy manifest, `INTERNET` permission (likely auto-added by Expo prebuild — verify, don't blindly change).
5. **Docs/QA** — no release runbook, no device QA checklist.

A privacy policy already exists at `web/app/privacy/page.tsx` ("no account, no analytics, no trackers") — no new page needed, just verify it's live at `https://www.getsubwave.com/privacy`.

---

## Phase A — App hardening (code)

### A1. Offline / connecting banner

Cold start with no network, or a stream death, currently shows an idle player with zero feedback. `useStationFeed` swallows fetch errors, so this needs a device-level connectivity signal — not more `useSignal` plumbing (it only probes while tuned in).

- **Create `src/hooks/useConnectivity.ts`** — thin `NetInfo.addEventListener` wrapper returning `{ isConnected, type }`. Install via `npx expo install @react-native-community/netinfo` (SDK-pinned; no config plugin needed; `ACCESS_NETWORK_STATE` auto-added).
- **Create `src/player/ConnectionBanner.tsx`** — one-line strip in the existing console aesthetic (mono 10px, `borderColor: colors.ink`, like `TransportBar.tsx`). States:

  | Condition | Banner |
  |---|---|
  | `isConnected === false` (NetInfo) | `NO CONNECTION` |
  | `streamOnline === false` (useStationFeed) | `STATION OFF AIR` |
  | tuned in + `status === 'connecting'` (usePlayer) | `CONNECTING…` |

  Renders `null` when healthy; simple opacity animation (no Reanimated needed).
- **Modify `src/player/PlayerScreen.tsx`** — derive banner state, mount between `<TopBar/>` and `<FreqBand/>` so it's visible on all five pager pages.
- **Modify `src/hooks/usePlayer.ts`** — proactive reconnect: on connectivity `false → true` while tuned in and not playing, call `reconnect()` immediately instead of waiting up to 6s for the watchdog (~10 lines; don't touch the watchdog constants).

### A2. Root error boundary

- **Modify `src/app/_layout.tsx`** — add expo-router's named `export function ErrorBoundary({ error, retry })`. Inside, `SplashScreen.hideAsync()` in an effect (so a crash during `SplashGate` doesn't strand the splash) + render a minimal retry screen.
- **Create `src/components/ErrorScreen.tsx`** — presentational piece with a hardcoded dark `#100e0c` palette (ThemeContext may be the thing that crashed).
- Known limitation: an error thrown by the root layout itself falls to expo-router's default handler. Acceptable.

### A3. Lock-screen resume → live edge (verify first)

`service.ts` `RemotePlay` calls bare `TrackPlayer.play()` — after a long pause this likely resumes a stale buffer, not the live stream.

- **Verify on device first**: pause from lock screen, wait 60s, resume.
- If confirmed: **modify `src/audio/player.ts`** (module-level `lastLiveMeta` + getter) and **`service.ts`** (`RemotePlay` → re-load with a fresh cache-buster via `loadAndPlay(lastLiveMeta)`; try/catch everything — headless context; fall back to plain `play()`). This is the riskiest change in Phase A — gate on the Phase E device checklist; ship without it rather than block.
- Do **not** preemptively add `AudioBecomingNoisy`/duck handlers — `autoHandleInterruptions: true` is already set and RNTP handles becoming-noisy internally. The QA checklist validates this; add handlers only if QA fails.

### A4. Permissions + iOS privacy manifest (verify, change only if a real gap)

After `npm install` in `app/`:

1. `npx expo config --type introspect` → confirm `android.permission.INTERNET` is auto-added by prebuild (expected: yes → **no `app.json` change**).
2. Confirm AsyncStorage ships its own `PrivacyInfo.xcprivacy` (≥1.23 does) and SDK 56 prebuild aggregates library manifests. Only if missing, add `ios.privacyManifests` with `NSPrivacyAccessedAPICategoryUserDefaults` / reason `CA92.1` to `app.json`. The app collects nothing → `NSPrivacyCollectedDataTypes` stays empty.

### A5. `app.json` hygiene

- Remove `"newArchEnabled": false` — a no-op on RN 0.85 that misleads readers. Own commit so any EAS build diff is attributable.

**Effort: ~1–1.5 days.**

---

## Phase B — expo-updates (OTA)

- `npx expo install expo-updates`, then `eas update:configure`. Verify it yields in `app.json`:

  ```json
  "updates": {
    "url": "https://u.expo.dev/b834b64c-f694-4f45-b3fa-0f2c0a4df5ba",
    "checkAutomatically": "ON_LOAD",
    "fallbackToCacheTimeout": 0
  },
  "runtimeVersion": { "policy": "fingerprint" }
  ```

  `fallbackToCacheTimeout: 0` keeps OTA off the startup critical path — launch cached bundle instantly, fetch in background, apply on next cold start. Critical for a radio app opened in cars/dead zones.
- **Runtime policy: `fingerprint`.** It hashes native deps, config plugins, **and `patches/`** — so any edit to the RNTP patch automatically yields a new runtime version, making it impossible to ship a JS-only OTA to a binary with mismatched native code. The `appVersion` alternative relies on a human remembering to bump on patch changes — exactly the failure mode to avoid. Debug "update not applying" with `npx expo-updates fingerprint:generate --platform ios` + `eas update:view`.
- **`eas.json`** — add `"channel": "preview"` to the preview profile and `"channel": "production"` to production.
- Workflow (documented in Phase E): JS-only change → `eas update --channel production`; native change (dep / patch / plugin / infoPlist) → new store build, OTAs thereafter target only the new fingerprint.

**Sequencing constraint:** NetInfo (A1) and expo-updates are both native modules — Phases A + B must land **before** the store-candidate builds, so one new production binary carries everything. OTA only works for builds made after this phase.

**Effort: ~0.5 day.**

---

## Phase C — iOS App Store (public)

The pipeline is already proven (ascAppId `6778786696`, submit config in `eas.json` — no changes needed there).

**Automatable:**
- `eas build --profile production --platform ios` → `eas submit --profile production --platform ios` (same flow as the `subwave-app-ios-release` skill).
- Optional but worthwhile: `store.config.json` + `eas metadata:push` for name/subtitle/description/keywords/privacy URL, since metadata gets edited repeatedly.

**Human checklist (App Store Connect, ordered):**
1. Verify `https://www.getsubwave.com/privacy` is live (page exists in `web/app/privacy/page.tsx`; redeploy `web/` if stale).
2. App Information: category Music; age rating questionnaire (4+).
3. App Privacy questionnaire → **"Data Not Collected"** (matches the privacy page).
4. Screenshots at required sizes (6.9" mandatory, 6.7" recommended). `docs/final/*.png` exist but were captured for docs — re-capture at store resolutions.
5. **Review notes** — important for a streaming app: explain it's a client for self-hosted SUB/WAVE stations, give the live demo station `https://www.getsubwave.com` (no login), justify `UIBackgroundModes: audio`. Preempts a 4.2 minimum-functionality / content-rights question.
6. Select the build, submit for review.

**Effort: ~0.5–1 day active + 1–3 days Apple review.**

---

## Phase D — Google Play (start the human items on day 1 — longest lead time)

**Automatable:**
- **`eas.json`** — add the Android submit block:

  ```json
  "android": {
    "serviceAccountKeyPath": "./secrets/play-service-account.json",
    "track": "internal",
    "releaseStatus": "draft"
  }
  ```
- **`.gitignore`** — add `secrets/`.
- **Create `docs/store/PLAY-DATA-SAFETY.md`** — draft data-safety answers to transcribe into the form: no data collected, no data shared; station list stored on-device only (AsyncStorage); traffic is direct device→station; HTTPS in transit.
- Production profile already builds an AAB by default with the EAS-managed keystore — keep it (only `preview` builds APK).

**Human checklist (ordered):**
1. Create Google Play Console developer account ($25; identity verification can take days). **Start immediately.**
2. Create app record `com.getsubwave.app`; enroll in Play App Signing (default).
3. Store listing: 512px icon, 1024×500 feature graphic, ≥2 phone screenshots, short + full description, privacy policy URL.
4. Content rating questionnaire; target audience; ads declaration (none).
5. Data safety form (transcribe from `docs/store/PLAY-DATA-SAFETY.md`).
6. Google Cloud: enable the Play Android Developer API, create a service account, download JSON to `secrets/play-service-account.json`, invite it in Play Console → Users & permissions with release-management permission.
7. **First AAB upload is manual** via the Console UI (Play requirement before API submissions work): `eas build --profile production --platform android`, download the AAB, upload to the internal/closed track.
8. **Closed-testing gate:** personal developer accounts need a closed test (~12 testers / 14 continuous days) before production access — **verify the current policy in the Console**; overlap the 14-day clock with Phase E QA.
9. Apply for production access; promote. Thereafter `eas submit --profile production --platform android` works end-to-end.

**Effort: ~0.5–1 day active; wall-clock up to ~3 weeks (verification + closed test).**

---

## Phase E — QA checklist + release docs

- **Create `docs/QA-CHECKLIST.md`** — manual device matrix (≥1 physical iPhone, ≥1 physical Android):
  - Background audio, screen off 30+ min
  - Lock-screen metadata + persona/cover swap on song change
  - Headphone unplug → pauses; resume returns to live edge (validates A3)
  - Phone-call interruption + resume (`autoHandleInterruptions`)
  - CarPlay / Android Auto controls
  - Wifi→cellular switch: banner shows, reconnect within a beat (validates A1)
  - Airplane-mode cold start: banner shows, no stuck splash
  - Station off-air mid-listen
  - Android app-kill removes the notification
  - OTA round-trip: `eas update --channel preview` → kill → relaunch ×2 → new JS visible
  - VoiceOver / TalkBack on transport controls
  - Multi-hour battery sanity
- **Create `docs/RELEASE.md`** — runbook: channels, OTA-vs-binary decision table, fingerprint semantics, store submit commands, links to the `subwave-app-ios-release` / `subwave-app-android-release` skills.
- **Modify `README.md`** (add a Release section) and **`docs/TESTING.md`** (OTA now exists).
- Optional: refresh the two release skills for the store + OTA flows.

**Effort: ~0.5 day writing + 0.5–1 day executing on candidate builds.**

---

## Ordering / dependency graph

```
Day 1 ──► D1–D2 (Play account — start the clock)
A (hardening) ─┐
               ├─► one production binary (NetInfo + expo-updates baked in)
B (OTA wiring) ┘         │
E (write checklist) ─────┼─► E execute QA ─► C iOS submit (can go public first)
                         └─► D manual AAB upload → closed test → production
```

A and B are independent of each other but both precede the C/D builds. iOS can go fully public while the Android closed test runs.

## Risk callouts

1. **The RNTP patch survives this plan untouched.** New deps re-run `patch-package` (apply-only). Never regenerate the patch after a Gradle build (see the warning in `docs/TESTING.md`). Always install with `npx expo install` for SDK-pinned versions.
2. **Fingerprint policy is the patch's safety net** — patch edits change the runtime version, so OTAs can't reach mismatched binaries. Verify once with `npx expo-updates fingerprint:generate` before/after touching `patches/`.
3. **Don't touch** `plugins/withGradleVersion.js` (Gradle 8.14.3 pin) or the `expo-build-properties` SDK pins — both are load-bearing for EAS builds.
4. The A3 `service.ts` change runs headless — try/catch everything; revert to bare `play()` if device QA misbehaves.
5. Keep `fallbackToCacheTimeout: 0` — never block startup on the OTA fetch.
6. Production Android stays AAB; only `preview` builds APK.

## Verification

- `npx tsc --noEmit` + `npx expo-doctor` after each phase.
- A1/A3: physical-device QA per `docs/QA-CHECKLIST.md` (airplane-mode toggle, lock-screen resume after 60s).
- B: preview binary + `eas update --channel preview` with a visible JS change → cold-relaunch twice → confirm it applies.
- C/D: TestFlight build of the candidate + Play internal track before any public promotion.
