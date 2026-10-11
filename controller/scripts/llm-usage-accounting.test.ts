// Every billed provider call reaches the record — and so the daily token cap
// (telemetry/log.ts record() counts failure usage too, #1195). The primitives
// run for real; only the model's doGenerate is replaced, each call billing a
// fixed 3 tokens, so a record's usage.total / 3 is the number of calls it saw.
//
// Pinned paths, each of which used to drop usage:
//   - objectViaToolCall's declined forced `emit` (ToolChoiceViolationError)
//   - djObject's attempt 1 when attempt 2 runs (success and failure)
//   - djAgent's native leg ending on its step cap (output getter throws)
//   - djAgent's terminal collapse declining, then a salvage miss
//   - djAgent's earlier legs when a later leg throws
// Plus the done-only recovery carrying EVERY discovery step, not the last one.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { z } from 'zod';

const previousStateDir = process.env.STATE_DIR;
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-usage-accounting-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { djObject, djAgent } = await import('../src/llm/sdk.js');
const { recentCalls } = await import('../src/llm/log.js');
const { objectViaToolCall } = await import('../src/llm/internal/strategy/object-via-tool.js');
const previousCache = store.peek();
const schema = z.object({ name: z.string() });

after(() => {
  store.setCache(previousCache);
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  rmSync(stateRoot, { recursive: true, force: true });
});

const PER_CALL = 3;
const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
});
const call = (toolName: string, input: unknown, id = toolName) => ({
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
});

function configure(t: TestContext, provider: string, llm: Record<string, unknown> = {}) {
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, llm: {
    ...defaults.llm, provider, model: 'usage-primary', ...llm,
    fallback: { ...defaults.llm.fallback, enabled: false },
  } });
  recentCalls.length = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider traffic'); });
  return primaryLeg();
}

type Options = { tools?: Array<{ name: string }>; prompt: Array<{ role: string; content: unknown }> };
const toolNames = (o: Options) => (o.tools || []).map((tl) => tl.name).sort().join(',');

function mockModel(t: TestContext, leg: ReturnType<typeof primaryLeg>, respond: (o: Options, n: number) => unknown) {
  let n = 0;
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', async (o: Options) => respond(o, n++));
  }
  return () => n;
}

const lastRecord = () => recentCalls[0];

// A discovery tool that answers, so the loop keeps stepping.
const tools = {
  sample: { description: 'look up tracks', inputSchema: z.object({}), execute: async () => [{ id: 't1' }] },
};

test('a declined forced emit throws with its billed usage and the prose it wrote', async (t) => {
  const leg = configure(t, 'ollama');
  mockModel(t, leg, () => text('I would pick something calm.'));
  const err: any = await objectViaToolCall(leg, { prompt: 'pick', schema }).then(() => null, (e) => e);
  assert.ok(err, 'a declined emit throws');
  assert.equal(err.usage?.totalTokens, PER_CALL, 'the billed call rides on the error');
  assert.equal(err.text, 'I would pick something calm.', 'the declining prose rides on the error');
});

test('djObject counts attempt 1 when attempt 2 rescues it', async (t) => {
  const leg = configure(t, 'ollama');
  const calls = mockModel(t, leg, (o) => (toolNames(o) === 'emit' ? text('prose, not a tool call') : text('{"name":"ok"}')));
  assert.deepEqual(await djObject({ prompt: 'name it', schema }), { name: 'ok' });
  assert.equal(calls(), 2);
  assert.equal(lastRecord()?.ok, true);
  assert.equal(lastRecord()?.usage?.total, 2 * PER_CALL, 'both attempts are on the success record');
});

test('djObject counts both attempts when both fail', async (t) => {
  const leg = configure(t, 'ollama');
  const calls = mockModel(t, leg, () => text('no JSON here at all'));
  await assert.rejects(djObject({ prompt: 'name it', schema }));
  assert.equal(calls(), 2);
  assert.equal(lastRecord()?.ok, false);
  assert.equal(lastRecord()?.usage?.total, 2 * PER_CALL, 'both attempts are on the failure record');
});

test('djAgent counts a native leg that hits its step cap before falling back', async (t) => {
  const leg = configure(t, 'openai');
  // Native leg: only `sample` is offered, and the model never stops calling it,
  // so the run ends on the step cap and its output getter throws. The done-tool
  // main run then explores once and commits.
  const calls = mockModel(t, leg, (o) => (toolNames(o) === 'done' ? call('done', { name: 'ok' }) : call('sample', {})));
  const r = await djAgent({
    system: 'Pick', messages: [{ role: 'user', content: 'pick' }], tools, schema, maxSteps: 3,
  });
  assert.deepEqual(r.object, { name: 'ok' });
  assert.equal(calls(), 3 + 2, 'three native steps, then discovery + done');
  assert.equal(lastRecord()?.ok, true);
  assert.equal(lastRecord()?.usage?.total, 5 * PER_CALL, 'the native leg is on the record');
});

test('djAgent counts every leg when the terminal collapse declines too', async (t) => {
  const leg = configure(t, 'ollama');
  // Prose on every call: main declines, recovery declines, the terminal
  // collapse's forced emit declines, and text salvage finds no JSON.
  const calls = mockModel(t, leg, () => text('just chatting, no tool'));
  await assert.rejects(djAgent({ system: 'Pick', messages: [{ role: 'user', content: 'pick' }], tools, schema }));
  assert.equal(calls(), 3);
  assert.equal(lastRecord()?.ok, false);
  assert.equal(lastRecord()?.usage?.total, 3 * PER_CALL, 'main + recovery + terminal collapse');
});

test('djAgent keeps earlier legs\' spend when a later leg throws', async (t) => {
  const leg = configure(t, 'ollama');
  // Main run declines (billed); the recovery call then fails at the provider.
  const calls = mockModel(t, leg, (_o, n) => {
    if (n === 0) return text('declining the tool');
    throw Object.assign(new Error('bad request'), { statusCode: 400 });
  });
  await assert.rejects(djAgent({ system: 'Pick', messages: [{ role: 'user', content: 'pick' }], tools, schema }), /bad request/);
  assert.equal(calls(), 2);
  assert.equal(lastRecord()?.ok, false);
  assert.equal(lastRecord()?.usage?.total, PER_CALL, 'the declined main run is still counted');
});

test('the done-only recovery carries every discovery step, not just the last', async (t) => {
  const leg = configure(t, 'ollama', { discoverySteps: 2 });
  let recoveryPrompt: Options['prompt'] | null = null;
  mockModel(t, leg, (o, n) => {
    if (toolNames(o) === 'sample') return call('sample', {}, `sample-${n}`);
    // Main run's forced `done` step declines; the recovery answers.
    if (recoveryPrompt === null && n === 2) return text('declining');
    recoveryPrompt = o.prompt;
    return call('done', { name: 'ok' });
  });
  const r = await djAgent({
    system: 'Pick', messages: [{ role: 'user', content: 'pick' }], tools, schema, providerDiscoveryBudget: true,
  });
  assert.deepEqual(r.object, { name: 'ok' });
  assert.ok(recoveryPrompt, 'the recovery leg ran');
  const discoveryCalls = (recoveryPrompt as Options['prompt'])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p?.type === 'tool-call' && p.toolName === 'sample');
  assert.equal(discoveryCalls.length, 2, 'both discovery steps reach the recovery prompt');
});
