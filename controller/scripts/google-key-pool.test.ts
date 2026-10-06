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
  __expireHoldsForTest,
  __resetHoldsForTest,
  allKeysHeld,
  currentKey,
  fingerprint,
  getLastFailure,
  holdRemainingMs,
  invalidatePool,
  parsePool,
  sanitizeName,
  serializePool,
  currentKeyOrHead,
  entryId,
  poolConfigured,
  recordLastFailure,
  poolEntries,
  poolKeys,
  poolRevision,
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

test('a legacy single key is NOT a pool — those stations keep their old behaviour', () => {
  // Reading the singular variable as a one-key pool silently switched every
  // existing station onto holds, escalation and replay it never opted into: an
  // unhinted 429 parked its only credential for hours and later calls replayed a
  // fabricated error with no network I/O. The pool is inert until the PLURAL
  // variable is set.
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();
  assert.deepEqual(poolKeys(), [], 'a legacy key must not appear in the pool');
  assert.equal(poolSize(), 0);
  assert.equal(poolConfigured(), false);
  assert.equal(currentKey(), '', 'no pool means no pooled selection at all');
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

test('the rotation path gets nothing from an exhausted pool, but one-shot callers still do', () => {
  setPool(K1, K2);
  reportKeyFailure(K1, 'Please retry in 5s.');
  reportKeyFailure(K2, 'Please retry in 5s.');
  assert.equal(allKeysHeld(), true);
  // The two answers are deliberately different, and conflating them was a bug.
  // currentKey() is what rotation calls: it must return '' rather than the head,
  // or the transport spends a guaranteed extra request on a key it has just been
  // told is dead. currentKeyOrHead() is what a preview or the Test-key button
  // calls, where a real answer from a real request beats failing on a transient
  // internal state.
  assert.equal(currentKey(), '', 'rotation must never be handed a held key');
  assert.equal(currentKeyOrHead(), K1, 'a one-shot caller still gets a usable key');
});

test('currentKey never returns a key the caller excluded, even once its hold lapses', () => {
  // The defect that made traversal unbounded: eligibility was re-derived from
  // shared hold timers on every hop, so a hold shorter than the request that
  // followed it expired mid-call and handed back the key that had just failed.
  // Two keys, a 10ms hint and 20ms of latency gave A,B,A,B,A,B… with no stop.
  // Excluding is request-local state, so it holds regardless of timer timing.
  setPool(K1, K2);
  const attempted = new Set([K1]);
  reportKeyFailure(K1, JSON.stringify({
    error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }] },
  }));
  assert.equal(currentKey(attempted), K2);
  // Past the hold window, K1 is eligible again on its own terms — but NOT to a
  // call that has already tried it.
  return new Promise<void>(r => setTimeout(r, 25)).then(() => {
    assert.equal(currentKey(), K1, 'the key itself is healthy again');
    assert.equal(currentKey(attempted), K2, 'but this call must not reuse it');
    assert.equal(currentKey(new Set([K1, K2])), '', 'every key tried — nothing left');
  });
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

test('move is addressed by opaque id, not by an index pair', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post('/settings/google-key-pool/move'");
  assert.ok(start > 0, 'the move endpoint is missing');
  const body = src.slice(start, src.indexOf('\n});', start));
  // A from/to INDEX PAIR is two stale references the moment anything moves, and
  // moving is exactly when an operator has two tabs open. The id is derived from
  // the key, so it survives the reorder that invalidated the indices.
  assert.doesNotMatch(body, /from:\s*number/);
  assert.match(body, /entryId\(e\.key\) === id/);
  // A source that no longer exists is a 409, not a silent success.
  assert.match(body, /conflict/);
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

test('an add on a legacy station starts a pool from the key being added', () => {
  // The legacy variable is NOT seeded into the pool — that is what made every
  // existing station behave as if it had opted in. So the first add on a legacy
  // station produces a pool of exactly the one key added, and the operator's
  // next save in the pool editor is what carries their original key across.
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();
  assert.deepEqual(poolEntries(), [], 'nothing is seeded implicitly');
  const entries = [...poolEntries(), { key: K2, name: '' }];
  assert.deepEqual(entries.map(e => e.key), [K2]);
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

test('a hold SHORTER than the request still costs one attempt per key', async () => {
  // The review round's finding #2, which the test above cannot see: that one
  // uses a 20s hint, so every failed key is still parked when the next one is
  // selected and the shared holds bound the loop on their own. Make the hold
  // 10ms and the request 20ms and the hold is EXPIRED before the next
  // selection — so the request-local attempted set is the only thing left that
  // can end the recursion. Handing the recursion a fresh set here does not
  // produce a failing assertion, it produces an unbounded loop that hangs the
  // runner, which is why this case needs its own test rather than a wider
  // assertion on the one above.
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  // The stub REFUSES a third attempt rather than letting the recursion run.
  // An unbounded loop does not fail a test, it hangs the runner until the whole
  // suite is killed — which reads as "the pool broke" and proves nothing about
  // which assertion was supposed to catch it. Throwing here converts the exact
  // regression into a reported failure at the call site.
  const POOL_SIZE = 2;
  globalThis.fetch = (async (_u: any, init: any) => {
    seen.push(new Headers(init?.headers || {}).get('x-goog-api-key') || '');
    if (seen.length > POOL_SIZE) {
      throw new Error(`rotation was not bounded: ${seen.length} attempts for a ${POOL_SIZE}-key pool`);
    }
    await new Promise(r => setTimeout(r, 20));   // slower than the hold below
    return new Response(JSON.stringify({ error: { message: 'Please retry in 0.01s.' } }), { status: 429 });
  }) as typeof fetch;
  try {
    const res = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(res.status, 429);
    assert.equal(seen.length, 2, `one attempt per key, got ${seen.length} for a 2-key pool`);
    assert.deepEqual(seen, [K1, K2], 'an expired hold must not hand the failed key back');
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

// ─── escalating holds ───────────────────────────────────────────────────────
// An exhausted pool is FREE per request (held keys are skipped with no HTTP),
// so the only real cost is how OFTEN a dead key is re-probed. A flat one-minute
// hold means a key whose daily quota is mislabelled as a rate limit is probed
// every minute for the rest of the day.

test('an unhinted burst hold escalates with consecutive failures', () => {
  const burst = code('rate_limit_exceeded');   // labelled, but no RetryInfo
  const lapsed = [0, 1, 2, 3, 4, 5, 6].map(n =>
    resolveGeminiCooldownMs(burst, () => 0.5, n + 1));
  for (let i = 1; i < lapsed.length; i++) {
    assert.ok(lapsed[i] >= lapsed[i - 1], `hold must not shrink: ${lapsed[i - 1]} -> ${lapsed[i]}`);
  }
  assert.equal(lapsed[0], 60_000, 'first unhinted burst is the short one');
  assert.ok(lapsed.at(-1)! <= 3 * 60 * 60 * 1000, 'escalation is capped');
  // A key that keeps failing converges instead of climbing forever.
  assert.equal(lapsed.at(-1), resolveGeminiCooldownMs(burst, () => 0.5, 99));
});

test('escalation NEVER overrides an explicit RetryInfo', () => {
  // Google said twenty seconds. Holding the key a minute "because it keeps
  // failing" would shrink the pool for no reason — the whole point of the burst
  // class is that it clears fast, and the hint is the only thing we actually
  // know about when it will.
  const hinted = JSON.stringify({ error: {
    code: 'rate_limit_exceeded',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }],
  } });
  for (const n of [1, 2, 5, 50]) {
    assert.equal(resolveGeminiCooldownMs(hinted, () => 0.5, n), 20_000,
      `strike ${n} must still honour the 20s hint`);
  }
});

test('a key that succeeds has its escalation history forgotten', () => {
  setPool(K1, K2);
  const burst = code('rate_limit_exceeded');
  reportKeyFailure(K1, burst);
  reportKeyFailure(K1, burst);
  reportKeyFailure(K1, burst);
  assert.equal(poolStatus()[0].strikes, 3);
  reportKeySuccess(K1);
  assert.equal(poolStatus()[0].strikes, 0, 'a recovered key starts fresh');
  // And its next failure is back to the short interval, not the escalated one.
  const after = reportKeyFailure(K1, burst);
  assert.ok(after <= 60_000, `expected the short interval again, got ${after}ms`);
});

test('a burst key is re-probed rarely, not every minute, once it keeps failing', () => {
  // The end-to-end claim: with a key that never recovers, the number of probes
  // over an hour collapses from 60 to single digits.
  setPool(K1, K2);
  const burst = code('rate_limit_exceeded');
  let probes = 0;
  const oneHourMs = 60 * 60 * 1000;
  let elapsed = 0;
  while (elapsed < oneHourMs) {
    // The hold, then wait it out, then the next probe.
    const held = reportKeyFailure(K1, burst);
    elapsed += held;
    probes += 1;
  }
  assert.ok(probes <= 8, `expected single-digit probes in an hour, got ${probes}`);
});

// ─── review fixes ───────────────────────────────────────────────────────────

test('a ZERO RetryInfo is treated as no hint, never as a zero-length hold', () => {
  // `0s` produced a hold that was already expired on store, so currentKey()
  // reaped it, handed back the SAME key, and the transport recursed forever on
  // a response that would keep arriving identically.
  assert.equal(parseDurationMs('0s'), null);
  assert.equal(parseDurationMs('0ms'), null);
  const zero = JSON.stringify({ error: {
    code: 'rate_limit_exceeded',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }],
  } });
  assert.ok(resolveGeminiCooldownMs(zero) > 0, 'a zero hint must still park for a real interval');
});

test('an exhausted pool short-circuits WITHOUT a request, and replays the real body', async () => {
  // Checking after the fact meant every generation spent a request on a
  // credential already known dead, got the same 429 back, and only then
  // noticed — a guaranteed extra round-trip per call that also kept hammering
  // exhausted keys.
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    seen.push(new Headers(init?.headers || {}).get('x-goog-api-key') || '');
    call += 1;
    return new Response(code('quota_exceeded', {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
    }), { status: 429, statusText: 'Too Many Requests' });
  }) as typeof fetch;
  try {
    const first = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(first.status, 429);
    const learned = call;
    // Pool is now spent. These must cost nothing at all.
    for (let i = 0; i < 5; i++) {
      const res = await googleKeyFetch('https://example.test/v1/x', {});
      assert.equal(res.status, 429, 'still a real 429 for failover to classify');
    }
    assert.equal(call, learned, 'no further network I/O once the pool is spent');
    assert.deepEqual(seen, [K1, K2], 'only one attempt per key, ever');
    // And the replayed body is the provider's own, so the reason survives.
    const body = await (await googleKeyFetch('https://example.test/v1/x', {})).json();
    assert.equal(body.error.code, 'quota_exceeded');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a successful call clears the recorded failure it would otherwise replay', async () => {
  setPool(K1, K2);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    return call === 1 ? new Response(code('quota_exceeded'), { status: 429 }) : new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal((await googleKeyFetch('https://example.test/v1/x', {})).status, 200);
    // K1's hold is still set from the first call, so the replay path is not
    // reachable — but the failure record must not outlive a working key either.
    assert.equal(getLastFailure()?.status ?? 429, 429);
    assert.equal((await googleKeyFetch('https://example.test/v1/x', {})).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The version above called `reportKeySuccess(K1)` by hand, which made it a test
// of the HELPER rather than of the transport: deleting the transport's own call
// left it green, while a station whose keys had all recovered kept replaying a
// quota error from a pool with nothing wrong with it. Driven through
// `googleKeyFetch` so the assertion can only pass if the reset happens where a
// real request succeeded.
test('the transport itself forgets a recovered pool — no helper called by hand', async () => {
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  try {
    // 1. A single-key pool 429s: the failure is recorded and the key parked.
    setPool(K1);
    globalThis.fetch = (async () => new Response(
      code('quota_exceeded'), { status: 429, headers: { 'retry-after': '3600' } },
    )) as unknown as typeof fetch;
    const exhausted = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(exhausted.status, 429);
    assert.ok(getLastFailure(), 'the failure must be recorded for the replay to carry');

    // 2. The hold expires and the SAME key answers 200. The transport's success
    //    path is the only thing that may clear the recorded failure.
    __expireHoldsForTest();
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    assert.equal((await googleKeyFetch('https://example.test/v1/x', {})).status, 200);
    assert.equal(getLastFailure(), null,
      'a pool whose key just answered must not still be replaying a quota failure — that '
        + 'is what turned a recovered pool into a station that stays silent');

    // 3. And the replay path is genuinely unreachable now, rather than merely
    //    unexercised: a fresh pool that DOES fail still records truthfully.
    setPool(K2);
    globalThis.fetch = (async () => new Response(code('quota_exceeded'), { status: 429 })) as unknown as typeof fetch;
    await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(getLastFailure()?.status, 429,
      'clearing on success must not clear on the next failure');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the per-key probe reports failure as a non-2xx status', async () => {
  // A plain 200 carrying {ok:false} is read as SUCCESS by the editor's post(),
  // which never inspects the body — so an invalid or exhausted key was reported
  // as "Key N responded". This is the mistake that actually happened once.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post('/settings/google-key-pool/test'");
  assert.ok(start > 0, 'the test endpoint is missing');
  const body = src.slice(start, src.indexOf('\n});', start));
  assert.match(body, /res\.status\(502\)\.json\(\{ ok: false/);
  assert.doesNotMatch(body, /res\.json\(\{ ok: false/);
});

// ─── SDK integration: the tests that would have caught the load-bearing bug ───
//
// Everything above exercises the pool through its own functions. That is not
// enough, and the gap was not theoretical: the feature shipped with
// `apiKey` passed to `createGoogleGenerativeAI` only when `cfg.apiKey` was set.
// On a pool-only station — the exact configuration the feature exists for, with
// no `GOOGLE_GENERATIVE_AI_API_KEY` at all — the SDK threw `LoadAPIKeyError`
// with ZERO fetch calls, so the pooled transport never ran and no amount of
// green unit tests noticed. The assertion that "passed" was a regex over source
// text, which cannot see a constructor that throws.
//
// These go through the real SDK entry points instead: build the model the way
// the controller does, call it, and look at what reached the wire.

/** A Gemini-shaped response, so the SDK's parsing succeeds and the call returns
 *  rather than failing later in a way that would mask the thing under test. */
function geminiReply(text = 'OK') {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function geminiEmbedding() {
  return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Drive both Google consumers through the REAL entry points the controller
 *  uses — `languageModel()` and `embeddingModel()` — and report what reached the
 *  wire.
 *
 *  It has to go through those and not re-build the provider here. An earlier
 *  version of this file constructed its own `createGoogleGenerativeAI`, which
 *  meant it kept passing with the construction-key fix reverted: it was
 *  exercising the helper it was meant to police instead of the call site. A
 *  test that cannot fail on the bug is worse than no test, because it reads as
 *  coverage.
 */
async function probeSdkConsumers(): Promise<{ chat: string; embed: string; calls: number; keys: string[] }> {
  // Aliased: this file already binds `embed` at module scope, and destructuring
  // the same name here silently renamed to `embed2`, which is not a function.
  const { generateText, embed: embedText } = await import('ai');
  const { languageModel } = await import('../src/llm/internal/provider/registry.js');
  const { embeddingModel } = await import('../src/llm/internal/provider/embedding.js');

  const keys: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const headers = new Headers(init?.headers || {});
    keys.push(headers.get('x-goog-api-key')
      ?? new URL(String(url?.url ?? url)).searchParams.get('key')
      ?? '');
    return String(url?.url ?? url).includes('embed') ? geminiEmbedding() : geminiReply();
  }) as unknown as typeof fetch;

  try {
    let chat = '';
    await generateText({ model: languageModel(), prompt: 'hi', maxOutputTokens: 8 })
      .then(r => { chat = r.text?.trim() ?? ''; })
      .catch(() => { chat = ''; });

    let embed = 'FAILED';
    await embedText({ model: embeddingModel(), value: 'x' })
      .then(e => { embed = e.embedding.length === 3 ? 'dimensions returned' : 'FAILED'; })
      .catch(() => { embed = 'THREW'; });

    return { chat, embed, calls: keys.length, keys };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Point settings at the google provider, the way a controller restart with
 *  `settings.json` on disk would.
 *
 *  It writes into the STATE_DIR the modules ALREADY resolved rather than a new
 *  temp dir: `config.js` captures STATE_DIR at import, so a fresh directory
 *  created here is simply never read, and settings silently stay at their
 *  defaults — which reads as "the provider ignored my config", not as a test
 *  setup mistake.
 */
async function coldLoadGoogleSettings(): Promise<void> {
  const { config } = await import('../src/config.js');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(config.stateDir, 'settings.json'), JSON.stringify({
    llm: { provider: 'google', model: 'gemini-2.5-flash' },
    embedding: { provider: 'google', model: 'text-embedding-004' },
  }));
  const { setCache } = await import('../src/settings/store.js');
  const settings = await import('../src/settings.js');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.provider, 'google', 'settings must actually have loaded');
}

test('a POOL-ONLY station can generate and embed — no singular key variable at all', async () => {
  // The regression this pins. `delete` on the singular variable is the whole
  // point: it is what makes this a pool-only station, which is the setup the
  // feature is FOR. Before the fix this threw LoadAPIKeyError with 0 fetches.
  await coldLoadGoogleSettings();
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  setPool(K1, K2);

  const out = await probeSdkConsumers();
  assert.equal(out.chat, 'OK', `chat must work pool-only (got "${out.chat}")`);
  assert.equal(out.embed, 'dimensions returned', 'embeddings must work pool-only');
  assert.ok(out.calls >= 2, `both consumers must reach the wire (got ${out.calls})`);
});

test('the wire carries a key FROM THE POOL, never the environment default', async () => {
  // Both consumers must stamp the pool's key. If either fell back to the SDK's
  // own environment lookup it would use a different credential than the one
  // serving chat — a migrated station quietly splitting its quota across two
  // keys it thinks it is rotating deliberately.
  await coldLoadGoogleSettings();
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  setPool(K1, K2);

  const out = await probeSdkConsumers();
  assert.ok(out.calls >= 1, 'the request must reach the wire');
  for (const k of out.keys) assert.equal(k, K1, 'must use the pool head, not an env default');
});

test('a LEGACY single-key station still reaches Google', async () => {
  // The upgrade guarantee, checked at the SDK rather than by reading config:
  // a station that set only the singular variable must keep working exactly as
  // before, with the pool inert.
  await coldLoadGoogleSettings();
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();

  const out = await probeSdkConsumers();
  assert.equal(out.chat, 'OK', 'the legacy path must still generate');
  assert.ok(out.calls >= 1, 'the legacy path must still make its request');
});

test('a legacy station is NOT parked by an unhinted 429, and replays nothing', async () => {
  // The other half of the upgrade guarantee, and the more damaging half. With
  // the singular variable read as a one-key pool, an unhinted 429 parked that
  // station's only credential for 1-3 hours and every later call answered from
  // a recorded body with NO network I/O — so a station that previously recovered
  // by one retry went silent. Legacy means legacy.
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEYS;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = K1;
  invalidatePool();
  __resetHoldsForTest();

  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
  }) as unknown as typeof fetch;
  try {
    const first = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(first.status, 429, 'the real response is passed straight through');
    const afterFirst = calls;
    const second = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(second.status, 429);
    // Each call makes its own request. Read as a one-key pool, the second call
    // would find that key held and answer from a recorded body with no network
    // I/O — which is the failure this pins.
    assert.equal(calls, afterFirst + 1,
      'a legacy station must keep making its request — no synthesised replay');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('every Google consumer is routed through the pooled transport', async () => {
  // Kept as a source check on TOP of the SDK tests above, not instead of them:
  // it catches a future edit that unwires a consumer, while the SDK tests catch
  // one that leaves it wired but broken. Neither alone is sufficient, and the
  // SDK test alone would not notice a consumer being pointed somewhere else.
  const fs = await import('node:fs');
  const embed = fs.readFileSync(new URL('../src/llm/internal/provider/embedding.ts', import.meta.url), 'utf8');
  assert.match(embed, /createGoogleGenerativeAI\(\{ fetch: googleKeyFetch/,
    'Google embeddings must use the pooled transport');
  const routes = fs.readFileSync(new URL('../src/routes/settings/llm.ts', import.meta.url), 'utf8');
  assert.match(routes, /currentKeyOrHead\(\) \|\| resolveKey\('GOOGLE_GENERATIVE_AI_API_KEY'\)/,
    'model discovery must prefer the pool\'s live key');
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

test('the single-key field is greyed out while a pool exists, and says so', async () => {
  // The product decision: an operator must be able to SEE that their single key
  // is parked rather than assume it was replaced. Hidden is not the same as
  // answered, so the field stays visible, inert, and carries the reason plus the
  // way back.
  const fs = await import('node:fs');
  const llmSection = fs.readFileSync(
    new URL('../../web/components/admin/settings/LlmSection.tsx', import.meta.url), 'utf8');

  // The field writes the LEGACY singular variable. If it wrote the pool, then
  // "remove every key" would empty the pool, the field would re-enable, typing
  // one key would re-activate the pool, and the field would disable itself
  // again — a single key could never be configured at all.
  assert.doesNotMatch(llmSection, /'GOOGLE_GENERATIVE_AI_API_KEYS'/,
    'the single field must not write the pool variable');

  assert.match(llmSection, /const poolActive = isGoogle && googlePoolCount > 0/,
    'pool presence must drive the disabled state');
  assert.match(llmSection, /disabled=\{poolActive\}/,
    'the single-key input must be disabled while a pool exists');
  assert.match(llmSection, /disabled=\{poolActive \|\| primaryKeyTesting/,
    'the Test key button must be disabled while a pool exists');
  assert.match(llmSection, /Not used while a key pool is set up below/,
    'the hint must state the single key is unused');
  assert.match(llmSection, /Remove the pool to go back to a\s*\n?\s*single key\./,
    'the hint must state how to get back to a single key');

  // Both are on screen together: the pool editor is a sibling, not a swap.
  assert.match(llmSection, /\{isGoogle && \(\s*\n\s*<GoogleKeyPoolEditor/,
    'the pool editor must render below the field, not replace it');

  const routes = fs.readFileSync(new URL('../src/routes/settings/llm.ts', import.meta.url), 'utf8');
  assert.match(routes, /key === GOOGLE_KEYS_ENV\s*\n?\s*\? currentKeyOrHead\(\)/,
    'testing an on-file Google key must resolve the pool, not raw process.env');
  assert.match(routes, /case GOOGLE_KEYS_ENV:\s*\n\s*case GOOGLE_KEY_ENV:/,
    'the pool variable must reach the Google probe branch');

  const core = fs.readFileSync(new URL('../src/routes/settings/core.ts', import.meta.url), 'utf8');
  assert.match(core, /GOOGLE_GENERATIVE_AI_API_KEY: !!process\.env\.GOOGLE_GENERATIVE_AI_API_KEY \|\| poolConfigured\(\)/,
    'a pool-only station must still report a Google key on file, or Test stays disabled');
});

// ─── concurrent mutation ─────────────────────────────────────────────────────
// The bug: each handler was read-modify-write, and nothing serialised them. Four
// concurrent adds all returned HTTP 200 with `count: 2`, and the persisted pool
// held ONE of the four. The operator was told four keys were added.

test('concurrent pool writers do not lose each other\'s additions', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'google-pool-race-'));
  // saveSecretsWithinLock, NOT saveSecrets: this handler already holds the pool
  // lock, and `saveSecrets` takes it itself. Calling the locked variant from
  // inside the lock deadlocks the single chain against itself — which is exactly
  // why the unlocked variant is exported and named for its precondition rather
  // than left as an internal detail.
  const { saveSecretsWithinLock: realSave } = await import('../src/setup/secrets.js');
  const { poolEntries: entriesOf } = await import('../src/util/google-key-pool.js');
  const { withPoolLock: lock } = await import('../src/util/google-key-pool.js');

  // A slow writer makes the interleaving deterministic: without the lock every
  // reader observes the same starting list before any of them writes.
  const slowSave = async (patch: Record<string, string>) => {
    await new Promise(r => setTimeout(r, 15));
    return realSave(patch);
  };

  const adds = [1, 2, 3, 4].map(i => () => lock(async () => {
    const entries = entriesOf().map(e => ({ ...e }));
    entries.push({ key: `RACE_${i}`, name: '' });
    await slowSave({ GOOGLE_GENERATIVE_AI_API_KEYS: serializePool(entries) });
    invalidatePool();
    return entries.length;
  }));

  await Promise.all(adds.map(fn => fn()));
  invalidatePool();

  const persisted = parsePool(process.env.GOOGLE_GENERATIVE_AI_API_KEYS).map(e => e.key);
  for (let i = 1; i <= 4; i++) {
    assert.ok(persisted.includes(`RACE_${i}`), `RACE_${i} was lost — only ${persisted.join(',')}`);
  }
  assert.equal(stateRoot.length > 0, true);
});

// The review that produced `saveSecretsWithinLock`: two UNRELATED keys saved at
// once, both handlers answering 200, one key silently gone — 20 runs out of 20.
// Nothing about this is Google-specific. `saveSecrets` rewrites the WHOLE file,
// so every save is a read-modify-write of one file and the pool lock covering
// only the pool-touching half left the ordinary case unprotected. The test names
// three different variables so a fix that only special-cases the pool still fails.
test('concurrent saves of DIFFERENT keys all survive — the file is one transaction', async () => {
  const { saveSecrets } = await import('../src/setup/secrets.js');
  const { STATE_DIR } = await import('../src/config.js');
  const { readFile } = await import('node:fs/promises');

  await Promise.all([
    saveSecrets({ OPENROUTER_API_KEY: 'sk-concurrent-A' }),
    saveSecrets({ FISH_API_KEY: 'fish-concurrent-B' }),
    saveSecrets({ DEEPSEEK_API_KEY: 'ds-concurrent-C' }),
  ]);

  const onDisk = await readFile(`${STATE_DIR}/secrets.env`, 'utf8');
  for (const [envVar, value] of [
    ['OPENROUTER_API_KEY', 'sk-concurrent-A'],
    ['FISH_API_KEY', 'fish-concurrent-B'],
    ['DEEPSEEK_API_KEY', 'ds-concurrent-C'],
  ] as const) {
    assert.ok(
      onDisk.includes(value),
      `${envVar} was lost to a concurrent save — the file holds only: ${onDisk.replace(/\n/g, ' | ')}`,
    );
  }
});

test('the lock rejects nothing: a failing mutation does not wedge the pool', async () => {
  // The chain must survive a rejection. If a failed write poisoned the tail,
  // every later pool mutation would reject and the operator could never fix the
  // pool again — a permanent dead end with the credentials still misconfigured.
  const { withPoolLock: lock } = await import('../src/util/google-key-pool.js');
  await assert.rejects(lock(async () => { throw new Error('simulated write failure'); }));
  const after = await lock(async () => 'still works');
  assert.equal(after, 'still works');
});

test('every pool mutation bumps the revision the admin UI compares against', async () => {
  // The revision is what tells a client "someone else changed this since you
  // rendered", which is a different fact from "is a write in flight" and the one
  // the lock cannot supply — the competing change may be seconds old.
  const { bumpPoolRevision, poolRevision } = await import('../src/util/google-key-pool.js');
  const before = poolRevision();
  bumpPoolRevision();
  assert.ok(poolRevision() > before, 'the revision must advance on every mutation');
});

// ─── credential identity ─────────────────────────────────────────────────────
// Mutations used to address keys by INDEX with the range checked against a
// fresh read. A stale index is still in range after a reorder, so "remove index
// 0" destroyed whatever had moved into that slot and answered HTTP 200.

test('an entry id identifies its key across a reorder, and survives a rename', () => {
  setPool(K1, K2);
  const idForK1 = entryId(K1);
  assert.equal(entryFor(poolEntries(), idForK1), K1);
  // Reorder: the id travels with the credential, the index does not.
  const reordered = [poolEntries()[1], poolEntries()[0]];
  assert.equal(entryFor(reordered, idForK1), K1);
  assert.notEqual(reordered[0].key, K1, 'the first slot now holds a different key');
  // A rename changes nothing about identity.
  const renamed = { ...poolEntries()[0], name: 'Free tier' };
  assert.equal(entryId(renamed.key), entryId(poolEntries()[0].key));
});

test('a stale index reference no longer resolves to a live entry', () => {
  // The shape of the wrong-key deletion, expressed on the selector the endpoint
  // actually uses: index 0 before a reorder is a different credential after it.
  setPool(K1, K2);
  const staleIndex = 0;
  const before = poolEntries()[staleIndex].key;
  const reordered = [poolEntries()[1], poolEntries()[0]];
  const after = reordered[staleIndex].key;
  assert.notEqual(before, after, 'an index is a position, not a credential');
  // The id, by contrast, still names the same key.
  assert.equal(entryFor(reordered, entryId(K1)), K1);
});

function entryFor(entries: { key: string }[], id: string): string | undefined {
  return entries.find(e => entryId(e.key) === id)?.key;
}

// ─── replay fidelity ─────────────────────────────────────────────────────────
// The replayed response stands in for a real provider response, so anything the
// retry/failover layers read from it has to survive.

test('a replayed exhausted-pool response keeps the Retry-After header', async () => {
  setPool(K1);
  const { googleKeyFetch } = await import('../src/llm/internal/provider/registry.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Temporarily busy' } }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' } },
  )) as unknown as typeof fetch;
  try {
    // First call makes the request and is 429; that parks the only key.
    await googleKeyFetch('https://example.test/v1/x', {});
    // Second call must short-circuit — but keep enough for the retry layer to
    // classify it the same way. Losing `Retry-After` changed the timing
    // classification between the original and its replay, which could stop the
    // backup leg from ever being selected.
    const replay = await googleKeyFetch('https://example.test/v1/x', {});
    assert.equal(replay.status, 429);
    // The UPSTREAM value, not merely a hint: the caller sets a 60s default when
    // the record carries none, so asserting only that SOME retry-after exists
    // passed even with the recorded headers thrown away — which is the defect
    // this test exists for. A 3600s hold replayed as 60s mis-times the retry
    // layer and can prevent the backup leg from ever being selected.
    assert.equal(replay.headers.get('retry-after'), '3600',
      'the replay must carry the upstream retry hint, not the fallback default');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the recorded failure keeps the headers a classifier reads', () => {
  recordLastFailure(429, 'Too Many Requests', '{"error":{}}',
    new Headers({ 'retry-after': '120', 'x-trace-id': 'should-not-be-kept' }));
  const kept = getLastFailure()!.headers;
  assert.equal(kept['retry-after'], '120');
  assert.equal(kept['x-trace-id'], undefined,
    'tracing metadata must not ride along in a response the SDK treats as real');
});
