# Native audio selection final-review fixes

## Status

DONE_WITH_CONCERNS

## Implemented

- Added a first-tune readiness coordinator. Tune now waits for both station-scoped preference storage and the first authoritative stream-capability result, so a stored, enabled AAC preference is the first RNTP target.
- Added a five-second bounded MP3 fallback for legacy stations that never advertise `stream`; storage failure also resolves safely to no stored preference.
- Explicit format selection owns pending readiness, while station changes invalidate old waiters.
- Added a serialized, coalescing latest-load coordinator around every RNTP `loadAndPlay` operation. An older success must finish before the newest load starts, and only the newest completion is considered applied.
- Preserved the existing AirPlay-safe `loadAndPlay` path, per-load volume restoration, direct load-rejection attribution, conservative unattributed `PlaybackError` handling, selected-format watchdog reconnects, and stop/station invalidation.
- Added a labelled `radiogroup` wrapper while retaining each row's `radio` role and checked/disabled state.
- Added dependency-free deferred-promise coverage for readiness timing, legacy fallback, deliberate selection, station invalidation, overlapping/coalesced loads, stale success/rejection ownership, stop invalidation, and selected-format watchdog retention.

## Verification

- `cd app && npm run test:audio-format`: pass (`audio-format tests passed`).
- `cd app && npm run typecheck`: pass.
- Focused ESLint on all touched TS/TSX files, disabling only the documented repository React Compiler baseline rules: pass with zero findings.
- `cd app && npx expo-doctor`: pass, 21/21 checks.
- `cd app && npm run lint`: repository baseline remains non-green, 42 errors and 4 warnings in existing React Compiler rule findings. No focused finding remains in the changed code under the same baseline-rule exceptions used by prior task reports.
- `git diff --check`: pass before commit.

## Remaining concern

- Background polling was assessed but not changed. `useStationFeed` reads the stable tuned-in ref only when its effect is established, so a remote tune-out while already backgrounded may leave that 30-second interval alive until another effect dependency changes. Making this reactive without duplicating the feed/player hooks requires introducing a subscribed external signal or changing hook ownership; a local state-mirroring attempt adds a synchronous-effect state update and an extra broad-lint violation. This is independent of native load correctness and is best handled as a focused follow-up.
- Physical-device playback, AirPlay, and background-control checks were not available in this environment; static checks and coordinator tests are complete.

## Active-load invalidation follow-up

### Status

DONE_WITH_CONCERNS

### Implemented

- Made the serialized load executor expose an ownership predicate tied to its request revision.
- Wrapped native setup, in-place `TrackPlayer.load()`, metadata publication, and `TrackPlayer.play()` in an ownership-aware helper. Ownership is checked after setup, after load, and after play.
- When stop, station change, or a newer request invalidates an execution, the stale execution performs a compensating `TrackPlayer.reset()` and clears `lastLiveMeta` before releasing the coordinator lock. This prevents stale playback resurrection without allowing cleanup to erase a queued replacement.
- Kept valid loads on the AirPlay-safe in-place `load()` path and retained stream headers, metadata, volume restoration, direct failure fallback, service-facing metadata, and latest-wins coalescing.
- Added dependency-injected deferred-promise coverage for invalidation during load, invalidation during play, the valid load/play path, and replacement serialization behind compensation.

### Verification

- `cd app && npm run test:audio-format`: pass (`audio-format tests passed`).
- `cd app && npm run typecheck`: pass.
- Focused ESLint on the four touched TS/TSX files, disabling only the documented repository baseline rules `react-hooks/refs` and `react-hooks/set-state-in-effect`: pass with zero findings.
- `cd app && npx expo-doctor`: pass, 21/21 checks.
- `cd app && npm run lint`: unchanged repository baseline, 42 errors and 4 warnings in existing React Compiler findings (including the two pre-existing `usePlayer.ts` findings covered by the focused-lint exceptions).
- `git diff --check`: pass before commit.

### Remaining concern

- Physical-device stop-during-load, station switching, AirPlay, and background-service checks were not available in this environment. The native race is covered through the dependency-injected async boundary and static verification.
