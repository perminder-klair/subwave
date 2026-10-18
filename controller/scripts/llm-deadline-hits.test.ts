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
    // The Leanings review's withDeadline is armed before withFailover's clock
    // too, and its AgentDeadlineError is recorded as-is, naming the budget.
    { ok: false, ms: 44_996, error: 'djAgentLeaningsReview exceeded 45000ms deadline' },
  ];
  const misses = [
    { ok: false, ms: 1_200, error: 'quota exceeded' },
    { ok: false, ms: 10_002, error: 'Shortlist search preparation exceeded 10000ms deadline' }, // a budget of its own
    { ok: true, ms: 50_000 }, // a slow success is the needle's job
    cancelled(50_000, new Error('show changed')), // the caller walked away
    { ok: false, error: 'no duration' },
  ];
  for (const c of hits) assert.equal(isDeadlineHit(c, 45_000), true, JSON.stringify(c));
  for (const c of misses) assert.equal(isDeadlineHit(c, 45_000), false, JSON.stringify(c));
  const calls = [...hits, ...misses];
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 45_000 }).deadlineHits, 5);
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 120_000 }).deadlineHits, 1, 'only the deadline-cause cancellation');
  assert.equal(summarizeLlm(calls).deadlineHits, null, 'no deadline, no judgement');
  assert.equal(summarizeLlm(calls, { agentTimeoutMs: 45_000 }).failed, 9, 'failed still counts every failure');
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

test('the deadline records the real primitives write are counted', async (t) => {
  // Hand-built records can drift from what withFailover writes, so drive the
  // real djAgent and djObject against a model that never answers.
  const store = await import('../src/settings/store.js');
  const settings = await import('../src/settings.js');
  const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
  const { djAgent, djObject, withDeadline } = await import('../src/llm/sdk.js');
  const { resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');
  const { z } = await import('zod');
  const deadline = 200;
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, llm: { ...defaults.llm, provider: 'ollama', model: 'hangs', agentTimeoutMs: deadline,
    fallback: { ...defaults.llm.fallback, enabled: false } } });
  resetFailoverStickyForTest();
  t.after(() => { recentCalls.length = 0; resetFailoverStickyForTest(); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider traffic'); });
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', (opts: { abortSignal?: AbortSignal }) => new Promise((_, reject) => {
      opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason), { once: true });
    }));
  }
  const schema = z.object({ name: z.string() });
  const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* building the prompt */ } };

  recentCalls.length = 0;
  await assert.rejects(djAgent({ system: 's', messages: [{ role: 'user', content: 'pick' }], schema, kind: 'djAgentPick',
    tools: { sample: { inputSchema: z.object({}), execute: async () => ({ found: 1 }) } }, timeoutMs: deadline }));
  // The Leanings review's shape: withDeadline at the agent deadline around a
  // djObject that starts its own clock only after the prompt is built.
  let review: Promise<unknown> | undefined;
  await assert.rejects(withDeadline(deadline, 'djAgentLeaningsReview', async (signal) => {
    busy(20);
    review = djObject({ prompt: 'review', schema, kind: 'djAgentLeaningsReview', signal });
    return review;
  }));
  await review?.catch(() => {}); // the deadline rejects first; the record lands as the call unwinds
  // The simple-segment wrapper's shape (skills/_agent.ts deadlinedSegmentObject).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`segment call exceeded ${deadline}ms deadline`)), deadline);
  busy(20);
  await assert.rejects(djObject({ prompt: 'segment', schema, kind: 'segment', signal: ac.signal }));
  clearTimeout(timer);

  const byKind = new Map(recentCalls.map(c => [c.kind, c]));
  for (const kind of ['djAgentPick', 'djAgentLeaningsReview', 'segment']) {
    const record = byKind.get(kind);
    assert.ok(record, `${kind} was recorded`);
    assert.equal(isDeadlineHit(record, deadline), true, `${kind}: ${JSON.stringify({ ms: record.ms, error: record.error })}`);
  }
});
