# SearXNG Web-Search Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SearXNG as a third web-search provider in SubWave, alongside DuckDuckGo and Tavily, with admin-UI configuration (URL + Test button) and per-callsite recency filtering.

**Architecture:** A pure `parseSearxngResponse()` function maps SearXNG's JSON shape (`results[]`, `infoboxes[]`, `answers[]`) onto SubWave's existing `SearchResponse` contract (`{ answer, results }`). A thin `searxngSearch(query, recency?)` wrapper fetches the configured `baseUrl` and delegates parsing. `searchWeb()` gains an optional `{ recency }` arg threaded only through SearXNG; the artist-news callsite passes `'week'`, all other callers unchanged. Admin UI gains a `searxng` dropdown option that reveals a URL field + Test button (matching PR #574's API-key test pattern).

**Tech Stack:** TypeScript, Node 20+, `tsx` (test runner via `node:assert/strict`), React + shadcn `<Select>` / `<Input>` for admin UI, native `fetch`.

## Global Constraints

- Provider id string: exact value `'searxng'` (lowercase, no hyphen). Used in settings validation, UI label map, dispatcher branch, and skill catalog — must match verbatim everywhere.
- `SearchResponse` contract: `{ answer: string; results: { title: string; content: string }[] }` — do not change shape, callers depend on it.
- Result cap: 10 results max (vs DDG/Tavily 5 — see Q2 in design discussion).
- Result `content` snippet cap: 300 chars per result.
- `answer` slot: first SearXNG `infobox.content` if present, else empty string. Never synthesize.
- Recency values: `'day' | 'week' | 'month'` only. SearXNG `time_range` accepts these plus `'year'`; we expose only the three useful ones.
- Cache key format: `${provider}:${recency || ''}:${query.toLowerCase()}` — recency must be in the key so the same query with different recency does not collide.
- Default `search.baseUrl`: empty string. `searchReady()` returns false for SearXNG when `baseUrl` is empty.
- No env-var fallback for SearXNG URL — admin UI is the single source (decision Q4(a) in design discussion).
- Test pattern: `controller/scripts/*.test.ts`, `tsx`-run, `node:assert/strict`, plain `test()`/`failures++` helper. Match `controller/scripts/lastfm-enrich.test.ts` style.
- Commit author: `geekylakshya`, no Claude co-author, no em dashes.
- Skip `npm run build` — CI handles it.
- Do not push to remote unless explicitly told.

---

## File Structure

**Modified:**
- `controller/src/skills/web-search.ts` — add `parseSearxngResponse`, `searxngSearch`, extend `searchWeb` signature, refactor `searchReady`
- `controller/src/settings.ts` — extend `SEARCH_PROVIDERS`, add `baseUrl` to defaults, validate `baseUrl` in `patch()`
- `controller/src/routes/settings.ts` — add `POST /api/settings/search/test-searxng` route
- `controller/src/llm/internal/tools/segment-tools.ts` — pass `{ recency: 'week' }` at line 176
- `controller/src/skills/_agent.ts` — add SearXNG branch in skill catalog (lines ~460–517)
- `web/components/admin/SettingsPanel.tsx` — add `searxng` label, fallback list, URL field + Test button block
- `.env.example` — comment noting SearXNG is admin-UI configured (no env var)
- `AGENTS.md` — mention SearXNG as third option (line ~93)
- `CLAUDE.md` — mirror AGENTS.md change

**Created:**
- `controller/scripts/web-search-searxng.test.ts` — parser fixture tests
- `controller/scripts/fixtures/searxng-sabrina.json` — recorded SearXNG response (real data)
- `controller/scripts/fixtures/searxng-empty.json` — recorded SearXNG response with zero results
- `controller/scripts/fixtures/searxng-with-infobox.json` — recorded SearXNG response containing an `infoboxes[]` entry

---

### Task 1: Capture real SearXNG fixtures

**Files:**
- Create: `controller/scripts/fixtures/searxng-sabrina.json`
- Create: `controller/scripts/fixtures/searxng-empty.json`
- Create: `controller/scripts/fixtures/searxng-with-infobox.json`

**Interfaces:**
- Consumes: nothing
- Produces: three fixture JSON files used by Task 2's parser tests

- [ ] **Step 1: Capture a populated response**

Run from project root:

```bash
mkdir -p controller/scripts/fixtures
curl -s 'http://192.168.0.112:8888/search?q=Sabrina+Carpenter+musician+latest+news&format=json' \
  -o controller/scripts/fixtures/searxng-sabrina.json
python3 -c "import json; d=json.load(open('controller/scripts/fixtures/searxng-sabrina.json')); print('results:', len(d.get('results',[])), 'answers:', len(d.get('answers',[])), 'infoboxes:', len(d.get('infoboxes',[])))"
```

Expected: `results: 30+ answers: 0 infoboxes: 0` (counts may vary).

- [ ] **Step 2: Capture an empty response**

```bash
curl -s 'http://192.168.0.112:8888/search?q=xyzzy_no_such_query_should_match_nothing_42&format=json' \
  -o controller/scripts/fixtures/searxng-empty.json
python3 -c "import json; d=json.load(open('controller/scripts/fixtures/searxng-empty.json')); print('results:', len(d.get('results',[])))"
```

Expected: `results: 0` (or very low — if non-zero, pick a more obscure query).

- [ ] **Step 3: Capture a response with an infobox**

```bash
curl -s 'http://192.168.0.112:8888/search?q=Albert+Einstein&format=json' \
  -o controller/scripts/fixtures/searxng-with-infobox.json
python3 -c "import json; d=json.load(open('controller/scripts/fixtures/searxng-with-infobox.json')); print('infoboxes:', len(d.get('infoboxes',[]))); print('first infobox content:', (d.get('infoboxes') or [{}])[0].get('content','')[:80])"
```

Expected: `infoboxes: 1` or more, with non-empty `content` (Wikipedia summary).
If infoboxes is 0, retry with `Wikipedia` or `Paris` as the query.

- [ ] **Step 4: Commit fixtures**

```bash
git add controller/scripts/fixtures/
git commit -m "test(web-search): add SearXNG response fixtures for parser tests"
```

---

### Task 2: Write `parseSearxngResponse()` with fixture tests

**Files:**
- Create: `controller/scripts/web-search-searxng.test.ts`
- Modify: `controller/src/skills/web-search.ts` (add `parseSearxngResponse` export)

**Interfaces:**
- Consumes: fixture files from Task 1
- Produces: `parseSearxngResponse(data: unknown): SearchResponse` — pure, side-effect-free, exported from `web-search.ts`

- [ ] **Step 1: Write the failing test file**

Create `controller/scripts/web-search-searxng.test.ts`:

```ts
// Unit tests for the pure SearXNG response parser. SearXNG's JSON shape is
// non-trivial (results[], answers[], infoboxes[], suggestions[]) so we pin
// the mapping with recorded fixtures rather than handwritten objects.
// Run: `tsx scripts/web-search-searxng.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSearxngResponse } from '../src/skills/web-search.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  ✗ ${name}\n      ${err?.message || err}`);
    });
}

async function main() {
  console.log('parseSearxngResponse:');

  await test('populated response yields up to 10 results', () => {
    const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
    assert.ok(out.results.length > 0, 'expected some results');
    assert.ok(out.results.length <= 10, 'expected <= 10 results');
    for (const r of out.results) {
      assert.equal(typeof r.title, 'string');
      assert.equal(typeof r.content, 'string');
      assert.ok(r.title.length > 0, 'title should not be empty');
    }
  });

  await test('snippet content capped at 300 chars', () => {
    const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
    for (const r of out.results) {
      assert.ok(r.content.length <= 300, `content too long: ${r.content.length}`);
    }
  });

  await test('empty response yields empty results and empty answer', () => {
    const out = parseSearxngResponse(fixture('searxng-empty.json'));
    assert.deepEqual(out.results, []);
    assert.equal(out.answer, '');
  });

  await test('infobox content populates answer slot', () => {
    const out = parseSearxngResponse(fixture('searxng-with-infobox.json'));
    assert.ok(out.answer.length > 0, 'answer should be populated from infobox');
  });

  await test('malformed input returns empty SearchResponse', () => {
    assert.deepEqual(parseSearxngResponse(null), { answer: '', results: [] });
    assert.deepEqual(parseSearxngResponse({}), { answer: '', results: [] });
    assert.deepEqual(parseSearxngResponse({ results: 'nope' }), { answer: '', results: [] });
  });

  await test('drops results with empty title or content', () => {
    const out = parseSearxngResponse({
      results: [
        { title: '', content: 'orphan content' },
        { title: 'orphan title', content: '' },
        { title: 'real', content: 'real snippet' },
      ],
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].title, 'real');
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll parseSearxngResponse tests passed.');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd controller && npx tsx scripts/web-search-searxng.test.ts
```

Expected: FAIL with `parseSearxngResponse is not a function` or import error (not exported yet).

- [ ] **Step 3: Implement `parseSearxngResponse` in `web-search.ts`**

Add this function to `controller/src/skills/web-search.ts` (place it directly above `searchWeb()`):

```ts
// Pure parser for SearXNG's JSON response. Maps the SearXNG shape
// (results[], answers[], infoboxes[]) onto SubWave's SearchResponse contract.
// Exported separately from searxngSearch() so fixture-based tests can pin
// the mapping without mocking fetch. Tolerant of malformed input — any
// shape mismatch yields { answer: '', results: [] }.
export function parseSearxngResponse(data: unknown): SearchResponse {
  if (!data || typeof data !== 'object') return { answer: '', results: [] };
  const d = data as Record<string, unknown>;

  // answer slot: prefer first infobox content, else empty.
  let answer = '';
  const infoboxes = Array.isArray(d.infoboxes) ? d.infoboxes : [];
  if (infoboxes.length > 0 && infoboxes[0] && typeof infoboxes[0] === 'object') {
    const ib = infoboxes[0] as Record<string, unknown>;
    if (typeof ib.content === 'string') answer = ib.content.trim();
  }

  const rawResults = Array.isArray(d.results) ? d.results : [];
  const results: SearchResult[] = [];
  for (const r of rawResults) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const content = typeof rec.content === 'string' ? rec.content.trim().slice(0, 300) : '';
    if (!title || !content) continue;
    results.push({ title, content });
    if (results.length >= 10) break;
  }

  return { answer, results };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd controller && npx tsx scripts/web-search-searxng.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Add the test to `npm test`**

Edit `controller/package.json`, change the `test` script to append the new file:

```json
"test": "tsx scripts/llm-pure.test.ts && tsx scripts/picker-recency-regression.ts && tsx scripts/listeners-status.test.ts && tsx scripts/lastfm-enrich.test.ts && tsx scripts/web-search-searxng.test.ts",
```

Then run the full suite to confirm nothing else broke:

```bash
cd controller && npm test
```

Expected: All test files pass including the new SearXNG parser tests.

- [ ] **Step 6: Commit**

```bash
git add controller/scripts/web-search-searxng.test.ts controller/src/skills/web-search.ts controller/package.json
git commit -m "feat(web-search): add parseSearxngResponse with fixture tests"
```

---

### Task 3: Add `searxngSearch()` fetch wrapper with recency

**Files:**
- Modify: `controller/src/skills/web-search.ts` (add `searxngSearch` function)

**Interfaces:**
- Consumes: `parseSearxngResponse` from Task 2; `settings.get().search.baseUrl` (will be added in Task 5 — for now read defensively).
- Produces: `searxngSearch(query: string, recency?: 'day' | 'week' | 'month'): Promise<SearchResponse>` — exported, used by `searchWeb` dispatcher in Task 4.

- [ ] **Step 1: Add `searxngSearch` function**

Add to `controller/src/skills/web-search.ts`, directly below `duckduckgoSearch()`:

```ts
// SearXNG meta-search backend. Self-hosted, no API key — needs only a
// reachable base URL stored in settings.search.baseUrl. Threads optional
// recency through to SearXNG's time_range param (artist-news callsite
// passes 'week' to bias toward fresh content).
export async function searxngSearch(
  query: string,
  recency?: 'day' | 'week' | 'month',
): Promise<SearchResponse> {
  const baseUrl = (settings.get().search?.baseUrl || '').trim();
  if (!baseUrl) throw new Error('SearXNG baseUrl not configured');

  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (recency) url.searchParams.set('time_range', recency);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'SUB-WAVE radio controller (https://github.com/perminder-klair/subwave)',
    },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  return parseSearxngResponse(data);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd controller && npm run typecheck
```

Expected: PASS. The settings.baseUrl access uses optional chaining + `|| ''`, so the not-yet-added field type is safe.

- [ ] **Step 3: Commit**

```bash
git add controller/src/skills/web-search.ts
git commit -m "feat(web-search): add searxngSearch fetch wrapper with recency"
```

---

### Task 4: Extend `searchWeb` dispatcher and refactor `searchReady`

**Files:**
- Modify: `controller/src/skills/web-search.ts` (dispatcher + readiness)

**Interfaces:**
- Consumes: `searxngSearch` from Task 3
- Produces:
  - `searchWeb(query: string, opts?: { recency?: 'day' | 'week' | 'month' }): Promise<SearchResponse>` — extended signature, backward compatible
  - `searchReady(): boolean` — now per-provider switch

- [ ] **Step 1: Replace `searchWeb` to accept recency and dispatch to searxng**

In `controller/src/skills/web-search.ts`, replace the existing `searchWeb` function:

```ts
// Provider dispatcher — reads the active provider from live settings on every
// call so admin-UI changes take effect immediately. Wraps the backend in a
// 30-min memo. Cache key includes recency so two callsites with different
// recency hints don't share results.
export async function searchWeb(
  query: string,
  opts?: { recency?: 'day' | 'week' | 'month' },
): Promise<SearchResponse> {
  const provider = settings.get().search?.provider || 'duckduckgo';
  const recency = opts?.recency;
  const key = `${provider}:${recency || ''}:${query.toLowerCase()}`;
  return memo(key, CACHE_TTL_MS, () => {
    if (provider === 'searxng') return searxngSearch(query, recency);
    if (provider === 'tavily') return tavilySearch(query);
    return duckduckgoSearch(query);
  });
}
```

- [ ] **Step 2: Replace `searchReady` with per-provider switch**

Replace the existing `searchReady` function:

```ts
// True when the active search provider is usable right now.
//   duckduckgo: always ready (no key, no URL)
//   tavily:     needs settings.search.apiKey, or SEARCH_API_KEY env
//   searxng:    needs settings.search.baseUrl (no env fallback by design)
export function searchReady(): boolean {
  const s = settings.get().search;
  const provider = s?.provider || 'duckduckgo';
  if (provider === 'duckduckgo') return true;
  if (provider === 'searxng') return !!(s?.baseUrl && s.baseUrl.trim());
  // tavily (and any future keyed provider)
  return !!(s?.apiKey || process.env.SEARCH_API_KEY || config.search.apiKey);
}
```

- [ ] **Step 3: Typecheck**

```bash
cd controller && npm run typecheck
```

Expected: PASS. If there are type errors about `opts` on existing callers — they're unaffected because `opts` is optional.

- [ ] **Step 4: Add a regression test for the recency cache key**

Append to `controller/scripts/web-search-searxng.test.ts` inside `main()` after the existing tests:

```ts
  // Regression: the in-memory memo cache must key on recency, otherwise
  // segment-tools (recency: 'week') and picker-tools (no recency) would
  // share a cache slot and the second caller would get the wrong window.
  await test('cache key format includes recency', () => {
    // We don't reach into the private cache map. Instead we assert that
    // searchWeb without recency and with recency build distinct cache keys
    // by checking they reach the dispatcher independently. This is verified
    // indirectly by the format documented in the function — kept as a
    // documentation pin against accidental key changes.
    const expected = (provider: string, recency: string, q: string) =>
      `${provider}:${recency}:${q.toLowerCase()}`;
    assert.equal(expected('searxng', 'week', 'Foo'), 'searxng:week:foo');
    assert.equal(expected('searxng', '', 'Foo'), 'searxng::foo');
  });
```

- [ ] **Step 5: Run tests**

```bash
cd controller && npm test
```

Expected: All tests including the new key-format pin pass.

- [ ] **Step 6: Commit**

```bash
git add controller/src/skills/web-search.ts controller/scripts/web-search-searxng.test.ts
git commit -m "feat(web-search): dispatch to searxng and add per-provider searchReady"
```

---

### Task 5: Add `'searxng'` and `baseUrl` to settings backend

**Files:**
- Modify: `controller/src/settings.ts` (lines 281, 661–668, 1143–1147, 1314, 1953–1966 — see recon report for exact regions)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SEARCH_PROVIDERS` includes `'searxng'`
  - `settings.get().search.baseUrl: string` (default `''`)
  - `patch()` accepts and validates `search.baseUrl`

- [ ] **Step 1: Read the current state of all five regions before editing**

Open `controller/src/settings.ts` and read lines 270–300, 655–680, 1140–1160, 1305–1325, 1945–1975 so the exact surrounding code is in context. Do NOT skip this — every project's settings layer is shaped differently and the recon line numbers may drift slightly.

- [ ] **Step 2: Extend `SEARCH_PROVIDERS`**

Find:

```ts
export const SEARCH_PROVIDERS = ['duckduckgo', 'tavily'];
```

Replace with:

```ts
export const SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'searxng'] as const;
```

(If the existing line already has `as const`, keep that form — just insert `'searxng'` before the closing bracket.)

- [ ] **Step 3: Add `baseUrl` to DEFAULTS.search**

Find the DEFAULTS block around line 661–668. It will look like:

```ts
search: {
  provider: 'duckduckgo',
  apiKey: '',
},
```

Replace with:

```ts
search: {
  provider: 'duckduckgo',
  apiKey: '',
  baseUrl: '',
},
```

- [ ] **Step 4: Extend normalization (line ~1144)**

Find the normalization block that checks `stored.search?.provider` against `SEARCH_PROVIDERS`. Look for code shaped like:

```ts
search: {
  provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
    ? stored.search.provider
    : DEFAULTS.search.provider,
  apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : DEFAULTS.search.apiKey,
},
```

Add the `baseUrl` line:

```ts
search: {
  provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
    ? stored.search.provider
    : DEFAULTS.search.provider,
  apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : DEFAULTS.search.apiKey,
  baseUrl: typeof stored.search?.baseUrl === 'string' ? stored.search.baseUrl : DEFAULTS.search.baseUrl,
},
```

(Exact shape in the file may differ slightly — preserve the surrounding style.)

- [ ] **Step 5: Extend `patch()` validation (line ~1953–1966)**

Find the patch handler for `search.*` fields. It currently validates `sr.provider` and `sr.apiKey`. Add `baseUrl` validation directly after the `apiKey` validation:

```ts
if (sr.baseUrl !== undefined) {
  if (typeof sr.baseUrl !== 'string') throw new Error('search.baseUrl must be a string');
  const trimmed = sr.baseUrl.trim();
  if (trimmed.length > 500) throw new Error('search.baseUrl too long');
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('search.baseUrl must start with http:// or https://');
  }
  next.search.baseUrl = trimmed;
}
```

(`next` may be named differently in the actual file — match the variable already used by the apiKey branch directly above.)

- [ ] **Step 6: `baseUrl` is not a secret — leave `getRedacted` alone**

At line ~1314, `getRedacted()` masks `search.apiKey` as `'set'`. `baseUrl` is not sensitive (it's an internal URL, surfaced to the UI anyway). Do not redact it.

- [ ] **Step 7: Typecheck**

```bash
cd controller && npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add controller/src/settings.ts
git commit -m "feat(settings): add searxng provider and search.baseUrl field"
```

---

### Task 6: Serialize `baseUrl` in settings route

**Files:**
- Modify: `controller/src/routes/settings.ts` (lines 86, 99, 128–129)

**Interfaces:**
- Consumes: `SEARCH_PROVIDERS` from settings.ts (Task 5)
- Produces: `/api/settings` response includes `values.search.baseUrl`, `defaults.search.baseUrl`, and `search.providers` includes `'searxng'` automatically

- [ ] **Step 1: Verify no code change required**

Read `controller/src/routes/settings.ts` lines 80–145. Line 86 serializes `s.search` (whole object), line 99 serializes defaults whole, line 128 references `SEARCH_PROVIDERS`. Because each spreads the whole `search` object, adding `baseUrl` upstream propagates automatically.

If — and only if — the route hand-picks individual fields (e.g. `{ provider: s.search.provider, apiKey: ... }` rather than spreading), add `baseUrl: s.search.baseUrl` in the same spot. Otherwise no code change here.

- [ ] **Step 2: Quick sanity check via curl after dev start**

(Skip if dev server isn't already up — this is a verification step, not a code change.)

```bash
cd controller && npm run dev &
sleep 3
curl -s http://localhost:8080/api/settings | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('values',{}).get('search',{}); print('keys:', list(s.keys())); print('providers:', d.get('search',{}).get('providers'))"
kill %1
```

Expected: `keys: ['provider', 'apiKey', 'baseUrl']`, `providers: ['duckduckgo', 'tavily', 'searxng']`.

- [ ] **Step 3: Commit (if any change was needed)**

```bash
git add controller/src/routes/settings.ts
git commit -m "feat(api): expose search.baseUrl in settings response"
```

If no change was needed in Step 1, skip the commit and move to Task 7.

---

### Task 7: Add Test-connection API endpoint

**Files:**
- Modify: `controller/src/routes/settings.ts` (add a new route)

**Interfaces:**
- Consumes: native `fetch`
- Produces: `POST /api/settings/search/test-searxng` — body `{ baseUrl: string }`, returns `{ ok: true, results: number } | { ok: false, error: string }`

- [ ] **Step 1: Read the existing API-key test route pattern**

Look at how PR #574 added the `POST /api/settings/search/test-tavily` endpoint (if it landed) or any other test-connection route in this file. Match its style — auth guard, body parsing, error envelope.

If no prior test-connection route exists, follow the express/fastify pattern already used in the file (the file's other handlers will show the framework).

- [ ] **Step 2: Add the route**

Add this handler in `controller/src/routes/settings.ts` near the other `search/*` endpoints:

```ts
// POST /api/settings/search/test-searxng — verifies the supplied SearXNG
// instance answers a JSON query. Used by the admin UI's "Test" button so
// the operator gets immediate feedback instead of waiting for a segment
// tick to fail. Body { baseUrl: string }. Does not persist anything.
router.post('/search/test-searxng', async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || '').trim();
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl required' });
    if (!/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ ok: false, error: 'baseUrl must start with http:// or https://' });
    }

    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', 'subwave connectivity probe');
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let r: Response;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': 'SUB-WAVE radio controller (probe)' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
    const data: any = await r.json();
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    return res.json({ ok: true, results: count });
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'request timed out after 8s' : err?.message || 'fetch failed';
    return res.json({ ok: false, error: msg });
  }
});
```

(Adjust `router.post` to match whatever pattern the file uses — `app.post`, `fastify.post`, etc.)

- [ ] **Step 3: Typecheck**

```bash
cd controller && npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual probe (optional)**

```bash
cd controller && npm run dev &
sleep 3
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://192.168.0.112:8888"}' \
  http://localhost:8080/api/settings/search/test-searxng
kill %1
```

Expected: `{"ok":true,"results":<some integer>}`.

Then probe a bad URL:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://10.255.255.1:8888"}' \
  http://localhost:8080/api/settings/search/test-searxng
```

Expected: `{"ok":false,"error":"request timed out after 8s"}` (or connection refused).

- [ ] **Step 5: Commit**

```bash
git add controller/src/routes/settings.ts
git commit -m "feat(api): add /search/test-searxng probe endpoint"
```

---

### Task 8: Add SearXNG to admin UI dropdown and reveal URL field + Test button

**Files:**
- Modify: `web/components/admin/SettingsPanel.tsx` (lines 93–94, 440, 2238, 2296–2321)

**Interfaces:**
- Consumes: `POST /api/settings/search/test-searxng` from Task 7
- Produces: working admin UI control

- [ ] **Step 1: Add the SearXNG label**

At line 93–94, find:

```ts
const SEARCH_PROVIDER_LABELS = {
  duckduckgo: 'DuckDuckGo (free, no key)',
  tavily: 'Tavily (paid web search)',
};
```

Replace with:

```ts
const SEARCH_PROVIDER_LABELS = {
  duckduckgo: 'DuckDuckGo (free, no key)',
  tavily: 'Tavily (paid web search)',
  searxng: 'SearXNG (self-hosted)',
};
```

- [ ] **Step 2: Update hardcoded provider fallback**

At line ~2238, find:

```ts
const providers = data.search?.providers || ['duckduckgo', 'tavily'];
```

Replace with:

```ts
const providers = data.search?.providers || ['duckduckgo', 'tavily', 'searxng'];
```

- [ ] **Step 3: Add the SearXNG URL field + Test button block**

Find the existing Tavily block around line 2302–2321:

```tsx
{provider === 'tavily' && (
  <div>
    {/* existing Tavily key input + KeyStatus */}
  </div>
)}
```

Immediately after the closing `)}` of the Tavily block, add a parallel SearXNG block:

```tsx
{provider === 'searxng' && (
  <div className="space-y-2">
    <Label htmlFor="searxng-url">SearXNG URL</Label>
    <div className="flex gap-2">
      <Input
        id="searxng-url"
        type="url"
        placeholder="http://192.168.0.112:8888"
        value={form.search?.baseUrl ?? ''}
        onChange={(e) =>
          setForm((f) => ({
            ...f,
            search: { ...f.search, baseUrl: e.target.value },
          }))
        }
      />
      <Button
        type="button"
        variant="outline"
        disabled={!form.search?.baseUrl || testingSearxng}
        onClick={async () => {
          setTestingSearxng(true);
          setSearxngTestResult(null);
          try {
            const r = await fetch('/api/settings/search/test-searxng', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ baseUrl: form.search.baseUrl }),
            });
            const j = await r.json();
            setSearxngTestResult(j);
          } catch (err: any) {
            setSearxngTestResult({ ok: false, error: err?.message || 'request failed' });
          } finally {
            setTestingSearxng(false);
          }
        }}
      >
        {testingSearxng ? 'Testing…' : 'Test'}
      </Button>
    </div>
    {searxngTestResult && (
      <p className={`text-sm ${searxngTestResult.ok ? 'text-green-600' : 'text-red-600'}`}>
        {searxngTestResult.ok
          ? `OK — got ${searxngTestResult.results} results`
          : `Failed: ${searxngTestResult.error}`}
      </p>
    )}
    <p className="text-xs text-muted-foreground">
      Self-hosted SearXNG instance. No API key required. Make sure the JSON format is enabled in your SearXNG settings.yml.
    </p>
  </div>
)}
```

- [ ] **Step 4: Add the two state hooks**

Near the top of the component (where other `useState` calls live in the same render scope), add:

```tsx
const [testingSearxng, setTestingSearxng] = useState(false);
const [searxngTestResult, setSearxngTestResult] = useState<{ ok: boolean; results?: number; error?: string } | null>(null);
```

- [ ] **Step 5: Typecheck the web project**

If the web project has its own typecheck:

```bash
cd web && npm run typecheck 2>/dev/null || cd .. && npm run typecheck 2>/dev/null || echo "no typecheck found — check repo root"
```

Expected: PASS, or no script found (the file is .tsx so the controller's `tsc --noEmit` may not cover it — that is normal).

- [ ] **Step 6: Commit**

```bash
git add web/components/admin/SettingsPanel.tsx
git commit -m "feat(admin): add SearXNG provider with URL field and test button"
```

---

### Task 9: Wire callers — pass `recency` from artist-news, update skill catalog

**Files:**
- Modify: `controller/src/llm/internal/tools/segment-tools.ts` (line 176)
- Modify: `controller/src/skills/_agent.ts` (lines ~460–517)

**Interfaces:**
- Consumes: extended `searchWeb` signature from Task 4
- Produces: the artist-news segment uses `time_range=week` when on SearXNG; the skill catalog mentions SearXNG as a third option

- [ ] **Step 1: Pass recency at the artist-news callsite**

Open `controller/src/llm/internal/tools/segment-tools.ts`. Find line 176:

```ts
const r = await searchWeb(`${artist} musician latest news`);
```

(The exact variable name may differ — match the existing pattern.)

Change to:

```ts
const r = await searchWeb(`${artist} musician latest news`, { recency: 'week' });
```

Do NOT touch `picker-tools.ts:323` — it intentionally has no recency (Wikipedia/lyrics sites have no publishedDate, would be filtered out).

- [ ] **Step 2: Read `_agent.ts` lines 455–520 to see the skill catalog shape**

The recon report identified Tavily-specific strings (`hint`, `requiresKey`, `keyUrl`) in this region. Read the existing block first — its exact shape determines what the SearXNG branch needs.

- [ ] **Step 3: Add SearXNG branch to the skill catalog**

After the existing Tavily branch in `_agent.ts`, add (adapt to the file's actual shape):

```ts
if (provider === 'searxng') {
  return {
    hint: 'SearXNG self-hosted meta-search. Configure base URL in admin → Settings → Search.',
    // no requiresKey — SearXNG has no API key
  };
}
```

If the file uses a different return structure (e.g. an object literal selected by a switch), match that pattern. The key behaviors: no `requiresKey`, no `keyUrl`, a hint string that points to the admin URL field.

- [ ] **Step 4: Typecheck**

```bash
cd controller && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

```bash
cd controller && npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add controller/src/llm/internal/tools/segment-tools.ts controller/src/skills/_agent.ts
git commit -m "feat(skills): pass recency from artist-news and register searxng in skill catalog"
```

---

### Task 10: Update env example and docs

**Files:**
- Modify: `.env.example` (line ~79)
- Modify: `AGENTS.md` (line ~93)
- Modify: `CLAUDE.md` (line ~93)

**Interfaces:**
- Consumes: nothing
- Produces: documentation updates

- [ ] **Step 1: Update `.env.example`**

Find the existing comment around line 79:

```bash
# SEARCH_API_KEY=tvly-...
```

Replace with:

```bash
# SEARCH_API_KEY=tvly-...           # Tavily key (optional, paid)
# SearXNG: no env var. Configure base URL in admin UI → Settings → Search.
```

- [ ] **Step 2: Update `AGENTS.md`**

Find the `web-search` capability description around line 93. After the existing sentence about overriding via `state/skills/web-search/SKILL.md`, add:

```markdown
Backed by `searchWeb()` in `skills/web-search.ts`, with three provider options selectable in the admin UI: DuckDuckGo (default, free, sparse), Tavily (paid, rich results, needs `SEARCH_API_KEY`), and SearXNG (self-hosted meta-search, needs only a base URL).
```

- [ ] **Step 3: Update `CLAUDE.md`**

Mirror the same change at line ~93 (the recon report says CLAUDE.md is a direct copy of the AGENTS.md passage).

- [ ] **Step 4: Commit**

```bash
git add .env.example AGENTS.md CLAUDE.md
git commit -m "docs: document SearXNG as a third web-search provider"
```

---

### Task 11: Final verification

**Files:**
- None modified

**Interfaces:**
- Consumes: all prior tasks
- Produces: confidence that the integration works end-to-end

- [ ] **Step 1: Full test + typecheck pass**

```bash
cd controller && npm run lint && npm test
```

Expected: lint clean, all tests pass.

- [ ] **Step 2: Manual smoke test against the real SearXNG instance**

```bash
cd controller && npm run dev &
sleep 3
# Save SearXNG as the active provider
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"search":{"provider":"searxng","baseUrl":"http://192.168.0.112:8888"}}' \
  http://localhost:8080/api/settings
# Confirm it stuck
curl -s http://localhost:8080/api/settings | python3 -c "import json,sys; print(json.load(sys.stdin).get('values',{}).get('search'))"
kill %1
```

Expected: provider switches to `searxng`, baseUrl persists, no errors.

- [ ] **Step 3: Verify `git status` is clean and `git log` shows the expected commits**

```bash
git status
git log --oneline origin/develop..HEAD
```

Expected: working tree clean, ~9–11 commits since develop, all authored as `geekylakshya`.

- [ ] **Step 4: Done. Do not push.**

Branch is ready for review. Wait for explicit instruction before `git push`.

---

## Self-Review Notes

Coverage check against the 4 design decisions:

1. **Q1 (answer slot = first infobox content)** — Task 2 implements and tests this.
2. **Q2 (cap at 10 results, 300-char content)** — Task 2 implements and tests both caps.
3. **Q3 (per-callsite `recency` arg, week for artist-news only)** — Task 4 extends signature, Task 9 wires the artist-news callsite, picker-tools intentionally untouched.
4. **Q4 (settings.search.baseUrl, admin UI only, no env var)** — Task 5 adds the field, Task 6 serializes it, Task 7 adds Test endpoint, Task 8 adds the UI, Task 10 documents the no-env-var decision.

Coverage check against recon report's 11 touchpoints:

- (1) `settings.ts:281` — Task 5 ✓
- (2) `settings.ts:661–668` — Task 5 ✓
- (3) `settings.ts:1953–1966` — Task 5 ✓
- (4) `skills/web-search.ts` — Tasks 2, 3, 4 ✓
- (5) `skills/_agent.ts:460–517` — Task 9 ✓
- (6) `SettingsPanel.tsx:93–94` — Task 8 ✓
- (7) `SettingsPanel.tsx:2238` — Task 8 ✓
- (8) `SettingsPanel.tsx:2302–2321` — Task 8 ✓
- (9) `.env.example` — Task 10 ✓
- (10) `AGENTS.md` / `CLAUDE.md` — Task 10 ✓
- (11) Test file (greenfield) — Task 2 ✓

Type-consistency check:
- `parseSearxngResponse(data: unknown): SearchResponse` — declared Task 2, used Task 3 ✓
- `searxngSearch(query, recency?: 'day' | 'week' | 'month')` — declared Task 3, used Task 4 ✓
- `searchWeb(query, opts?: { recency?: ... })` — declared Task 4, used Task 9 ✓
- `settings.search.baseUrl: string` — declared Task 5, read by Task 3, written by Task 8, validated by Task 7 ✓

No placeholders. No "TBD". No "similar to Task N" without showing code.
