# Task 2 — query-backed discovery

## Delivered

- Added `web/hooks/discovery-queries.ts` with normalized model/voice inputs,
  stable discovery key factories, debounced automatic discovery, cancellation
  via TanStack's query signal, raw-key manual refreshes, endpoint-error mapping,
  model placeholder data, and voice-list clearing during input transitions.
- Kept the exported `useModelDiscovery` and `useVoiceDiscovery` result shapes
  unchanged.
- Extended `useAdminQuery` with optional explicit `placeholderData` support.
- Scoped an `AdminQueryProvider` to `/onboarding`, so a wizard LLM-step
  unmount/remount reuses its 30-second cache without placing a client in the
  root layout.
- Added isolated Playwright coverage for settings debounce, onboarding cache
  reuse, immediate refresh/no duplicate debounce request, discovery-key
  transitions, and TTS provider change clearing.

## RED evidence

Before conversion, the focused check run failed as intended:

- `discovery_onboarding_provider`: the LLM wizard step remounted and made two
  `wizard.test` discovery requests; cache reuse requires one.
- `discovery_refresh_is_immediate`: manual refresh made one raw request and the
  legacy timeout effect made a second request after its debounce; the query
  path keeps that at one.

The initial settings fixture was necessary because this isolated controller has
no `better-sqlite3` native binding; it prevents `/settings` from rendering and
does not route any real station traffic.

## GREEN verification

```text
python3 web/scripts/verify-admin-query.py discovery_settings_debounce discovery_onboarding_provider discovery_refresh_is_immediate discovery_stale_response_isolated
PASS discovery_settings_debounce
PASS discovery_onboarding_provider
PASS discovery_refresh_is_immediate
PASS discovery_stale_response_isolated
all 4 check(s) passed

npm --prefix web run lint
exit 0 (5 pre-existing warnings; no errors)

git diff --check
exit 0
```

## Limitation

`VERIFY_WEB=http://localhost:7793 VERIFY_API=http://localhost:7791 python3 web/scripts/verify-hooks.py`
could not complete: its existing Browse assertion requires a seeded 1,413-row
library database, while the mandated isolated controller lacks `better-sqlite3`.
It timed out waiting for that fixture before exercising the unrelated hook
checks. No live station was used.

`node web/scripts/audit-admin-query.mjs` continues to report the repository's
existing unclassified admin fetch calls; discovery itself is query-backed and
the audit has no discovery-specific finding.

## Verification follow-up — native SQLite repair

The initial verification limitation above is resolved. The controller's local
`better-sqlite3` package had a blocked `node-gyp rebuild` install script and no
native binding. In this isolated worktree only, I ran:

```text
cd controller
npm rebuild better-sqlite3
npm install-scripts ls
# better-sqlite3@11.10.0 (install: node-gyp rebuild) was the reviewed script
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
node -e "... require('./node_modules/better-sqlite3') ..."
# better-sqlite3 opens a database
```

The rebuild produced
`controller/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
(2,072,760 bytes). `npm install-scripts approve` temporarily added an
`allowScripts` entry to `controller/package.json`; it was removed immediately
after the native binary was built. No dependency manifest or lockfile change is
included in this task.

The isolated controller ran with `STATE_DIR=/tmp/tmp.Uji2U4jVXD/state` on
`:7791` and the worktree web server on `:7793`. A disposable Node script used
that isolated `library.db` only, inserting 1,413 verification tracks (53
`Love song` rows) so the pre-existing Browse assertions had their documented
fixture. The controller returned `total: 1413` and the filtered endpoint
returned `total: 53`.

```text
VERIFY_WEB=http://localhost:7793 VERIFY_API=http://localhost:7791 LIBRARY_TOTAL=1,413 python3 web/scripts/verify-hooks.py
22/22 passed
```

This follow-up changed only this tracked report. The temporary state directory
and isolated `:7791`/`:7793` processes were not part of the repository or the
live station.
