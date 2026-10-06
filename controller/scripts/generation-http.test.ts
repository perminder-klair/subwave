// Real SDK adapters and local HTTP stubs exercise complete response consumption,
// strategy recovery, failover attribution and the live admin health contract.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { tool } from 'ai';
import { z } from 'zod';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-generation-http-'));
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
process.env.DEEPSEEK_API_KEY = 'unused';
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { djText, djObject, djAgent } = await import('../src/llm/sdk.js');
const { recentCalls, generationHealthSnapshot } = await import('../src/llm/log.js');
const { primaryLeg, probeLegReachable } = await import('../src/llm/provider.js');
const { checkLlm } = await import('../src/doctor/checks-services.js');
const { router: doctorRouter } = await import('../src/routes/doctor.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const schema = z.object({ ok: z.boolean() });
const messages = [{ role: 'user' as const, content: 'test' }];
const tools = { discover: tool({ inputSchema: z.object({}), execute: async () => 'discovered' }) };

async function listen(server: Server, t: TestContext) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(t: TestContext, stallAt = 1, stallBody = true) {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let fallbackStalls = false;
  function reply(res: any, body: any, decline = false) {
    const name = body.tools?.some((v: any) => v.function.name === 'emit') ? 'emit' : body.tools?.some((v: any) => v.function.name === 'done') ? 'done' : undefined;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'test', choices: [{ index: 0, finish_reason: name && !decline ? 'tool_calls' : 'stop', message: { role: 'assistant', content: name && !decline ? null : '{"ok":true}', ...(name && !decline ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: '{"ok":true}' } }] } : {}) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
  const primary = await listen(createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('{"models":[]}'); return; }
    primaryCalls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (primaryCalls >= stallAt) {
      if (stallBody) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"id":'); }
      return;
    }
    reply(res, JSON.parse(raw), true);
  }), t);
  const fallback = await listen(createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('{"models":[]}'); return; }
    fallbackCalls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (fallbackStalls) return;
    reply(res, JSON.parse(raw));
  }), t);
  writeFileSync(path.join(process.env.STATE_DIR!, 'settings.json'), JSON.stringify({ llm: { provider: 'openai-compatible', model: 'test', baseUrl: `${primary}/v1`, requestTimeoutMs: 5000, fallback: { enabled: true, provider: 'openai-compatible', model: 'backup', baseUrl: `${fallback}/v1` } } }));
  setCache(null);
  await settings.load();
  // Short injected test budget only; persisted/live settings clamps stay intact.
  settings.get().llm.requestTimeoutMs = 100;
  recentCalls.length = 0;
  return { primary, fallback, counts: () => [primaryCalls, fallbackCalls], stallFallback: () => { fallbackStalls = true; } };
}

test('text timeout covers a body stalled after headers, records both legs, and leaves responsive primary degraded', async (t) => {
  const f = await fixture(t);
  const pending = djText({ system: 'test', prompt: 'SECRET' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(generationHealthSnapshot().inFlightCount, 1);
  assert.equal(await probeLegReachable(primaryLeg()), true);
  assert.equal(await pending, '{"ok":true}');
  assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(recentCalls.length, 2);
  assert.equal(recentCalls.filter((r) => r.ok).length, 1);
  assert.ok(recentCalls.some((r) => r.via.includes('failover')));
  const health = generationHealthSnapshot();
  assert.equal(health.inFlightCount, 0);
  assert.equal(health.status, 'fail');
  assert.ok(!JSON.stringify(health).includes('SECRET'));
  const findings = await checkLlm(settings.get());
  assert.equal(findings.find((r) => r.label === 'provider')?.status, 'ok');
  assert.equal(findings.find((r) => r.label === 'generation health')?.status, 'fail');
});

test('object timeout skips semantic recovery, while fallback and pinned requests remain independently bounded', async (t) => {
  const f = await fixture(t, 1, false);
  assert.deepEqual(await djObject({ prompt: 'test', schema }), { ok: true });
  assert.deepEqual(f.counts(), [1, 1]);
  await assert.rejects(djObject({ prompt: 'test', schema, leg: 'primary' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.deepEqual(f.counts(), [2, 1]);
  f.stallFallback();
  await assert.rejects(djObject({ prompt: 'test', schema, leg: 'fallback' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.deepEqual(f.counts(), [2, 2]);
  await assert.rejects(djObject({ prompt: 'test', schema }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.deepEqual(f.counts(), [3, 3]);
  settings.get().llm.fallback.enabled = false;
  await assert.rejects(djText({ prompt: 'test' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.deepEqual(f.counts(), [4, 3]);
  settings.get().llm.fallback.enabled = true;
  settings.get().llm.fallback.provider = 'openai';
  settings.get().llm.fallback.model = '';
  await assert.rejects(djText({ prompt: 'test' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.deepEqual(f.counts(), [5, 3]);
});

for (const [label, stallAt] of [['no-tools', 1], ['main', 1], ['recovery', 2], ['terminal', 3]] as const) {
  test(`agent ${label} provider timeout exits recovery and tries fallback once`, async (t) => {
    const f = await fixture(t, stallAt);
    const result = await djAgent({ system: 'test', messages, tools: label === 'no-tools' ? {} : tools, schema, timeoutMs: 2000 });
    assert.deepEqual(result.object, { ok: true });
    assert.deepEqual(f.counts(), [stallAt, label === 'no-tools' ? 1 : 2], 'one fallback leg, with its normal discovery and forced-done generations');
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  });
}

for (const primitive of ['text', 'object'] as const) {
  test(`${primitive} caller cancellation preserves reason and never fails over`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const reason = new Error('simple-segment deadline exceeded');
    const run = () => primitive === 'text' ? djText({ prompt: 'test', signal: controller.signal }) : djObject({ prompt: 'test', schema, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(run(), (e: any) => e.code === 'GENERATION_CANCELLED' && e.cause === reason);
    assert.deepEqual(f.counts(), [0, 0]);
    const live = new AbortController();
    const pending = primitive === 'text' ? djText({ prompt: 'test', signal: live.signal }) : djObject({ prompt: 'test', schema, signal: live.signal });
    setTimeout(() => live.abort(reason), 40);
    await assert.rejects(pending, (e: any) => e.code === 'GENERATION_CANCELLED' && e.cause === reason);
    assert.deepEqual(f.counts(), [1, 0]);
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  });
}

test('native object and native agent timeouts do not become schema repair or done-tool retries', async (t) => {
  const f = await fixture(t);
  settings.get().llm.provider = 'deepseek';
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.deepseek.com') return original(`${f.primary}/v1/chat/completions`, init);
    assert.equal(url.hostname, '127.0.0.1', 'fixture must never access an external provider');
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  assert.deepEqual(await djObject({ prompt: 'test', schema }), { ok: true });
  assert.deepEqual(f.counts(), [1, 1]);
  const result = await djAgent({ system: 'test', messages, tools, schema, timeoutMs: 2000 });
  assert.deepEqual(result.object, { ok: true });
  assert.deepEqual(f.counts(), [2, 3], 'object fallback then one agent fallback leg (discovery + done)');
});

test('live generation diagnostics require admin; public health remains liveness even after timeout', async (t) => {
  await fixture(t);
  await djText({ prompt: 'test' });
  const app = express();
  app.use(doctorRouter, publicRouter);
  const base = await listen(createServer(app), t);
  assert.equal((await fetch(`${base}/doctor/llm`)).status, 401);
  const response = await fetch(`${base}/doctor/llm`, { headers: { Authorization: `Basic ${Buffer.from('test:test').toString('base64')}` } });
  assert.equal(response.status, 200);
  const health = z.object({
    status: z.string(), inFlightCount: z.number(), scope: z.string(),
  }).parse(await response.json());
  assert.equal(health.status, 'fail');
  assert.equal(health.inFlightCount, 0);
  assert.match(health.scope, /process-local/);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'on-air' });
});

test('concurrent roles identify distinct endpoints, but the same target is not counted as two capacity pools', async (t) => {
  const f = await fixture(t);
  f.stallFallback();
  for (const sameTarget of [false, true]) {
    if (sameTarget) settings.get().llm.fallback.baseUrl = settings.get().llm.baseUrl;
    const pending = ['primary', 'fallback'].map((leg) => djObject({ prompt: 'test', schema, leg }).catch((e) => e));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const active = generationHealthSnapshot().requests;
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map((r) => r.leg)).size, 2);
    assert.equal(new Set(active.map((r) => r.targetId)).size, sameTarget ? 1 : 2);
    for (const error of await Promise.all(pending)) assert.equal(error.code, 'PROVIDER_REQUEST_TIMEOUT');
    assert.equal(generationHealthSnapshot().inFlightCount, 0);
  }
});
