// Run the actual primitives, replacing only model generation. Settings, SDK
// validation, strategy recovery, failover and telemetry all remain real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { z } from 'zod';
import type { MockLanguageModelV3 } from 'ai/test';

const previousStateDir = process.env.STATE_DIR;
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-strategy-failover-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg, fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
const { djObject, djAgent } = await import('../src/llm/sdk.js');
const { recentCalls } = await import('../src/llm/log.js');
const { GenerationCancelledError } = await import('../src/llm/internal/core/generation.js');
const previousCache = store.peek();
const schema = z.object({ name: z.string() });
const answer = { name: 'backup' };
const tools = { sample: { inputSchema: z.object({}) } };

after(() => {
  store.setCache(previousCache);
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  rmSync(stateRoot, { recursive: true, force: true });
});

function configure(t: TestContext, provider: string, backup = true) {
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, llm: {
    ...defaults.llm, provider, model: 'strategy-primary',
    fallback: { ...defaults.llm.fallback, enabled: backup, provider: 'openai', model: 'strategy-backup' },
  } });
  recentCalls.length = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider traffic'); });
  return { primary: primaryLeg(), backup: fallbackLeg() };
}

function response(text: string, toolName?: string): Awaited<ReturnType<MockLanguageModelV3['doGenerate']>> {
  return {
    content: toolName
      ? [{ type: 'tool-call', toolCallId: 'answer', toolName, input: text }]
      : [{ type: 'text', text }],
    finishReason: { unified: toolName ? 'tool-calls' : 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

function mockGeneration(t: TestContext, leg: ReturnType<typeof primaryLeg>, generate: () => Promise<ReturnType<typeof response>>) {
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', generate);
  }
}

function nativeAgentAnswer(): ReturnType<typeof response> {
  const result = response(JSON.stringify(answer));
  // Native output must include discovery to be accepted by the actual agent.
  return { ...result, content: [...result.content,
    { type: 'tool-call', toolCallId: 'sample', toolName: 'sample', input: '{}' },
  ] };
}

const paths = [
  { name: 'native djObject', provider: 'openai', via: 'ai-sdk', agent: false },
  { name: 'forced-tool djObject', provider: 'ollama', via: 'ai-sdk:tool', agent: false },
  { name: 'native-first djAgent', provider: 'openai', via: 'ai-sdk:agent:native', agent: true },
];

for (const entry of paths) {
  for (const outcome of ['success', 'disabled', 'failed'] as const) {
    test(`${entry.name} with ${outcome} backup makes exactly one permanent primary attempt`, async (t) => {
      const legs = configure(t, entry.provider, outcome !== 'disabled');
      const primaryError = Object.assign(new Error('model strategy-primary has been retired'), {
        statusCode: 503, data: { error: { code: 'model_terminated' } },
      });
      const backupError = new Error('model strategy-backup not found');
      const counts = { primary: 0, backup: 0 };
      mockGeneration(t, legs.primary, async () => { counts.primary++; throw primaryError; });
      if (legs.backup) mockGeneration(t, legs.backup, async () => {
        counts.backup++;
        if (outcome === 'failed') throw backupError;
        return entry.agent ? nativeAgentAnswer() : response(JSON.stringify(answer));
      });
      const run = entry.agent
        ? djAgent({ system: 'Choose a name', messages: [{ role: 'user', content: 'Choose' }], tools, schema })
        : djObject({ prompt: 'Choose a name', schema });
      if (outcome === 'success') {
        const result = await run;
        assert.deepEqual(entry.agent ? result.object : result, answer);
      } else {
        await assert.rejects(run, (err) => err === (outcome === 'disabled' ? primaryError : backupError));
      }
      assert.deepEqual(counts, { primary: 1, backup: outcome === 'disabled' ? 0 : 1 });
      const failure = recentCalls.find((call) => call.model === `${entry.provider}:strategy-primary`);
      assert.equal(failure?.ok, false);
      assert.equal(failure?.error, primaryError.message);
      assert.equal(failure?.via, outcome === 'disabled' ? entry.via : `${entry.via}:failover→openai:strategy-backup`);
    });
  }
}

for (const entry of paths) {
  for (const control of ['cancelled', 'deadline'] as const) {
    test(`${entry.name} does not fail over a ${control} error containing retirement wording`, async (t) => {
      const legs = configure(t, entry.provider);
      const retirement = new Error('model strategy-primary has been retired');
      const error = control === 'cancelled' ? new GenerationCancelledError(retirement)
        : Object.assign(retirement, { name: 'AgentDeadlineError' });
      if (control === 'cancelled') error.message += `: ${retirement.message}`;
      const counts = { primary: 0, backup: 0 };
      mockGeneration(t, legs.primary, async () => { counts.primary++; throw error; });
      mockGeneration(t, legs.backup!, async () => { counts.backup++; return nativeAgentAnswer(); });
      const run = entry.agent
        ? djAgent({ system: 'Choose a name', messages: [{ role: 'user', content: 'Choose' }], tools, schema })
        : djObject({ prompt: 'Choose a name', schema });
      await assert.rejects(run, (err) => err === error);
      assert.deepEqual(counts, { primary: 1, backup: 0 });
      assert.equal(recentCalls.length, 1);
      assert.equal(recentCalls[0].ok, false);
      assert.equal(recentCalls[0].via, entry.via);
    });
  }
}

for (const provider of ['openai', 'ollama']) {
  test(`${provider} djObject still recovers from malformed structured output on the primary`, async (t) => {
    const { primary } = configure(t, provider);
    let calls = 0;
    mockGeneration(t, primary, async () => response(++calls === 1 ? 'not an object' : JSON.stringify(answer)));
    assert.deepEqual(await djObject({ prompt: 'Choose a name', schema }), answer);
    assert.equal(calls, 2);
    assert.equal(recentCalls[0].model, `${provider}:strategy-primary`);
    assert.equal(recentCalls[0].via, 'ai-sdk:recovery');
  });
}

test('native-first djAgent still recovers from malformed output through the primary done tool', async (t) => {
  const { primary } = configure(t, 'openai');
  let calls = 0;
  mockGeneration(t, primary, async () => ++calls === 1
    ? response('not an object') : response(JSON.stringify(answer), 'done'));
  const result = await djAgent({ system: 'Choose a name', messages: [{ role: 'user', content: 'Choose' }], tools, schema });
  assert.deepEqual(result.object, answer);
  // The main run's gated discovery excludes done; done-only recovery then
  // accepts the next response, preserving the existing recovery cascade.
  assert.equal(calls, 3);
  assert.equal(recentCalls[0].model, 'openai:strategy-primary');
});

test('a permanent error during agent terminal recovery reaches the backup without text salvage masking it', async (t) => {
  const legs = configure(t, 'ollama');
  const error = new Error('model strategy-primary has been retired');
  const counts = { primary: 0, backup: 0 };
  mockGeneration(t, legs.primary, async () => {
    if (++counts.primary === 3) throw error;
    return response('no answer');
  });
  mockGeneration(t, legs.backup!, async () => { counts.backup++; return nativeAgentAnswer(); });
  const result = await djAgent({ system: 'Choose a name', messages: [{ role: 'user', content: 'Choose' }], tools, schema, maxSteps: 1 });
  assert.deepEqual(result.object, answer);
  assert.deepEqual(counts, { primary: 3, backup: 1 });
  const failure = recentCalls.find((call) => call.model === 'ollama:strategy-primary');
  assert.equal(failure?.error, error.message);
  assert.equal(failure?.via, 'ai-sdk:agent:terminal:failover→openai:strategy-backup');
});

test('tool-choice refusal preserves executed discovery and usage through terminal recovery', async t => {
  const { primary } = configure(t, 'ollama', false);
  let calls = 0;
  let executions = 0;
  let terminalPrompt = '';
  const candidate = { name: 'verified-candidate-123' };
  for (const model of new Set([primary.model, primary.noThinkModel])) {
    t.mock.method(model, 'doGenerate', async options => {
      calls++;
      if (calls === 1) return response('{}', 'sample');
      if (calls < 4) return response('I decline to call done.');
      terminalPrompt = JSON.stringify(options.prompt);
      return response(JSON.stringify(candidate), 'emit');
    });
  }
  const result = await djAgent({
    system: 'Choose a discovered candidate',
    messages: [{ role: 'user', content: 'Choose' }],
    tools: { sample: {
      inputSchema: z.object({}),
      execute: async () => { executions++; return [candidate]; },
    } },
    schema,
  });
  assert.deepEqual(result.object, candidate);
  assert.equal(executions, 1, 'completed discovery must not execute again during recovery');
  assert.equal(calls, 4, 'one discovery, one main refusal, one recovery refusal, one terminal call');
  assert.ok(terminalPrompt.includes(candidate.name), 'the terminal prompt must carry the actual discovery result');
  assert.deepEqual(result.toolCalls, [{ name: 'sample', args: {}, result: [candidate] }]);
  assert.deepEqual(recentCalls[0].usage, { input: 4, output: 4, total: 8 });
  assert.equal(recentCalls[0].via, 'ai-sdk:agent:terminal');
});
