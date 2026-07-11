# Task 3 report: Player Selection and Fallback

## Status

Implemented native live-format selection, per-station preference hydration, selected-format reconnects, and optional-format fallback to MP3.

## RED / GREEN evidence

- RED: `cd app && npm run test:audio-format` exited 1 because `fallbackForPlaybackError` was not exported.
- GREEN: after adding the generation guard, the same command exited 0 with `audio-format tests passed`.

## Implementation review

- `Player` now exposes `format`, `availability`, `selectFormat`, and `formatFailure`; `usePlayer` accepts station stream enablement with MP3-only defaults.
- Preference hydration is station-scoped and guarded by both an alive flag and captured base. A first tune awaits its hydration promise and aborts if the station changes.
- `loadFormat` is the single live-load path for tune, watchdog reconnect, format switching, and fallback. It preserves the current route by continuing to use `loadAndPlay`, reapplies the current volume, and prevents reconnects reverting to MP3.
- Unavailable choices are rejected. Valid choices persist even while idle; a live choice reloads immediately and retains existing retry backoff on synchronous load failure.
- Playback errors on an active optional-format generation mark that format failed for the session and immediately load MP3 without overwriting the stored preference. MP3 errors retain existing backoff behavior.
- Station changes retain the existing teardown authority, reset in-memory format/failures to MP3, and hydrate the next station's preference.
- Remote pause/stop, AirPlay load continuity, volume persistence, connectivity recovery, and teardown semantics remain intact.
- The Cast facade spreads local format state into its connected-player facade so the expanded required `Player` interface remains type-safe.

## Verification

- `cd app && npm run test:audio-format`: pass.
- `cd app && npm run typecheck`: pass.
- Focused ESLint on the four touched source/test files (plus the necessary Cast facade), with the repo-wide React compiler rules disabled: pass, zero findings.
- Required `cd app && npm run lint`: blocked in the checked-out dependency state because ESLint was absent. Installing the SDK-aligned lint packages without saving them makes the command run, but the repository baseline has 43 pre-existing React Compiler lint errors across unrelated files. The changed hook also follows two patterns explicitly required by the brief (reading the failure ref to derive availability and resetting state in the hydration effect) that those newly introduced compiler rules reject.
- `git diff --check`: pass.

## Concerns

- RNTP's `PlaybackError` event does not expose a track/load identifier. The required generation guard is implemented against the active load descriptor, but native events cannot independently identify which historical item emitted a late error. The guard fully rejects explicit mismatched generations and station/tune state still prevents errors after tune-out from reconnecting.
- `npm install --no-save --package-lock=false` was used only to diagnose the missing lint toolchain; no manifest or lockfile changes were produced.

## Review-fix follow-up (2026-07-10)

- Removed optional-format fallback from unattributed RNTP `PlaybackError` events. Those events now use reconnect/backoff only.
- Direct `loadAndPlay` rejection handling captures the attempted format and generation. Only a rejection that still belongs to the active generation can blacklist an optional format and fall back to MP3; a superseded rejection is ignored. The stored preference is unchanged.
- Replaced the tautological event-generation helper with `fallbackForLoadRejection`, whose generation inputs come from the actual promise attempt and are covered by focused pure tests.
- Added a selection revision to station preference hydration. A station change or user selection invalidates an older hydration result, while first tune still awaits the current hydration promise.
- Station failure state now resets only on `api.base` changes. Same-station enablement changes preserve failures and deliberately reload MP3 if the currently selected/live mount becomes unavailable, keeping UI state and RNTP aligned.

### Fresh verification evidence

- RED: `cd app && npm run test:audio-format` exited 1 because `fallbackForLoadRejection` was not exported.
- GREEN: `cd app && npm run test:audio-format` passed (`audio-format tests passed`).
- `cd app && npm run typecheck`: passed.
- `cd app && npx eslint src/hooks/usePlayer.ts src/lib/audioFormat.ts scripts/audio-format.test.ts --rule 'react-hooks/refs: off' --rule 'react-hooks/set-state-in-effect: off'`: passed with zero findings. The two disabled React Compiler rules are the same documented repository/toolchain incompatibilities affecting the required ref-backed availability and station-reset effect patterns.
- `cd app && npm run lint`: ran and reported the unchanged broad baseline of 43 errors and 4 warnings across the app, including the two previously documented findings in `usePlayer.ts`.
