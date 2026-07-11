# Task 1 Report: Pure Format Policy and Persistence

## Status

Implemented the native audio format policy and AsyncStorage persistence contracts from the task brief.

## Files

- Created `app/src/lib/audioFormat.ts`
- Created `app/src/lib/audioFormatStorage.ts`
- Created `app/scripts/audio-format.test.ts`
- Modified `app/package.json`

## RED evidence

Command:

```text
cd app && npm run test:audio-format
```

Result: exit 1 with the expected failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../app/src/lib/audioFormat.ts'
```

The failure occurred before either production module existed.

## GREEN evidence

After implementing the policy and storage modules, the focused test printed:

```text
audio-format tests passed
```

The first combined verification found that the repository tsconfig includes `scripts/**/*.ts`, while the verbatim Node test uses `node:assert/strict` and a `.ts` import without configuring Node types or `allowImportingTsExtensions`. I added a test-file-only `// @ts-nocheck` directive; runtime coverage and production type checking are unchanged.

Final verification command:

```text
cd app && npm run test:audio-format && npm run typecheck
```

Result: exit 0. The policy test printed `audio-format tests passed`; `tsc --noEmit` completed with no errors.

Additional check:

```text
git diff --check
```

Result: exit 0.

## Self-review

- Public types and format option values match the brief.
- Station, device, and failed availability precedence matches the specified implementation.
- Stored unavailable formats fall back to MP3.
- Per-station preference keys trim whitespace, remove trailing slashes, and lowercase the base.
- Stream URL selection is a direct typed lookup.
- AsyncStorage loading rejects values outside the declared format IDs.
- AsyncStorage saving uses the per-station preference key.
- No unrelated files were modified or staged; `controller/scripts/__pycache__/` remains untouched and untracked.

## Concerns

- Node emits a non-fatal `MODULE_TYPELESS_PACKAGE_JSON` warning during the focused test because `app/package.json` does not declare `"type": "module"`. The test exits 0 and the package metadata was not broadened beyond the brief.
- The test-only `// @ts-nocheck` directive is necessary under the current app tsconfig unless the project later adopts Node typings and `allowImportingTsExtensions` for scripts.

## Important review finding fix: canonical station origin

The review found that `streamPreferenceKey` normalized raw text rather than a parsed
station origin. Consequently, equivalent station addresses produced different keys,
and credentials or paths could be persisted in AsyncStorage key names.

### RED evidence

Added focused assertions proving that these inputs must share one key:

- `radio.test`
- `https://RADIO.test/`
- an HTTPS URL with a path, query, and fragment
- an HTTPS URL with credentials, path, and the default `:443` port

The test also explicitly asserts that username, password, and path text do not occur
in the generated key.

Command:

```text
cd app && npm run test:audio-format
```

Result: exit 1 on the first new equivalence assertion. The old implementation
returned `subwave.audio-format.v1:radio.test` for the bare host instead of the
canonical `subwave.audio-format.v1:https://radio.test`.

### Fix

`streamPreferenceKey` now trims the input, defaults a scheme-less address to HTTPS,
parses it with the platform `URL` implementation, rejects non-HTTP(S) protocols, and
uses only `url.origin`. URL parsing supplies host/protocol case normalization and
default-port removal while excluding credentials, path, query, and fragment.

### GREEN evidence

Command:

```text
cd app && npm run test:audio-format && npm run typecheck
```

Result: exit 0. The focused test printed `audio-format tests passed`, and
`tsc --noEmit` completed without errors.

Additional check:

```text
cd app && git diff --check
```

Result: exit 0.

The existing non-fatal Node module-type warning remains; changing package module
semantics was intentionally left out of this narrowly scoped correctness fix.
