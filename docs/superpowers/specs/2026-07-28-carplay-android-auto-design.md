# CarPlay + Android Auto for the SUB/WAVE native app — design

**Date:** 2026-07-28
**Scope:** `app/` (Expo SDK 56 / RN 0.85, New Architecture)
**Status:** draft for review

## Problem

Listeners keep asking for CarPlay and Android Auto. Audio already plays in cars today (Bluetooth/USB media session: steering-wheel play/pause and now-playing metadata work via `react-native-track-player` + `useNowPlayingInfo`), but SUB/WAVE has **no app icon inside CarPlay or Android Auto** — you can't launch or pick the station from the car screen.

## What's actually blocking us (research findings, July 2026)

### Android

- Stock `react-native-track-player@4.1.2` (what we ship, with our new-arch patch) **cannot** support Android Auto: its `MusicService` extends `HeadlessJsTaskService`, not a browsable media service, and Android Auto only lists apps that expose a `MediaBrowserService`/Media3 `MediaLibraryService` plus car manifest metadata. Every upstream PR adding this to v4 died unmerged; upstream closed it won't-fix for v4.
- Upstream shipped the real fix in **RNTP v5 (`@rntp/player`)** — Media3, `setBrowseTree` drives Android Auto *and* CarPlay — but v5 went **commercial** in May 2026 (€999/yr commercial use; free personal; 6-month indie "Launch Credit").
- The **lovegaoshi fork of v4** (Apache-2.0) is the free path: Media3 `MediaLibrarySession` inside, same v4 JS API, adds `setBrowseTree` / `setBrowseTreeStyle` / `setPlaybackState`, and is **production-proven through Play review on our exact stack** (Azusa Player Mobile: Expo 56, RN 0.85.3, New Arch).

### iOS

- CarPlay is entitlement-gated (`com.apple.developer.carplay-audio`), granted by Apple on application at <https://developer.apple.com/contact/carplay/> (Account Holder files it; category **Audio**; radio-station justification is routinely approved — white-label radio platforms send every customer through this form). Typical wait **1–6 weeks**, occasional multi-month outliers. No expedite channel. Still fully gated in the iOS 26/27 era.
- `react-native-carplay@2.4.1-beta.0` is the proven library: audio templates (List/Grid/TabBar/NowPlaying) work on New Arch via the interop layer — Jellify ships it in production on RN 0.86 with RNTP. What needs hand-work is the **scene split**: CarPlay requires `UIApplicationSceneManifest` (CarPlay scene + phone scene) and Swift scene delegates, which we must inject via an in-repo Expo config plugin (no eject; Jellify PR #302 is the current reference for the modern AppDelegate; KMalkowski's plugin is a starting skeleton).
- `CPNowPlayingTemplate` reads `MPNowPlayingInfoCenter`, which RNTP already drives — the car now-playing screen populates **for free** once the scene exists.
- EAS cannot auto-sync the CarPlay capability: after Apple grants it, we manually enable it on the `com.getsubwave.app` App ID (Additional Capabilities) and regenerate provisioning profiles. The **CarPlay Simulator ignores provisioning**, so all UI work can happen before the grant.

## Approaches considered

1. **lovegaoshi RNTP fork (Android Auto) + react-native-carplay (CarPlay)** — free, Apache-2.0, both halves production-proven on our stack (APM and Jellify respectively). Keeps our v4 API surface; likely retires our 405-line new-arch patch. Risk: single-maintainer fork (mitigated: pin a commit; Podverse mirrors it; APM depends on it in production). **← Recommended.**
2. **Migrate to commercial RNTP v5** — one `setBrowseTree` API for both platforms, vendor support, live-edge-resume fixes for radio. Costs €999/yr (or 6-month Launch Credit) and is a breaking API migration; still needs the same Apple entitlement + scene plugin. Keep as fallback if the fork bit-rots.
3. **Hand-patch stock 4.1.2 via patch-package** — ~500–1000 lines of Kotlin reinventing the fork on the dead ExoPlayer2 codebase. Rejected.

## Design (approach 1)

### Phasing — two independent tracks, one shared module

**Track 0 (operator, today, zero code):** file the CarPlay entitlement request — Account Holder, category Audio, justification "internet radio station; listeners commute". This is the only calendar blocker; everything else proceeds in parallel.

**Shared: `src/car/browseTree.ts`** — one module that derives the car station list from existing state: featured station (`featuredStation()`) + saved recents (`lib/station.ts`), each as a playable "▶ Listen live — {name}" entry keyed by normalized station URL. Selecting an entry maps to the existing tune-in path (`StationContext` switch if needed → `loadAndPlay`). No new state; the car UI is a *view* over the station store.

**Track A — Android Auto:**

1. Swap `react-native-track-player` to a pinned commit of the lovegaoshi fork (git dependency, like APM does). Diff its iOS tree against 4.1.2 to confirm our iOS-critical behaviors survive (see Risks). Drop our new-arch patch if the fork already carries the fix; keep `patch-package` wiring.
2. New in-repo config plugin `plugins/withAndroidAuto.js` (~40 lines): writes `res/xml/automotive_app_desc.xml` (`<uses name="media"/>`) and adds the `com.google.android.gms.car.application` meta-data to the manifest. Same idempotent pattern as our three existing plugins.
3. Wire the browse tree: on app start (and on station-store change), `setBrowseTree` with root → playable station items; handle `Event.RemotePlayId` (browse tap → tune that station) and `Event.RemotePlaySearch` (voice → play active/featured station — the accepted single-stream pattern for VC-1). Model on APM's `useAndroidAuto.ts`.
4. Car-quality constraints we must respect: **no autoplay on launch** (MA-1 — car UI shows the list; user taps), content within 10s (DR-3 — the tree is local state, instant), play/pause + metadata on every item (MC-1 — already true).
5. QA on the Desktop Head Unit (DHU) + a real head unit; Play Console → Form factors → add Android Auto (review is non-blocking on closed testing, blocking on production).

**Track B — CarPlay:**

1. Add `react-native-carplay@2.4.1-beta.0`.
2. New in-repo config plugin `plugins/withCarPlay.js`: entitlement via `ios.entitlements` (`com.apple.developer.carplay-audio: true`), `UIApplicationSceneManifest` (CarPlay + phone scenes) via `withInfoPlist`, and the two Swift scene delegates (`CarSceneDelegate` calling `RNCarPlay.connect/disconnect`, `PhoneSceneDelegate`) + AppDelegate adjustments via `withDangerousMod`/`withXcodeProject`, following Jellify PR #302's Swift. Must be idempotent under `prebuild --clean`; note in `app/docs/TESTING.md` that every Expo SDK upgrade must re-verify this plugin against the new AppDelegate template (same caveat class as our existing native-config warnings).
3. JS: on `CarPlay.connect`, set root `CPListTemplate` from the shared browse-tree module; item select → tune-in path → push `CPNowPlayingTemplate.shared`. No custom now-playing wiring needed (RNTP feeds `MPNowPlayingInfoCenter`). RemoteNext/seek stay unwired — same shared-live-broadcast rule as `service.ts`.
4. Develop and demo entirely in the CarPlay Simulator (Xcode I/O → External Displays → CarPlay) while waiting for the entitlement — simulator builds skip provisioning checks.
5. After the grant: enable CarPlay on the App ID in the developer portal (manual — EAS can't), regenerate profiles via `eas credentials` (`EXPO_NO_CAPABILITY_SYNC=1` escape hatch if sync chokes on the unknown key), TestFlight, verify in a real car, submit. Apple's extra CarPlay review checks: templates only, works without touching the phone, audio starts reliably; a one-stream radio app with list → now-playing is squarely inside the rails.

### Error handling

- **Car cold start with the phone app dead** (both platforms): playback must start natively even if headless JS lags. Our `service.ts` RemotePlay handler already reloads at the live edge with a cache-buster — that's the critical car behavior (stale-buffer resume is the classic radio-app car bug). Explicit QA item: kill app → connect car → tap station. Known v5 issue (#2662, headless JS not starting on car cold start) must be re-verified against the fork; acceptable degradation if hit: ICY-derived title shows until the phone app is next opened (our `/now-playing`-poll enrichment lives in the React tree).
- **Empty browse tree**: impossible by construction — featured station is always present.
- **Station unreachable from car UI**: same failure path as in-app tune-in (RNTP error events); the car surfaces the media-session error state. No new handling.

### Testing

- `npm run lint` + `typecheck` (merge gate).
- CarPlay Simulator + Android DHU flows scripted into `app/docs/QA-CHECKLIST.md`: launch from car, tune from car list, play/pause from wheel, metadata updates on song change, DJ-avatar swap during voice turns, cold-start-from-car, AirPlay/HomePod regression (iOS category policy), background→car handoff.
- Library-swap regression pass on the fork (iOS especially): live-edge RemotePlay, `longFormAudio` route policy, AirPlay stability, Android deep buffering (#993 behavior), Cast coexistence.

## Risks

| Risk | Mitigation |
| --- | --- |
| Entitlement wait (1–6 wks, occasionally months) | File today (Track 0); all dev proceeds in simulator meanwhile |
| lovegaoshi fork is single-maintainer | Pin commit; APM/Podverse depend on it in production; fallback = paid RNTP v5 |
| Fork swap regresses delicate iOS audio behaviors (AirPlay, live-edge, category policy) | Diff fork's ios/ vs 4.1.2 before swap; full device QA checklist above |
| CarPlay config plugin breaks on future Expo SDK upgrades (AppDelegate template churn) | Documented re-verify step in TESTING.md; plugin kept small and idempotent |
| react-native-carplay is a beta tag, MapTemplate broken on New Arch | We use only audio templates (proven path); no maps |
| Play car-quality review (voice search, no-autoplay) | VC-1/MA-1 handled in design; closed-track review first |

## Out of scope (YAGNI)

- Song requests / booth / schedule from the car screen — driver-distraction surface, review risk, no listener demand.
- Android Automotive OS (cars without phones) — different distribution + review track entirely.
- `@iternio/react-native-auto-play` — the anointed successor library, but has no audio/NowPlaying templates yet; re-evaluate at next SDK upgrade.
- Skip/seek in car UIs — shared live broadcast, deliberately unwired everywhere else.

## Estimates

- Track A (Android Auto): ~2–4 days engineering; Play form-factor review latency on top.
- Track B (CarPlay): ~3–4 days engineering (config plugin + scene delegates are the meat); entitlement wait dominates calendar time.
- Total new native code: two config plugins + two small Swift delegate files; zero Kotlin.

## Addendum (found during implementation): prior Google Play enforcement

App history this design missed: a manifest-only Android Auto declaration
(#444) was **enforced against by Google Play on 20 Jun 2026** — *"Category not
permitted — media apps that use TTS engine readout for content are not
permitted at this time"* — and the build was pulled (#477 removed the
declaration). The AI DJ **is** TTS readout, so the compliant browse tree built
here does not cure the policy objection, and re-declaring Android Auto on Play
risks repeat enforcement against an already-struck app.

**Decision:** the Android Auto declaration is env-gated
(`SUBWAVE_NO_ANDROID_AUTO=1` strips it; set on the `production` EAS profile),
mirroring the CarPlay entitlement gate. Android Auto works on dev, sideloaded,
and `preview` (internal APK) builds today; Play-bound builds stay compliant.
Re-attempting Play distribution (policy change or appeal armed with the
compliant `MediaLibraryService` implementation) is a one-line `eas.json`
change. CarPlay is unaffected — Apple has no comparable TTS rule and DJ-talk
radio apps are the norm there.
