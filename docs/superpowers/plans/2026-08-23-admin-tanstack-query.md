# Admin TanStack Query Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #1368 by moving every retained admin server read, poll, and cache-affecting mutation to TanStack Query and delivering the result as one pull request against `develop`.

**Architecture:** One query client lives inside authenticated `AdminShell`, with a second scoped instance for onboarding. A generic `web/lib/admin-query.ts` owns response parsing, abort propagation, optional query error toasts, and mutation plumbing; each feature owns its query keys and cache invalidation. Existing Library cache-shape helpers remain feature-local and adapt to the generic hooks.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, `@tanstack/react-query` v5, `usehooks-ts`, Playwright Python verification scripts, ESLint, TypeScript compiler.

**Spec:** `docs/superpowers/specs/2026-08-23-admin-tanstack-query-design.md`

## Global Constraints

- Keep `refetchOnWindowFocus: false`, `retry: false`, and default `staleTime: 30_000`.
- Never install a global `QueryCache.onError`; query errors toast only through an explicit `toastOnError` option.
- Never include `adminFetch` identity in a query key.
- Normalize response shapes in `queryFn`, never with `select`.
- Add `staleTime` and `refetchInterval` to options only when explicitly defined.
- Pass every query's TanStack `AbortSignal` through `adminFetch`.
- Preserve every existing polling interval, silent-failure rule, manual refresh, busy label, and optimistic update.
- Keep one-shot downloads, previews, credential tests, SSE streams, and operator commands imperative.
- Do not change controller endpoints, response schemas, page layout, or visual design.
- Do not change non-admin `lib/poll.ts` consumers.
- Write each executable browser check before its production conversion and observe the expected failure.
- Run destructive verification only against the isolated verify stack on controller `:7791`, web `:7793`, credentials `test:test`, with `SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1` only after confirming those ports.

---

### Task 1: Shared query client, generic hooks, and audit harness

**Files:**
- Create: `web/lib/admin-query.ts`
- Create: `web/scripts/verify-admin-query.py`
- Create: `web/scripts/audit-admin-query.mjs`
- Modify: `web/components/admin/AdminQueryProvider.tsx`
- Modify: `web/components/admin/AdminShell.tsx`
- Modify: `web/components/admin/LibraryPanel.tsx`
- Modify: `web/components/admin/library/useAdminQuery.ts`
- Modify: `web/components/admin/library/queries.ts`
- Modify: `web/CLAUDE.md`

**Interfaces:**
- Produces `AdminFetch`, `adminJson<T>()`, `adminResponse()`, `useAdminQuery<T>()`, `useAdminMutation<TData, TVars>()`, and `useQueryErrorToast()` from `web/lib/admin-query.ts`.
- Produces a shell-level query client that survives navigation among authenticated `/admin/**` routes and is destroyed when the authenticated branch unmounts.
- Produces `verify-admin-query.py [check ...]`, using the existing `CHECKS` decorator convention.

- [ ] **Step 1: Add failing provider-lifetime checks**

Create `verify-admin-query.py` with the existing isolated-stack assertion, authenticated browser context, request recorder, and these checks:

```python
@check
def cache_survives_admin_navigation(page):
    page.goto(f"{WEB}/admin/library?tab=browse", wait_until="networkidle")
    before = len([u for u in page.requests if "/library/browse" in u])
    page.goto(f"{WEB}/admin/settings", wait_until="networkidle")
    page.goto(f"{WEB}/admin/library?tab=browse", wait_until="domcontentloaded")
    page.wait_for_selector(".lib-row")
    after = len([u for u in page.requests if "/library/browse" in u])
    assert after == before, (before, after)

@check
def unauthorised_query_is_not_retried(page):
    hits = []
    page.route("**/api/stations", lambda route: (hits.append(route.request.url), route.fulfill(status=401, body='{}'))[1])
    page.goto(f"{WEB}/admin/stations", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    assert len(hits) == 1, hits
```

- [ ] **Step 2: Run the provider checks and verify RED**

Run:

```bash
python3 web/scripts/verify-admin-query.py cache_survives_admin_navigation unauthorised_query_is_not_retried
```

Expected: `cache_survives_admin_navigation` fails because `LibraryPanel` destroys its client when navigating away; the 401 check either fails before Stations conversion or records the existing request behaviour for Task 7.

- [ ] **Step 3: Implement the generic query module**

Define these exact public shapes in `web/lib/admin-query.ts`:

```ts
export type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function adminResponse(
  adminFetch: AdminFetch,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<Response>;

export async function adminJson<T>(
  adminFetch: AdminFetch,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T>;

export interface AdminQueryOpts<T> {
  key: readonly unknown[];
  adminFetch: AdminFetch;
  request: (fetcher: AdminFetch, signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: UseQueryOptions<T>['refetchInterval'];
  toastOnError?: boolean;
}

export function useAdminQuery<T>(opts: AdminQueryOpts<T>): UseQueryResult<T>;

export interface AdminMutationOpts<TData, TVars> {
  adminFetch: AdminFetch;
  request: (vars: TVars, fetcher: AdminFetch) => Promise<TData>;
  onDone?: (data: TData, vars: TVars, client: QueryClient) => void | Promise<void>;
  toastOnError?: boolean;
}

export function useAdminMutation<TData, TVars>(
  opts: AdminMutationOpts<TData, TVars>,
): UseMutationResult<TData, Error, TVars>;
```

`adminResponse` must merge the supplied signal into `RequestInit`, throw an error containing the endpoint and HTTP status on non-OK responses, and preserve a JSON `{error}` message when present. `adminJson` parses the successful response. `useAdminQuery` conditionally spreads `staleTime` and `refetchInterval`; `useAdminMutation` toasts by default but permits `toastOnError: false`.

- [ ] **Step 4: Hoist the provider and adapt Library**

Mount `AdminQueryProvider` inside `AdminShell` only after the authenticated checks, wrapping the complete admin chrome and `children`. Remove it from `LibraryPanel`. Change Library's `useAdminQuery.ts` into a thin adapter that reads `{adminFetch, ready}` from `LibraryContext` and calls the generic hook; re-export or import the generic `AdminFetch` type. Move `useQueryErrorToast` from Library `queries.ts` to `web/lib/admin-query.ts` and update imports.

- [ ] **Step 5: Add the strict direct-call audit**

`audit-admin-query.mjs` must recursively scan `web/components/admin/**/*.{ts,tsx}` and fail on `\badminFetch\s*\(`. The only temporary allowlist in Task 1 is `AdminShell.tsx`'s authentication probe; later tasks remove all other matches by routing reads and mutations through `adminJson`, `adminResponse`, or feature request functions.

```js
const allowed = new Map([
  ['AdminShell.tsx', new Set(['authentication-probe'])],
]);
```

Require `// admin-query-imperative: authentication-probe` on the line immediately before that call. The audit must reject unused allowlist entries as well as unclassified calls.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
python3 web/scripts/verify-admin-query.py cache_survives_admin_navigation
node web/scripts/audit-admin-query.mjs --allow-incomplete
npm --prefix web run lint
```

Expected: provider navigation check passes, the incomplete audit prints every remaining direct call for later tasks without exiting nonzero, and web lint exits 0.

Commit:

```bash
git add web docs/superpowers
git commit -m "refactor(web): establish admin query infrastructure"
```

---

### Task 2: Query-backed model and voice discovery, including onboarding

**Files:**
- Create: `web/hooks/discovery-queries.ts`
- Modify: `web/hooks/useModelDiscovery.ts`
- Modify: `web/hooks/useVoiceDiscovery.ts`
- Modify: `web/app/onboarding/layout.tsx`
- Modify: `web/scripts/verify-admin-query.py`
- Modify: `web/scripts/verify-hooks.py`

**Interfaces:**
- Consumes `AdminQueryProvider`, `adminJson`, `useAdminQuery`, and `AdminFetch` from Task 1.
- Produces `discoveryKeys.models(input)` and `discoveryKeys.voices(input)` plus unchanged public hook result shapes `{models|voices, loading, error, refresh}`.

- [ ] **Step 1: Add failing discovery checks**

Add checks that route `/api/settings/llm/models*` and `/api/settings/tts/voices*`, type a four-character base URL burst, and assert: zero calls before 400 ms, one call afterward carrying the full value, a Refresh click makes an immediate call for raw inputs, an older delayed response never replaces a newer provider, and voice options clear immediately on provider switch. Run each sequence once on `/admin/settings` and the LLM sequence once on `/onboarding`.

```python
page.clock.install()
page.goto(f"{WEB}/admin/settings?section=llm", wait_until="domcontentloaded")
box = page.get_by_label("Base URL").first
box.fill("http://model.test/v1")
page.clock.fast_forward(399)
assert len(model_hits) == 0
page.clock.fast_forward(1)
page.wait_for_timeout(0)
assert len(model_hits) == 1 and "model.test" in model_hits[0]
```

- [ ] **Step 2: Run discovery checks and verify RED**

Run:

```bash
python3 web/scripts/verify-admin-query.py discovery_settings_debounce discovery_onboarding_provider discovery_refresh_is_immediate discovery_stale_response_isolated
```

Expected: onboarding provider check fails with no query provider once the test imports the query-backed contract fixture, and query-cache-specific debounce/refresh assertions fail before conversion.

- [ ] **Step 3: Implement query keys and hooks**

Use normalized input objects in keys:

```ts
export const discoveryKeys = {
  all: ['discovery'] as const,
  models: (input: ModelDiscoveryInput) => ['discovery', 'models', input] as const,
  voices: (input: VoiceDiscoveryInput) => ['discovery', 'voices', input] as const,
};
```

Use `useDebounceValue(rawInput, 400)` for automatic keys. Feed TanStack's signal to `adminJson`. Preserve model data during a pending key transition with explicit placeholder data; do not use placeholder data for voices. Implement immediate Refresh by fetching the raw-input key through `queryClient.fetchQuery`, then selecting that key until the debounced value catches up. Return endpoint `{ok:false}` as the existing string error rather than throwing a toast.

- [ ] **Step 4: Scope a provider to onboarding**

Wrap `children` in `AdminQueryProvider` from `web/app/onboarding/layout.tsx`. Do not mount it in the root app layout.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
python3 web/scripts/verify-admin-query.py discovery_settings_debounce discovery_onboarding_provider discovery_refresh_is_immediate discovery_stale_response_isolated
python3 web/scripts/verify-hooks.py
npm --prefix web run lint
```

Expected: all named discovery checks pass, existing hook checks pass, and lint exits 0.

Commit:

```bash
git add web
git commit -m "refactor(web): move discovery hooks onto TanStack Query"
```

---

### Task 3: Dashboard, banners, stats, and debug polling

**Files:**
- Create: `web/components/admin/dash/queries.ts`
- Create: `web/components/admin/debug/queries.ts`
- Create: `web/components/admin/stats-queries.ts`
- Modify: `web/components/admin/DashPanel.tsx`
- Modify: `web/components/admin/dash/TakeoverCard.tsx`
- Modify: `web/components/admin/NavidromeBanner.tsx`
- Modify: `web/components/admin/MusicStarvedBanner.tsx`
- Modify: `web/components/admin/StatsPanel.tsx`
- Modify: `web/components/admin/DebugPanel.tsx`
- Modify: `web/components/admin/debug/LlmCalls.tsx`
- Modify: `web/components/admin/debug/StateTree.tsx`
- Modify: `web/components/admin/debug/SubsonicCalls.tsx`
- Modify: `web/scripts/verify-admin-query.py`

**Interfaces:**
- Produces `dashKeys`, `statsKeys`, and `debugKeys` with prefixes for status, connections, requests, suggestions, system, listeners, audience, state files, LLM calls, and Subsonic calls.
- Mutations invalidate only the status/request/takeover keys affected by the command.

- [ ] **Step 1: Add failing polling and invalidation checks**

Install Playwright's clock before navigation. Assert Dashboard status requests at 3 seconds, connections at 10 seconds, stats at 15 seconds, requests at 5 seconds, and existing banner/takeover cadences. Assert no interval fires while `document.hidden` is emulated. Trigger queue cancellation and assert the requests/status keys refetch without waiting for the next interval. Add Stats and Debug assertions for their current cadences and pause controls.

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
python3 web/scripts/verify-admin-query.py dashboard_poll_cadences dashboard_mutation_refresh stats_pause_and_poll debug_pause_and_poll banner_poll_silence
```

Expected: cache/invalidation assertions fail while panels still own interval IDs and manual state.

- [ ] **Step 3: Convert retained reads and polls**

Keep Dashboard's `/now-playing`, `/state`, and `/session` reads as one query using `Promise.all`. Give connections, stats, requests, and suggestions independent keys. Convert Stats and Debug resources independently so range changes enter their keys and pause controls set `enabled: false`. Use `refetchInterval` functions for dynamic cadences and preserve the last successful data on silent poll failures.

```ts
const statusQuery = useAdminQuery({
  key: dashKeys.status(),
  adminFetch,
  enabled: hydrated && !needsAuth,
  refetchInterval: 3_000,
  request: async (fetcher, signal) => {
    const [nowPlaying, state, session] = await Promise.all([
      adminJson<Partial<DashStatus>>(fetcher, '/now-playing', undefined, signal),
      adminJson<QueueState>(fetcher, '/state', undefined, signal),
      adminJson<{messages?: SessionTurn[]}>(fetcher, '/session', undefined, signal),
    ]);
    return {...nowPlaying, queue: state, sessionMessages: session.messages ?? []};
  },
});
```

- [ ] **Step 4: Convert cache-affecting mutations**

Use `useAdminMutation` for generated suggestions, dashboard actions, queue cancellation, and takeover changes. Keep spoken-action busy keys and error copy unchanged. Invalidate exact affected keys on success; do not refresh `/stats` after a voice-only command.

```ts
const cancelQueueItem = useAdminMutation<ActResponse, string>({
  adminFetch,
  request: (id, fetcher) => adminJson(fetcher, `/dj/queue/${encodeURIComponent(id)}`, {method: 'DELETE'}),
  onDone: async (_data, _id, client) => {
    await Promise.all([
      client.invalidateQueries({queryKey: dashKeys.status()}),
      client.invalidateQueries({queryKey: dashKeys.requests()}),
    ]);
  },
});
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
python3 web/scripts/verify-admin-query.py dashboard_poll_cadences dashboard_mutation_refresh stats_pause_and_poll debug_pause_and_poll banner_poll_silence
node web/scripts/audit-admin-query.mjs --allow-incomplete
npm --prefix web run lint
```

Commit:

```bash
git add web
git commit -m "refactor(web): query admin monitoring surfaces"
```

---

### Task 4: Settings, moods, personas, and imaging cache families

**Files:**
- Create: `web/components/admin/settings/queries.ts`
- Create: `web/components/admin/personas/queries.ts`
- Create: `web/components/admin/imaging/queries.ts`
- Modify: `web/components/admin/SettingsPanel.tsx`
- Modify: `web/components/admin/MoodsPanel.tsx`
- Modify: `web/components/admin/FestivalsSection.tsx`
- Modify: `web/components/admin/GenreSuggest.tsx`
- Modify: `web/components/admin/AiFill.tsx`
- Modify: `web/components/admin/PersonasPanel.tsx`
- Modify: `web/components/admin/personas/SystemPromptModal.tsx`
- Modify: `web/components/admin/imaging/ImagingPanel.tsx`
- Modify: `web/components/admin/settings/LibrarySection.tsx`
- Modify: `web/components/admin/settings/LlmSection.tsx`
- Modify: `web/components/admin/settings/NavidromeSection.tsx`
- Modify: `web/components/admin/settings/ScrobbleSection.tsx`
- Modify: `web/components/admin/settings/SearchSection.tsx`
- Modify: `web/components/admin/settings/ThemeSection.tsx`
- Modify: `web/components/admin/settings/TtsSection.tsx`
- Modify: `web/components/admin/settings/shared.tsx`
- Modify: `web/scripts/verify-admin-query.py`
- Modify: `web/scripts/verify-forms.py`

**Interfaces:**
- Produces `settingsKeys`, `personaKeys`, and `imagingKeys` for settings, community rosters, SFX, beds, voices, and generated suggestions.
- Settings saves write the authoritative returned settings when available and otherwise invalidate `settingsKeys.all`.

- [ ] **Step 1: Add failing cache-consistency checks**

Extend `verify-admin-query.py` to navigate Settings → Moods → Personas → Imaging → Settings and assert one `/settings` request within the 30-second stale window. Save one reversible setting in the isolated stack and assert all mounted consumers observe the new value without duplicate refetch storms. Add create/delete checks for a temporary SFX, bed, and persona fixture with `finally` cleanup.

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py settings_cache_shared settings_save_propagates imaging_mutations_refresh personas_mutations_refresh
```

Expected: shared-cache and targeted-invalidation assertions fail because each panel owns an independent `/settings` load and manual refresh.

- [ ] **Step 3: Convert reads and settings writes**

Make `settingsKeys.detail()` the single key for `/settings` across Settings, Moods, Personas, Imaging, Festivals, and child sections. Derive editable form state once per authoritative query revision without overwriting dirty values during a background refetch. Convert settings saves to mutations and update the shared key with the response or invalidate it when the response omits settings.

```ts
export const settingsKeys = {
  all: ['settings'] as const,
  detail: () => ['settings', 'detail'] as const,
};

const settingsQuery = useAdminQuery<SettingsData>({
  key: settingsKeys.detail(),
  adminFetch,
  enabled: hydrated && !needsAuth,
  request: (fetcher, signal) => adminJson(fetcher, '/settings', undefined, signal),
});
```

- [ ] **Step 4: Convert persona and imaging resources**

Give community personas, SFX, beds, voices, and jingle metadata separate keys. Convert uploads, installs, deletes, avatar changes, and roster saves to mutations with precise invalidation. Keep multipart upload abort controls, per-file progress, field errors, and preview commands imperative through `adminResponse`.

```ts
export const imagingKeys = {
  all: ['imaging'] as const,
  sfx: () => ['imaging', 'sfx'] as const,
  beds: () => ['imaging', 'beds'] as const,
  voices: () => ['imaging', 'voices'] as const,
};

const deleteSfx = useAdminMutation<void, string>({
  adminFetch,
  request: async (name, fetcher) => {
    await adminResponse(fetcher, `/sfx/${encodeURIComponent(name)}`, {method: 'DELETE'});
  },
  onDone: (_data, _name, client) => client.invalidateQueries({queryKey: imagingKeys.sfx()}),
});
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py settings_cache_shared settings_save_propagates imaging_mutations_refresh personas_mutations_refresh
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py stream_buffer festivals moods personas imaging
node web/scripts/audit-admin-query.mjs --allow-incomplete
npm --prefix web run lint
```

Commit:

```bash
git add web
git commit -m "refactor(web): query settings and curation surfaces"
```

---

### Task 5: Shows, schedule, and playlist programming

**Files:**
- Create: `web/components/admin/shows/queries.ts`
- Create: `web/components/admin/schedule/queries.ts`
- Create: `web/components/admin/playlist-builder/queries.ts`
- Modify: `web/components/admin/ShowsPanel.tsx`
- Modify: `web/components/admin/shows/ShowEditor.tsx`
- Modify: `web/components/admin/schedule/SchedulePanel.tsx`
- Modify: `web/components/admin/PlaylistBuilderPanel.tsx`
- Modify: `web/scripts/verify-admin-query.py`
- Modify: `web/scripts/verify-forms.py`
- Modify: `web/scripts/verify-playlist-dnd.py`
- Modify: `web/scripts/verify-schedule-booking.py`

**Interfaces:**
- Produces `showKeys`, `scheduleKeys`, and `playlistKeys` for settings-backed shows, skills, genres, community shows, playlists, playlist detail, and debounced searches.
- Reuses `settingsKeys.detail()` rather than defining a second `/settings` key.

- [ ] **Step 1: Add failing programming checks**

Add network assertions that Shows and Schedule reuse cached settings, the three Playlist Builder searches deduplicate by full debounced key, opening an existing playlist caches its detail, sync invalidates only that detail and the playlist index, installing a community show refreshes Shows, and schedule save updates the override key immediately.

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py shows_cache_reuse show_install_refresh schedule_save_refresh playlist_search_dedup playlist_sync_refresh
```

Expected: query reuse and mutation invalidation assertions fail against manual effects and callbacks.

- [ ] **Step 3: Convert reads, searches, and detail loads**

Use separate keys for skills, genres, community shows, playlist index, playlist detail, and each debounced search purpose (`seed`, `add`, `artist`) so identical text in different controls cannot share incompatible normalized data. Keep Shows' `/settings` response normalization in the query function. Treat an unsaved local show as local form state, not cached server data.

```ts
export const playlistKeys = {
  all: ['playlists'] as const,
  index: () => ['playlists', 'index'] as const,
  detail: (id: string) => ['playlists', 'detail', id] as const,
  search: (purpose: 'seed' | 'add' | 'artist', term: string) =>
    ['playlists', 'search', purpose, term] as const,
};
```

- [ ] **Step 4: Convert programming mutations**

Convert show save/delete/install, schedule override save, playlist save/delete/sync, and any cache-affecting editor action to mutations. Write authoritative returned arrays directly; otherwise invalidate the exact family. Preserve drag state, unsaved recipes, save-mode validation, and scheduler booking toasts.

```ts
const syncPlaylist = useAdminMutation<SyncResult, string>({
  adminFetch,
  request: (id, fetcher) => adminJson(fetcher, `/playlists/${encodeURIComponent(id)}/sync`, {method: 'POST'}),
  onDone: async (_result, id, client) => {
    await Promise.all([
      client.invalidateQueries({queryKey: playlistKeys.index()}),
      client.invalidateQueries({queryKey: playlistKeys.detail(id)}),
    ]);
  },
});
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py shows_cache_reuse show_install_refresh schedule_save_refresh playlist_search_dedup playlist_sync_refresh
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py shows schedule playlists
python3 web/scripts/verify-playlist-dnd.py
python3 web/scripts/verify-schedule-booking.py
node web/scripts/audit-admin-query.mjs --allow-incomplete
npm --prefix web run lint
```

Commit:

```bash
git add web
git commit -m "refactor(web): query programming surfaces"
```

---

### Task 6: Skills, Connect, and Doctor workflows

**Files:**
- Create: `web/components/admin/skills/queries.ts`
- Create: `web/components/admin/connect/queries.ts`
- Create: `web/components/admin/doctor-queries.ts`
- Modify: `web/components/admin/SkillsPanel.tsx`
- Modify: `web/components/admin/skills/SkillEditModal.tsx`
- Modify: `web/components/admin/connect/ConnectPanel.tsx`
- Modify: `web/components/admin/connect/Playground.tsx`
- Modify: `web/components/admin/DoctorPanel.tsx`
- Modify: `web/scripts/verify-admin-query.py`
- Modify: `web/scripts/verify-forms.py`

**Interfaces:**
- Produces `skillKeys`, `connectKeys`, and `doctorKeys` for installed/community skills, roster settings, integration metadata, and last doctor report.
- Keeps Doctor SSE and one-shot diagnosis streams imperative while caching the last completed report.

- [ ] **Step 1: Add failing workflow checks**

Add checks for installed/community skill cache reuse, toggle/rescan/import/install invalidation, Connect metadata reuse after tab changes, and Doctor's last-report cache update after batch fallback, review, and fixes. Assert opening an SSE diagnosis creates exactly one stream and never retries it.

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py skills_mutations_refresh connect_cache_reuse doctor_report_updates doctor_stream_not_retried
```

Expected: cache update assertions fail while each workflow manually reloads or patches component state.

- [ ] **Step 3: Convert cache resources and mutations**

Convert installed/community skill lists, roster settings, Connect metadata, and `/doctor/last` to queries. Convert skill toggle/rescan/edit/import/install and doctor review/fix commands to mutations with exact invalidation. Keep playground sends, credential tests, batch diagnosis, and SSE stream reads imperative via `adminResponse`; after a completed diagnosis, write the returned report into `doctorKeys.last()`.

```ts
export const doctorKeys = {
  all: ['doctor'] as const,
  last: () => ['doctor', 'last'] as const,
};

const finishReport = (client: QueryClient, report: DoctorReport, review: DoctorReview | null) => {
  client.setQueryData(doctorKeys.last(), {report, review});
};
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py skills_mutations_refresh connect_cache_reuse doctor_report_updates doctor_stream_not_retried
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py skills
node web/scripts/audit-admin-query.mjs --allow-incomplete
npm --prefix web run lint
```

Commit:

```bash
git add web
git commit -m "refactor(web): query admin extension workflows"
```

---

### Task 7: Stations, webhooks, archives, backup, and remaining admin resources

**Files:**
- Create: `web/components/admin/operations-queries.ts`
- Modify: `web/components/admin/StationsPanel.tsx`
- Modify: `web/components/admin/StationSwitcher.tsx`
- Modify: `web/components/admin/WebhooksPanel.tsx`
- Modify: `web/components/admin/ArchivesPanel.tsx`
- Modify: `web/components/admin/BackupPanel.tsx`
- Modify: `web/components/admin/LibraryTaggingModal.tsx`
- Modify: `web/components/admin/LibraryTaggingPanel.tsx`
- Modify: `web/components/admin/library/BlockRulesCard.tsx`
- Modify: `web/components/admin/library/tabs/SearchTab.tsx`
- Modify: `web/scripts/verify-admin-query.py`
- Modify: `web/scripts/verify-query-cache.py`

**Interfaces:**
- Produces `operationKeys.stations()`, `operationKeys.webhooks()`, `operationKeys.archives()`, and `operationKeys.restorableBackups()`.
- Leaves archive/backup downloads and mixer restart commands imperative while cached indexes use queries.

- [ ] **Step 1: Add failing operational checks**

Add reversible checks for station create/rename/delete list updates, webhook save/delete updates, archive-clear invalidation, restorable-backup index refresh after import selection, and Library block/tag actions still patching all three supported cache shapes. Repeat the 401 no-retry check from Task 1 against converted Stations.

- [ ] **Step 2: Run focused checks and verify RED**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py stations_mutations_refresh webhooks_mutations_refresh archives_clear_refresh backup_index_refresh unauthorised_query_is_not_retried
python3 web/scripts/verify-query-cache.py
```

Expected: operational invalidation assertions fail before conversion; existing Library cache checks must remain green and establish the regression baseline.

- [ ] **Step 3: Convert operational resources**

Move station list, webhook list, archive list, and restorable backup list into queries. Convert their cache-affecting writes to mutations. Keep station activation/process exit semantics, webhook test delivery, file downloads, backup export/import streams, and restart commands imperative. Use returned list data where authoritative and invalidate only the owning key otherwise.

```ts
export const operationKeys = {
  stations: () => ['operations', 'stations'] as const,
  webhooks: () => ['operations', 'webhooks'] as const,
  archives: () => ['operations', 'archives'] as const,
  restorableBackups: () => ['operations', 'restorable-backups'] as const,
};
```

- [ ] **Step 4: Finish Library adaptation**

Remove any direct `adminFetch(...)` calls remaining in Library components by routing them through `adminJson`, `adminResponse`, or Library's mutation adapter. Preserve `libraryKeys.rows`, bare/paged/infinite cache patching, optimistic like rollback, tag membership invalidation, and silent Library polls.

```ts
const r = await adminJson<SearchResponse>(fetcher, path, undefined, signal);
return {rows: r.results ?? [], nextCursor: r.nextCursor ?? null};
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-admin-query.py stations_mutations_refresh webhooks_mutations_refresh archives_clear_refresh backup_index_refresh unauthorised_query_is_not_retried
python3 web/scripts/verify-query-cache.py
python3 web/scripts/verify-library.py
node web/scripts/audit-admin-query.mjs
npm --prefix web run lint
```

Expected: the strict audit exits 0 with only the annotated `AdminShell` authentication probe; all focused checks and lint exit 0.

Commit:

```bash
git add web
git commit -m "refactor(web): query remaining admin resources"
```

---

### Task 8: Full verification, documentation, and pull request

**Files:**
- Modify: `web/CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-08-23-admin-tanstack-query.md`
- Inspect: every file reported by `rg -n '\badminFetch\s*\(' web/components/admin`

**Interfaces:**
- Consumes all query families and verification scripts from Tasks 1–7.
- Produces a clean branch pushed to `origin/refactor/admin-tanstack-query-1368` and one PR against `develop` closing #1368.

- [x] **Step 1: Perform the requirement audit**

Run:

```bash
rg -n '\badminFetch\s*\(' web/components/admin
node web/scripts/audit-admin-query.mjs
rg -n 'setInterval|pollWhileVisible' web/components/admin
```

For every result, verify it is the annotated authentication probe, browser-only timing, or a one-shot command. Any retained server read or poll is a failed completion criterion and must be converted with a failing browser check first.

- [x] **Step 2: Update scoped documentation**

Change `web/CLAUDE.md` from “Library page only” to the shell-level provider contract. Document generic query helpers, feature key factories, sign-out cache destruction, onboarding's scoped provider, exact default options, explicit error toast rule, and the direct-call audit command.

- [x] **Step 3: Run the complete isolated browser verification**

After using the repository `verify` skill to start the isolated controller and web server on `:7791` and `:7793`, run:

```bash
python3 web/scripts/verify-admin-query.py
python3 web/scripts/verify-query-cache.py
python3 web/scripts/verify-library.py
python3 web/scripts/verify-hooks.py
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py
python3 web/scripts/verify-playlist-dnd.py
python3 web/scripts/verify-schedule-booking.py
```

Expected: every script reports zero failed checks and exits 0.

- [x] **Step 4: Run merge-gate and production-build verification**

Run:

```bash
node web/scripts/audit-admin-query.mjs
npm --prefix web run lint
npm --prefix web run build
git diff --check origin/develop...HEAD
git status --short
```

Expected: audit, lint, build, and diff check exit 0; status contains only the intended plan checkbox update if it has not yet been committed.

Local completion result (2026-08-23): the strengthened TypeScript AST audit
passed with zero unclassified cacheable component reads; `rg` found zero direct
`adminFetch(...)` calls, and the three remaining intervals are browser-only
display/expiry clocks. Review fixes added a shared same-tab/cross-tab auth store
with page-owned 401 teardown coverage, one exact abort-aware
`['themes','admin']` query shared across Shows and Settings, and controlled-clock
399/400ms debounce checks (an intentional 600ms mutation made all three fail).
The isolated browser suites passed 52/52 admin-query, 6/6 query-cache, 8/8
Library, 22/22 hooks, 13/13 destructive forms, all playlist DnD checks, and all
nine schedule-booking checks. Web lint exited 0 with the five baseline warnings
recorded in the SDD ledger, the production build exited 0, and both branch and
working-tree whitespace checks exited 0. Steps 6–8 remain unchecked because
rebase, push, and PR delivery are intentionally delegated to the final delivery
stage.

Review round 2 closed three further ownership gaps. Credential changes now key
the shell provider, and a stale 401 can clear only its still-current token. Theme
mutation receipts no longer preserve an old `active`: every write performs one
authoritative exact-key GET that remains abort-aware and survives Settings
rerenders, while a Settings default change refreshes the same entry before Shows
can reuse it. The audit has no query-filename exemption; it resolves renamed and
transitive aliases, covers member fetch calls, validates exact ownership markers,
and requires every imperative allowlist entry to match callee, method, and path.
Focused RED checks caught all three prior behaviours, and the fresh complete local
matrix above passed with the admin total increased to 52.

Review round 3 hardened the remaining scheduling and reconciliation edges.
Authenticated 401 handling now consults `localStorage` before the external-store
snapshot and re-checks the captured value immediately before removal, so a B
request rejected after another tab has stored C cannot erase C even before the C
storage event is delivered; storage-denied sessions deliberately retain the
matching in-memory fallback. A failed theme save now awaits public-provider
rollback, while a committed save followed by a failed authoritative admin GET
drops the exact admin cache, catches and reports that error, and awaits public
provider reconciliation. Query-owned comments no longer authorize anything:
shared helpers use an exact structural registry binding exported function,
callee/method/path, forwarded signal parameter, and real query consumer. Fresh
focused checks passed, the strict audit self-tests passed, and the complete
isolated matrix passed with the admin total increased to 53; query-cache 6/6,
Library 8/8, hooks 22/22, destructive forms 13/13, playlist DnD all checks, and
schedule booking 9/9 also passed.

Review round 4 made helper ownership and theme write reconciliation end to end.
Registry consumers now count only an exact helper callback or an actual helper
call inside the declared request/query function; they prove that callback's
TanStack `AbortSignal` reaches the helper's registered parameter position and
reject decoy references, replacement/manual signals, wrong positions, and any
helper invocation outside a declared consumer. The standalone Node audit suite
now uses an isolated registry, expects current diagnostics, and passes 7/7.
Create/edit, refresh, delete, and Settings choose all share one committed-write
reconciler: a failed authoritative GET removes exact stale admin state, awaits
the public provider, and reports that the write succeeded but refresh failed.
Focused auth/themes/audit/debounce checks passed 10/10. The fresh complete
isolated matrix passed admin-query 54/54, query-cache 6/6, Library 8/8, hooks
22/22, destructive forms 13/13, playlist DnD all checks, and schedule booking
9/9.

Review round 5 closed the final two Important gaps. When deleting an active or
show-pinned theme, a failed authoritative GET now retains DELETE's safe theme
list, persists a remaining id through the secure settings mutation before the
public provider refresh, cancels an observer refetch race, and caches only that
receipt plus the persisted fallback. The audit no longer recursively accepts a
matching property below query options: ordinary query owners use only their
direct request/queryFn, while `useQueries` uses only direct `queries` entries
and each entry's direct queryFn. RED checks caught both old behaviours. Focused
checks passed 12/12, the standalone audit passed 9/9, and the fresh complete
neutral matrix passed admin-query 54/54, query-cache 6/6, Library 8/8, hooks
22/22, destructive forms 13/13, playlist DnD all checks, and schedule booking
9/9; strict audit, lint, and the 33-page production build also passed.

- [x] **Step 5: Commit final documentation and verification fixes**

```bash
git add web docs/superpowers
git commit -m "docs(web): document admin query ownership"

# Review round 2 follow-up
git add web docs/superpowers
git commit -m "fix(web): close admin ownership races"

# Review round 3 follow-up
git add web docs/superpowers
git commit -m "fix(web): harden credential and theme reconciliation"

# Review round 4 follow-up
git add web docs/superpowers
git commit -m "fix(web): prove query ownership end to end"

# Review round 5 follow-up
git add web docs/superpowers
git commit -m "fix(web): finalize theme fallback ownership"
```

- [ ] **Step 6: Rebase and re-run risk-proportionate checks**

```bash
git fetch --prune origin
git rebase origin/develop
node web/scripts/audit-admin-query.mjs
npm --prefix web run lint
npm --prefix web run build
git diff --check origin/develop...HEAD
```

Expected: rebase succeeds and every fresh verification command exits 0.

- [ ] **Step 7: Push the branch and open the PR**

```bash
git push -u origin refactor/admin-tanstack-query-1368
gh pr create --repo perminder-klair/subwave --base develop --head refactor/admin-tanstack-query-1368 --title "refactor(web): extend TanStack Query across admin" --body-file /tmp/subwave-1368-pr.md
```

The PR body must contain:

```markdown
Closes #1368.

## What changed
- hoists the admin QueryClient to the authenticated shell and scopes one to onboarding
- converts retained admin reads and polls to feature-keyed TanStack queries
- converts cache-affecting writes to mutations with targeted updates or invalidation
- preserves one-shot commands as imperative actions and adds a direct-call audit

## Verification
- `python3 web/scripts/verify-admin-query.py`
- `python3 web/scripts/verify-query-cache.py`
- `python3 web/scripts/verify-library.py`
- `python3 web/scripts/verify-hooks.py`
- `SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py`
- `python3 web/scripts/verify-playlist-dnd.py`
- `python3 web/scripts/verify-schedule-booking.py`
- `npm run lint`
- `npm run build`
- `git diff --check origin/develop...HEAD`
```

- [ ] **Step 8: Verify remote PR state**

```bash
gh pr view --repo perminder-klair/subwave --json number,url,state,baseRefName,headRefName,mergeable,commits
gh pr checks --repo perminder-klair/subwave --watch
```

Expected: PR is open against `develop`, head branch is `refactor/admin-tanstack-query-1368`, and all required checks finish successfully. Report any pending or unavailable check as such rather than calling the PR fully green.
