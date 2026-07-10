# Task 3 report: Make `usePlayer` format-selectable

## Status

Complete. Commit `3d7f98a` (`feat(web): switch and persist audio formats`).

## RED evidence

Added browser codec/platform policy assertions and the runtime-failure availability assertion to `web/scripts/audio-format.test.ts` before implementation.

Command: `cd web && npm run test:audio-format`

Observed failure (exit 1):

```text
SyntaxError: The requested module '../lib/audioFormat.ts' does not provide an export named 'browserSupportFor'
```

This was the expected failure because the new pure browser policy did not yet exist.

## GREEN evidence

Final verification commands:

```text
cd web
npm run test:audio-format
npm run typecheck
npx eslint hooks/usePlayer.ts lib/audioFormat.ts scripts/audio-format.test.ts
git diff --check
```

All exited 0. The audio-format suite printed `audio-format: all assertions passed`; TypeScript completed with no diagnostics; focused ESLint and whitespace checks were clean. Node emitted the repository's existing module-type performance warning for the standalone TypeScript test script.

## Files changed

- `web/hooks/usePlayer.ts`
  - Adds `streamEnablement` input and public `format`, `availability`, `selectFormat`, and `formatFailure` values.
  - Detects MP3/Opus/AAC/FLAC support after hydration, preserving the iOS/Firefox chained-Ogg exclusion.
  - Restores and saves station-scoped explicit preferences using `apiUrl`.
  - Switches immediately while tuned in and falls back to MP3 through the existing reconnect schedule after a non-MP3 runtime error.
  - Quarantines runtime-failed formats for the page session without deleting the stored preference.
- `web/lib/audioFormat.ts`
  - Adds pure `browserSupportFor()` policy.
  - Adds runtime-failure overlay support and the exact `Stream failed; using MP3` reason.
- `web/scripts/audio-format.test.ts`
  - Covers browser codec policy, chained-Ogg exclusions, and runtime-failure availability.

## Self-review

- Confirmed null station URLs are folded into effective station enablement.
- Confirmed unavailable and runtime-failed formats are rejected by `selectFormat`.
- Confirmed active format and URL refs update synchronously before playback, avoiding stale watchdog reads.
- Confirmed runtime fallback never calls `saveFormatPreference`, so the stored preference remains intact.
- Confirmed MP3 errors retain the existing exponential reconnect behavior without quarantining MP3.
- Removed an unnecessary hook dependency discovered during lint review.
- Staged and committed only the three authorized Task 3 files; `web/package-lock.json` and `.superpowers/` remain outside the commit.

## Concerns

No blocking concerns. Hook event behavior is typechecked and its pure policies are covered, but this repository does not currently provide a React hook/DOM test harness for directly simulating media-element error events.

## Review fix

Fixed the three lifecycle findings in a focused follow-up:

- Preference restoration now resolves availability with the page-session runtime-failure quarantine, preventing a failed stored format from being restored after later dependency changes.
- When restoration changes the effective format or stream URL while tuned in, it uses the same generation-safe, cache-busted live switch path and moves status to `connecting`.
- Watchdog cancellation is now shared by reconnect, explicit selection, restored live switching, and stop, so an armed stale timer cannot interrupt a deliberate switch.

No new pure test was added: the runtime-failure availability seam was already covered in `audio-format.test.ts`, while live media retargeting and timer cancellation depend on React hook/media-element lifecycle events and this repository has no hook/DOM test harness. Those paths were verified by focused typecheck/lint and code-path review.

Fresh verification from `web/`:

```text
$ npm run test:audio-format
> sub-wave-web@0.39.0 test:audio-format
> node --experimental-strip-types scripts/audio-format.test.ts
audio-format: all assertions passed

$ npm run typecheck
> sub-wave-web@0.39.0 typecheck
> tsc --noEmit

$ npx eslint hooks/usePlayer.ts lib/audioFormat.ts scripts/audio-format.test.ts
(no output; exit 0)

$ git diff --check
(no output; exit 0)
```

The audio-format command also emitted the repository's existing `MODULE_TYPELESS_PACKAGE_JSON` performance warning for the standalone TypeScript test script. Every command exited 0.

Lifecycle self-review confirmed that refs update before playback, live restoration only retargets when the effective format/URL changes, runtime fallback still preserves localStorage and schedules MP3 through the existing exponential backoff, and explicit/restored switches cancel any armed watchdog before incrementing the playback generation.
