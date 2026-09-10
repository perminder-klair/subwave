// Tests for music/analyzer.ts `resolveBackend` — how long a MISS is remembered.
//
// The bug this pins (#1591, surfaced by #1586): the resolver cached only a
// non-null answer, so every caller with no backend re-ran the probe. On a
// station whose candidate host simply does not resolve that costs a DNS miss.
// On one pointing at a host that silently DROPS packets it costs probeSidecar's
// full 5s timeout per candidate per call, which on a bulk tagging pass is 5s of
// dead time per track. The fast DNS-miss path people assume they are on is the
// case where the box is simply gone; the expensive one is the box that is there
// and not answering. Since #1636 the list is never empty — it defaults to the
// compose sidecar — so the miss cache is what every backend-less station pays
// instead of a probe per caller.
//
// The fix is a TIMED miss cache, and both halves matter: caching the miss
// forever would mean a controller that probed during its own boot never sees
// the analyzer container come up behind it.
//
// Run: `tsx scripts/analyzer-backend-cache.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import test from 'node:test';

// Set before importing the module under test: config.ts reads the environment
// once, at import. A short interval keeps the expiry test a few milliseconds
// rather than a minute. ANALYZE_PYTHON stays empty so `localConfigured()` is
// false and the miss is a real miss.
process.env.ANALYZE_URL = 'http://127.0.0.1:9';
process.env.ANALYZE_PYTHON = '';
process.env.ANALYZE_PROBE_MS = '40';

const analyzer = await import('../src/music/analyzer.js');

let probes = 0;
const realFetch = globalThis.fetch;
// A host that is reachable-ish but useless: the probe swallows the rejection
// and reports "not reachable", which is the branch the miss cache guards. The
// real 5s cost is the timeout; the count is what proves it is paid once.
globalThis.fetch = (async () => {
  probes++;
  throw new Error('connection refused');
}) as typeof fetch;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a miss is probed once, not once per caller', async () => {
  analyzer._resetBackendCacheForTests();
  probes = 0;
  assert.equal(await analyzer.resolveBackend(), null);
  assert.equal(await analyzer.resolveBackend(), null);
  assert.equal(await analyzer.isAvailable(), false);
  assert.equal(probes, 1, 'three callers inside the interval share one probe');
});

test('the miss expires, so a backend that comes up later is found', async () => {
  analyzer._resetBackendCacheForTests();
  probes = 0;
  await analyzer.resolveBackend();
  await sleep(60);
  await analyzer.resolveBackend();
  assert.equal(probes, 2, 'past the interval the resolver asks again');
});

test('a resolved backend is still remembered for the process lifetime', async () => {
  analyzer._resetBackendCacheForTests();
  probes = 0;
  globalThis.fetch = (async () => {
    probes++;
    return new Response(JSON.stringify({ ok: true, engines: ['analyze'] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  assert.equal(await analyzer.resolveBackend(), 'sidecar');
  await sleep(60);
  assert.equal(await analyzer.resolveBackend(), 'sidecar');
  assert.equal(analyzer.backendLabel(), 'sidecar');
  assert.equal(probes, 1, 'a hit is not re-probed — only the miss is timed');
});

test.after(() => {
  globalThis.fetch = realFetch;
  analyzer._resetBackendCacheForTests();
});
