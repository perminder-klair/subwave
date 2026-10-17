// /stats `llm.deadlineHits`: the failed calls that ran out the agent deadline,
// which the Dash DJ Latency gauge redlines on now that its needle reads
// successful calls only (#1972 review). Pinned on the record shapes withFailover
// actually writes, and through the route, which owns the deadline.
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { listen } from './test-utils/http.js';
import { coldLoadSettings } from './test-utils/settings.js';

process.env.ADMIN_USER = 'stats-admin';
process.env.ADMIN_PASS = 'stats-test';

const { summarizeLlm, isDeadlineHit } = await import('../src/stats.js');
const { GenerationCancelledError } = await import('../src/llm/internal/core/generation.js');
const { failureDiagnostics } = await import('../src/llm/internal/core/pure.js');
const { recentCalls } = await import('../src/llm/log.js');
const { router } = await import('../src/routes/stats.js');

// What recordFailure writes for djObject: the message plus failExtra's diagnostics.
function cancelled(ms: number, reason: Error) {
  const err = new GenerationCancelledError(reason);
  return { kind: 'segment', ok: false, ms, error: err.message, ...failureDiagnostics(err as Parameters<typeof failureDiagnostics>[0]) };
}

test('deadlineHits counts failed calls that ran out the agent deadline, and nothing else', () => {
  const hits = [
    { ok: false, ms: 45_003, error: 'sdk.djAgent agent run exceeded 45000ms deadline' },
    { ok: false, ms: 45_000, error: 'sdk.djAgent agent recovery — no time left on the shared deadline' },
    { ok: false, ms: 60_000, error: 'request timed out' },
    // The simple-segment / co-hosted wrappers cancel AT the deadline; their
    // timer starts before withFailover's clock, so the record can land short.
    cancelled(44_999, new Error('segment call exceeded 45000ms deadline')),
  ];
  const misses = [
    { ok: false, ms: 1_200, error: 'quota exceeded' },
    { ok: true, ms: 50_000 }, // a slow success is the needle's job
    cancelled(50_000, new Error('show changed')), // the caller walked away
    { ok: false, error: 'no duration' },
  ];
  for (const c of hits) assert.equal(isDeadlineHit(c, 45_000), true, JSON.stringify(c));
  for (const c of misses) assert.equal(isDeadlineHit(c, 45_000), false, JSON.stringify(c));
  const calls = [...hits, ...misses];
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 45_000 }).deadlineHits, 4);
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 120_000 }).deadlineHits, 1, 'only the deadline-cause cancellation');
  assert.equal(summarizeLlm(calls).deadlineHits, null, 'no deadline, no judgement');
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 45_000 }).failed, 7, 'failed still counts every failure');
});

test('GET /stats judges deadline hits against the live agent deadline', async (t) => {
  await coldLoadSettings({ llm: { agentTimeoutMs: 30_000 } });
  recentCalls.length = 0;
  recentCalls.push(
    { kind: 'pick', ok: false, ms: 30_000, error: 'sdk.djAgent agent run exceeded 30000ms deadline' },
    { kind: 'pick', ok: false, ms: 31_500, error: 'sdk.djAgent agent run exceeded 30000ms deadline' },
    { kind: 'link', ok: false, ms: 20_000, error: 'upstream 503' },
    { kind: 'pick', ok: true, ms: 4_000 },
  );
  t.after(() => { recentCalls.length = 0; });
  const app = express();
  app.use(router);
  const srv = await listen(app);
  t.after(() => srv.close());
  const res = await fetch(`${srv.url}/stats`, {
    headers: { Authorization: `Basic ${Buffer.from('stats-admin:stats-test').toString('base64')}` },
  });
  assert.equal(res.status, 200);
  const { llm } = (await res.json()) as {
    llm: { agentTimeoutMs: number; deadlineHits: number | null; failed: number; okLatency: { p95: number } };
  };
  assert.equal(llm.agentTimeoutMs, 30_000);
  assert.equal(llm.deadlineHits, 2);
  assert.equal(llm.failed, 3);
  assert.equal(llm.okLatency.p95, 4_000);
});
