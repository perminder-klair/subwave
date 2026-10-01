// Pinned behaviour for the Google key pool and its cooldown policy.
//
// Three contracts:
//   • the cooldown parser distinguishes DAILY exhaustion (park hours) from a
//     per-minute throttle (honour the hint), because getting that backwards
//     either burns another 429 on a dead key or parks a key for three hours
//     over a one-second wait;
//   • selection is PRIMARY-FIRST, skipping held keys, and the pool terminates
//     rather than looping when every key is spent;
//   • rotation actually re-stamps the outgoing header, which is the whole
//     point — a green unit test on the selector proves nothing if the transport
//     never used it.
//
// Run: `npm test -- google-key-pool`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR ??= mkdtempSync(join(tmpdir(), 'google-pool-'));

import {
  __resetHoldsForTest,
  allKeysHeld,
  currentKey,
  fingerprint,
  holdRemainingMs,
  invalidatePool,
  parsePool,
  sanitizeName,
  serializePool,
  poolEntries,
  poolKeys,
  poolSize,
  poolStatus,
  reportKeyFailure,
  reportKeySuccess,
} from '../src/util/google-key-pool.js';
import {
  GEMINI_NO_HINT_MAX_MS,
  GEMINI_AUTH_PARK_MS,
  GEMINI_NO_HINT_MIN_MS,
  classifyGeminiFailure,
  hasDailyQuotaViolation,
  noHintCooldownMs,
  parseDurationMs,
  parseGeminiRetryDelayMs,
  resolveGeminiCooldownMs,
} from '../src/llm/internal/provider/gemini-cooldown.js';

const K1 = 'AIzaSyKeyOne0000000000000000000000000';
const K2 = 'AIzaSyKeyTwo0000000000000000000000000';
const K3 = 'AIzaSyKeyThree000000000000000000000000';

function setPool(...keys: string[]) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEYS = keys.join(',');
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  invalidatePool();
  __resetHoldsForTest();
}

// ─── duration + hint parsing ────────────────────────────────────────────────

test('durations parse across every unit Google emits', () => {
  assert.equal(parseDurationMs('22s'), 22_000);
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs('2m'), 120_000);
  assert.equal(parseDurationMs('1.5h'), 5_400_000);
  assert.equal(parseDurationMs('1d'), 86_400_000);
  assert.equal(parseDurationMs('nonsense'), null);
  assert.equal(parseDurationMs(null), null);
  assert.equal(parseDurationMs('-5s'), null);
});

test('RetryInfo.retryDelay is the authoritative hint', () => {
  const body = JSON.stringify({
    error: {
      message: 'Quota exceeded',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }],
    },
  });
  assert.equal(parseGeminiRetryDelayMs(body), 34_000);
});

test('prose "please retry in" is honoured when there is no detail', () => {
  const body = JSON.stringify({ error: { message: 'Resource exhausted. Please retry in 7s.' } });
  assert.equal(parseGeminiRetryDelayMs(body), 7_000);
});

test('a body with no hint parses as null, not a guess', () => {
  assert.equal(parseGeminiRetryDelayMs(JSON.stringify({ error: { message: 'nope' } })), null);
  assert.equal(parseGeminiRetryDelayMs(''), null);
  assert.equal(parseGeminiRetryDelayMs(undefined), null);
});

// ─── the daily vs per-minute decision ───────────────────────────────────────

test('a PerDay quotaId is detected from details[]', () => {
  // Both spellings occur in the wild. Matching only the bare `perday` form
  // silently misses the underscored one, which is the common one.
  for (const quotaId of [
    'generate_content_free_tier_requests_per_project_per_day',
    'generate_requests_per_day',
    'requestsPerDay',
  ]) {
    const body = JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId }],
        }],
      },
    });
    assert.equal(hasDailyQuotaViolation(body), true, `missed ${quotaId}`);
  }
});

test('a per-minute quotaId is not daily', () => {
  const body = JSON.stringify({
    error: {
      details: [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'requests_per_minute' }],
      }],
    },
  });
  assert.equal(hasDailyQuotaViolation(body), false);
});

test('daily exhaustion parks for hours, ignoring any short RetryInfo', () => {
  // The trap: Google attaches a seconds-scale RetryInfo even to a dead-for-today
  // key. Honouring it means sleeping, waking, and eating another 429.
  const body = JSON.stringify({
    error: {
      message: 'quota exceeded',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' },
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'generate_requests_per_model_per_day' }],
        },
      ],
    },
  });
  assert.equal(hasDailyQuotaViolation(body), true);
  const ms = resolveGeminiCooldownMs(body);
  assert.ok(ms >= GEMINI_NO_HINT_MIN_MS && ms <= GEMINI_NO_HINT_MAX_MS,
    `expected an hours-scale park, got ${ms}ms`);
});

test('a plain per-minute 429 takes Google at its word', () => {
  const body = JSON.stringify({
    error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }] },
  });
  assert.equal(resolveGeminiCooldownMs(body), 3_000);
});

test('no hint parks on the hours scale, randomised', () => {
  assert.equal(noHintCooldownMs(() => 0), GEMINI_NO_HINT_MIN_MS);
  assert.ok(noHintCooldownMs(() => 0.999) <= GEMINI_NO_HINT_MAX_MS);
  const a = noHintCooldownMs(() => 0.1);
  const b = noHintCooldownMs(() => 0.9);
  assert.notEqual(a, b, 'ten keys must not all wake on the same second');
});

// ─── pool parsing ───────────────────────────────────────────────────────────

test('the pool splits on commas, trims, dedupes and bounds', () => {
  assert.deepEqual(parsePool(`${K1}, ${K2} ,${K1}`), [
    { key: K1, name: '' }, { key: K2, name: '' },
  ]);
  assert.deepEqual(parsePool(''), []);
  assert.deepEqual(parsePool(null), []);
  assert.equal(parsePool(Array.from({ length: 80 }, (_, i) => `k${i}`).join(',')).length, 50);
});

// ─── naming ─────────────────────────────────────────────────────────────────
// A label lives INLINE with its key (`key:name`) rather than in a parallel
// array indexed by position — the shape that silently reattaches labels to the
// wrong credentials the first time a key is moved or removed.

test('a label rides with its key, and a name may contain colons', () => {
  assert.deepEqual(parsePool(`${K1}:Free tier 1,${K2}:Paid`), [
    { key: K1, name: 'Free tier 1' },
    { key: K2, name: 'Paid' },
  ]);
  // Split on the FIRST colon only: a Google key cannot contain one, so
  // everything after it is the operator's name, colons included.
  assert.deepEqual(parsePool(`${K1}:House: guest mic`), [
    { key: K1, name: 'House: guest mic' },
  ]);
});

test('a comma inside a name is stripped at the WRITE boundary, not at parse', () => {
  // `key:name` is comma-separated, so a name containing a comma would split the
  // entry in two and the tail would be sent to Google as a phantom key. The
  // only writers are the add and rename endpoints, and both sanitise first —
  // parsePool is documented as expecting already-sanitised input.
  assert.equal(sanitizeName('Free, one, two'), 'Free one two');
  assert.equal(sanitizeName('line\nbreak'), 'line break');
  assert.equal(sanitizeName('  padded  '), 'padded');
  assert.equal(sanitizeName('x'.repeat(200)).length, 60, 'names are length-capped');
  // Nothing sanitised can ever reach the parser as a split.
  assert.equal(serializePool([{ key: K1, name: 'Free, one, two' }]).split(',').length, 1);
});

test('names survive a full parse/serialise round trip', () => {
  const entries = [{ key: K1, name: 'Free tier 1' }, { key: K2, name: 'Paid' }];
  assert.deepEqual(parsePool(serializePool(entries)), entries);
});

test('an unnamed pool still serialises as a plain list of keys', () => {
  // A pool nobody has labelled must stay readable and hand-editable — no
  // trailing colons, no `::`.
  assert.equal(serializePool([{ key: K1, name: '' }, { key: K2, name: '' }]), `${K1},${K2}`);
});

test('reorder and remove preserve labels, because they serialise from entries', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  // The bug this guards: a move that rebuilt the pool from bare keys would
  // strip every label the operator just typed.
  assert.doesNotMatch(src, /saveSecrets\(\{ \[GOOGLE_KEYS_ENV\]: next\.join\(','\) \}\)/);
  const moves = (src.match(/serializePool\(/g) || []).length;
  assert.ok(moves >= 3, `move/remove/rename must all serialise from entries, saw ${moves}`);
});

test('pool status reports the name and still leaks no key material', () => {
  setPool();
  process.env.GOOGLE_GENERATIVE_AI_API_KEYS = `${K1}:Free tier 1,${K2}:Paid`;
  invalidatePool();
  __resetHoldsForTest();
  const status = poolStatus();
  assert.deepEqual(status.map(s => s.name), ['Free tier 1', 'Paid']);
  const serialised = JSON.stringify(status);
  assert.ok(!serialised.includes(K1) && !serialised.includes(K2), 'a raw key leaked into pool status');
});

test('a single legacy key is a one-key pool, so nothing changes for those stations', () => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();
  assert.deepEqual(poolKeys(), [K1]);
  assert.equal(currentKey(), K1);
});

test('an unconfigured pool is inert: currentKey is empty, not a crash', () => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  invalidatePool();
  __resetHoldsForTest();
  assert.equal(poolSize(), 0);
  assert.equal(currentKey(), '');
  assert.equal(allKeysHeld(), false, 'an empty pool must not read as exhausted');
});

// ─── selection: primary-first ───────────────────────────────────────────────

test('selection is primary-first, not round-robin', () => {
  setPool(K1, K2, K3);
  assert.equal(currentKey(), K1);
  reportKeyFailure(K1, JSON.stringify({ error: { message: 'Please retry in 30s.' } }));
  assert.equal(currentKey(), K2, 'must move down the list');
  reportKeyFailure(K2, JSON.stringify({ error: { message: 'Please retry in 30s.' } }));
  assert.equal(currentKey(), K3);
});

test('a successful key clears its hold so it is retried later', () => {
  setPool(K1, K2);
  reportKeyFailure(K1, 'Please retry in 5s.');
  assert.ok(holdRemainingMs(K1) > 0);
  reportKeySuccess(K1);
  assert.equal(holdRemainingMs(K1), 0);
  assert.equal(currentKey(), K1, 'key 1 must come back once it works again');
});

test('an expired hold is reaped, not remembered forever', async () => {
  setPool(K1, K2);
  reportKeyFailure(K1, JSON.stringify({
    error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5ms' }] },
  }));
  assert.equal(currentKey(), K2, 'a live hold is skipped');
  // Wait past the window rather than racing it.
  await new Promise(r => setTimeout(r, 25));
  assert.equal(holdRemainingMs(K1), 0, 'the hold must lapse, not stick');
  assert.equal(currentKey(), K1, 'key 1 must be retried once its window passes');
  assert.equal(poolStatus()[0].held, false);
});

test('an exhausted pool still returns a key so one-shot callers still work', () => {
  setPool(K1, K2);
  reportKeyFailure(K1, 'Please retry in 5s.');
  reportKeyFailure(K2, 'Please retry in 5s.');
  assert.equal(allKeysHeld(), true);
  // Deliberately NOT empty: a preview or Test-key button gets a real 429 with
  // a real RetryInfo instead of failing on a transient internal state.
  assert.equal(currentKey(), K1);
});

// ─── status redaction ───────────────────────────────────────────────────────

test('pool status exposes fingerprints and timers, never key material', () => {
  setPool(K1, K2);
  reportKeyFailure(K1, 'Please retry in 30s.');
  const status = poolStatus();
  assert.equal(status.length, 2);
  const serialised = JSON.stringify(status);
  assert.ok(!serialised.includes(K1), 'a raw key leaked into pool status');
  assert.ok(!serialised.includes(K2), 'a raw key leaked into pool status');
  assert.equal(status[0].held, true);
  assert.equal(status[1].held, false);
  assert.equal(status[1].current, true);
  assert.equal(fingerprint(K1), `••••${K1.slice(-4)}`);
});

// ─── the transport actually rotates ─────────────────────────────────────────

test('googleKeyFetch re-stamps the header with the next live key', async () => {
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');

  const sent: string[] = [];
  let call = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const h = new Headers(init?.headers || {});
    sent.push(h.get('x-goog-api-key') || '');
    call += 1;
    // First call is refused for quota; the retry must carry the OTHER key.
    if (call === 1) {
      return new Response(JSON.stringify({ error: { message: 'Please retry in 20s.' } }), {
        status: 429, statusText: 'Too Many Requests',
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const res = await googleKeyFetch('https://example.test/v1/models/x:generateContent', { method: 'POST' });
    assert.equal(res.status, 200, 'rotation should have produced a success');
    assert.deepEqual(sent, [K1, K2], 'second attempt must carry the next key');
    // The exhausted key is parked for the hinted window, not for hours: this
    // body is a per-minute 429, not a PerDay violation.
    const held = holdRemainingMs(K1);
    assert.ok(held > 0 && held <= 25_000, `expected the hinted ~20s park, got ${held}ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an exhausted pool surfaces the 429 instead of looping', async () => {
  setPool(K1);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'Please retry in 20s.' } }), { status: 429 });
  }) as typeof fetch;
  try {
    const res = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(res.status, 429, 'the 429 must reach the caller so failover can escalate');
    assert.equal(calls, 1, 'must not re-issue against the same spent key');
    // The body survives the read, which is what lets withFailover classify it.
    const body = await res.json();
    assert.match(body.error.message, /retry in 20s/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a non-quota failure never rotates — a 403 is a config problem, not a spent key', async () => {
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'permission denied' } }), { status: 403 });
  }) as typeof fetch;
  try {
    const res = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(res.status, 403);
    assert.equal(calls, 1, 'must not paper over a permissions error with another key');
    assert.equal(allKeysHeld(), false, 'a 403 must not park a key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── reordering ─────────────────────────────────────────────────────────────
// The order IS the feature — free keys first so the paid key at the end absorbs
// only what the free tiers can't — so moving a key is a first-class operation,
// and the index arithmetic has to be exact. Dropping the wrong key, or losing
// one, would silently change which credential the station reaches for.

test('reordering preserves every key exactly once', () => {
  const reorder = (keys: string[], from: number, to: number) => {
    const next = [...keys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };
  assert.deepEqual(reorder([K1, K2, K3], 2, 0), [K3, K1, K2], 'last becomes first');
  assert.deepEqual(reorder([K1, K2, K3], 0, 2), [K2, K3, K1], 'first becomes last');
  assert.deepEqual(reorder([K1, K2, K3], 1, 1), [K1, K2, K3], 'no-op');
  // The invariant that matters: nothing duplicated, nothing dropped.
  for (const [from, to] of [[0, 1], [1, 0], [2, 1], [0, 2], [1, 2], [2, 0]]) {
    const out = reorder([K1, K2, K3], from, to);
    assert.deepEqual([...out].sort(), [K1, K2, K3].sort(), `lost a key moving ${from}→${to}`);
    assert.equal(new Set(out).size, 3, `duplicated a key moving ${from}→${to}`);
  }
});

test('the move endpoint validates both bounds and rewrites the whole list', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post('/settings/google-key-pool/move'");
  assert.ok(start > 0, 'the move endpoint is missing');
  const body = src.slice(start, src.indexOf('\n});', start));
  // Both bounds are checked against a FRESH read of the pool, so a stale index
  // from a concurrent add is a 400 rather than the wrong key moving.
  assert.match(body, /!Number\.isInteger\(from\) \|\| !Number\.isInteger\(to\)/);
  assert.match(body, /from < 0 \|\| from >= entries\.length \|\| to < 0 \|\| to >= entries\.length/);
  // And it persists the whole reordered list, from ENTRIES so labels survive.
  assert.match(body, /serializePool\(next\)/);
  assert.match(body, /invalidatePool\(\)/);
});

// ─── adding ─────────────────────────────────────────────────────────────────
// The bug this pins: the add button originally POSTed the new key to the
// generic `/settings/secrets`, which REPLACES the value it is handed. Every add
// therefore overwrote the pool and left the operator with whichever key they
// typed last. The client cannot build the replacement list itself — it is never
// sent the key values — so appending has to happen server-side.

test('appending a key preserves every key already in the pool', () => {
  setPool(K1, K2);
  const entries = poolEntries().map(e => ({ ...e }));
  entries.push({ key: K3, name: 'Paid' });
  assert.deepEqual(entries.map(e => e.key), [K1, K2, K3]);
  // And the write is the WHOLE pool, not the new key alone.
  assert.deepEqual(parsePool(serializePool(entries)).map(e => e.key), [K1, K2, K3]);
});

test('the first add keeps a legacy single key as entry 0 rather than orphaning it', () => {
  // poolEntries() falls back to GOOGLE_GENERATIVE_AI_API_KEY when no pool is
  // set. An add that ignored that would silently drop the key already working.
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();
  const entries = poolEntries().map(e => ({ ...e }));
  assert.deepEqual(entries.map(e => e.key), [K1], 'the legacy key is the seed');
  entries.push({ key: K2, name: '' });
  assert.deepEqual(entries.map(e => e.key), [K1, K2]);
});

test('the add endpoint appends from entries and refuses a duplicate', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post('/settings/google-key-pool/add'");
  assert.ok(start > 0, 'the add endpoint is missing');
  const body = src.slice(start, src.indexOf('\n});', start));
  // Reads the current pool and pushes onto it — a replace-the-value writer is
  // exactly the bug this endpoint exists to route around.
  assert.match(body, /const entries = poolEntries\(\)\.map/);
  assert.match(body, /entries\.push\(\{ key: trimmed, name: sanitizeName/);
  assert.match(body, /serializePool\(entries\)/);
  // A duplicate is refused rather than appended: parsePool dedupes on read, so
  // a stored duplicate would show as a phantom slot that silently does nothing.
  assert.match(body, /already in the pool/);
  assert.match(body, /entries\.length >= GOOGLE_POOL_MAX/);
});

test('an exhausted pool costs exactly ONE attempt per key, never a second pass', async () => {
  // Found by the live rotation probe: the old check compared `next === key`,
  // and currentKey() falls back to the head once everything is held — so the
  // last real key always looked like a change and the head was tried a second
  // time. Nine requests for eight keys, one of them guaranteed to fail.
  setPool(K1, K2, K3);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    seen.push(new Headers(init?.headers || {}).get('x-goog-api-key') || '');
    return new Response(JSON.stringify({ error: { message: 'Please retry in 20s.' } }), { status: 429 });
  }) as typeof fetch;
  try {
    const res = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(res.status, 429);
    assert.equal(seen.length, 3, `one attempt per key, got ${seen.length} for a 3-key pool`);
    assert.deepEqual(seen, [K1, K2, K3], 'each key tried exactly once, in order');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── documented Interactions API error codes ───────────────────────────────
// Google publishes a machine-readable `error.code`. Where it exists it beats
// inferring intent from a quotaId substring, and it opens two cases the
// status-only design got wrong: a DAILY quota says so outright, and a rejected
// credential (401) is precisely the thing a pool exists to route around.

const code = (c: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { code: c, message: c, ...extra } });

test('error.code classifies the failures that change behaviour', () => {
  assert.equal(classifyGeminiFailure(code('quota_exceeded')), 'daily');
  assert.equal(classifyGeminiFailure(code('rate_limit_exceeded')), 'burst');
  assert.equal(classifyGeminiFailure(code('too_many_requests')), 'burst');
  assert.equal(classifyGeminiFailure(code('authentication')), 'auth');
  assert.equal(classifyGeminiFailure(code('payment_required')), 'billing');
});

test('generation-blocked codes are the CONTENT being refused, not a bad key', () => {
  // Every one of these means another key would refuse the same input, so
  // rotating would burn the whole pool to no effect.
  for (const c of ['safety', 'recitation', 'language', 'prohibited_content', 'spii',
    'blocklist', 'content_blocked', 'image_safety', 'malformed_function_call',
    'missing_thought_signature']) {
    assert.equal(classifyGeminiFailure(code(c)), 'other', `${c} must not read as a key problem`);
  }
});

test('a transient 503 is not a key problem either', () => {
  for (const c of ['service_unavailable', 'api_error', 'deadline_exceeded',
    'invalid_request', 'model_not_found', 'unimplemented']) {
    assert.equal(classifyGeminiFailure(code(c)), 'other', `${c} must not read as a key problem`);
  }
});

test('a documented quota_exceeded needs no substring guess at all', () => {
  // The body Google sends for a daily breach may carry no PerDay quotaId — the
  // old heuristic would have called this 'other' and parked it for the seconds
  // RetryInfo asked, which is the loop this whole distinction exists to stop.
  const bare = code('quota_exceeded');
  assert.equal(hasDailyQuotaViolation(bare), false, 'no quotaId to sniff — code carries it alone');
  assert.equal(classifyGeminiFailure(bare), 'daily');
  assert.ok(resolveGeminiCooldownMs(bare) >= GEMINI_NO_HINT_MIN_MS);
});

test('an invalid credential parks for a day; billing is never parked', () => {
  assert.equal(resolveGeminiCooldownMs(code('authentication')), GEMINI_AUTH_PARK_MS);
  // 402 says "don't retry" and is usually shared by every key on the project;
  // parking it would take the station down quietly instead of surfacing it.
  assert.equal(classifyGeminiFailure(code('payment_required')), 'billing');
});

test('a gateway that drops error.code still classifies via details[]', () => {
  // A proxy or gateway in front of the API can reshape the error body, and an
  // older API surface may never have sent `code` at all; the details fallback is
  // what keeps this working when the code is gone.
  const reshaped = JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'generate_content_free_tier_requests_per_project_per_day' }] },
  ] } });
  assert.equal(classifyGeminiFailure(reshaped), 'daily');
  assert.equal(classifyGeminiFailure(JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '4s' }] } })), 'burst');
});

test('an auth failure rotates the pool — the one non-429 that must', async () => {
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  const sent: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    sent.push(new Headers(init?.headers || {}).get('x-goog-api-key') || '');
    call += 1;
    if (call === 1) {
      return new Response(code('authentication'), { status: 401, statusText: 'Unauthorized' });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const res = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [K1, K2], 'a rejected credential must move to the next key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('billing and content blocks do NOT rotate — they would fail identically', async () => {
  for (const [status, c] of [[402, 'payment_required'], [403, 'permission_denied'], [503, 'service_unavailable']] as const) {
    setPool(K1, K2);
    const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(code(c), { status });
    }) as typeof fetch;
    try {
      const res = await googleKeyFetch('https://example.test/v1/x', {});
      assert.equal(res.status, status);
      assert.equal(calls, 1, `${c} must reach the operator, not burn the pool`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('with no pool configured the transport is exactly the SDK transport', async () => {
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  invalidatePool();
  __resetHoldsForTest();
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  let seen: string | null = null;
  globalThis.fetch = (async (_u: any, init: any) => {
    seen = new Headers(init?.headers || {}).get('x-goog-api-key');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(seen, null, 'must leave the provider-built header untouched');
  } finally {
    globalThis.fetch = realFetch;
  }
});
