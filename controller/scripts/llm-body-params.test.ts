// settings.llm.bodyParams / llm.toolCallBodyParams (and the fallback leg's
// own pair) — the operator's extra request-body fields for the
// openai-compatible / locca transport (issue #2296).
//
// A hosted Qwen3 (Hetzner Inference) thinks by default and SUB/WAVE's toggle
// sends nothing there (#1693 keeps hosted bodies clean), so the operator needs
// to say `enable_thinking: false` in the server's own words. Thinking is also
// what breaks a forced tool call (#914, and a 400 on DeepSeek/DashScope), so
// a second list is laid over the first on the no-think client only. The rules
// pinned here:
//   1. the normal client adds every request field the SDK didn't set;
//   2. the no-think client (every forced-tool and structured call) adds the
//      request fields overlaid by the tool-call overrides, where `null` removes
//      a key — on each forced leg kind;
//   3. each leg reads its own lists, and a swap moves them with the leg;
//   4. both lists key the client cache, and a hosted no-think client is its
//      own instance only when there are overrides;
//   5. empty lists are byte-identical to a station without the field;
//   6. reserved keys are refused at save time in both lists;
//   7. a provider other than openai-compatible / locca never reads them.
// Plus the cold-load round trip every new settings field needs (#1327).
//
// No credentials and no external host.

import assert from 'node:assert/strict';
import { chatCompletionResponse } from './test-utils/llm.js';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-body-params-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { languageModel, operatorBodyParams } = await import('../src/llm/internal/provider/registry.js');
const { primaryLeg, fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
const { objectViaToolCall } = await import('../src/llm/internal/strategy/object-via-tool.js');
const { planLlmSwap } = await import('../src/settings/llm-swap.js');
const { generateText, tool } = await import('ai');
const { z } = await import('zod');

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

// What an operator following the Hetzner preset plus a budget would save.
const REQUEST = rows({ enable_thinking: 'true', thinking_budget: '512', top_k: '20' });
const OVERRIDES = rows({ enable_thinking: 'false', thinking_budget: 'null' });

const HOSTED = { provider: 'openai-compatible', model: 'Qwen/Qwen3.6-35B-A3B-FP8', baseUrl: 'https://inference.example/v1', compatibleMode: 'hosted' };
const LOCAL = { provider: 'openai-compatible', model: 'qwen3', baseUrl: 'http://127.0.0.1:9/v1', compatibleMode: 'local' };

async function coldLoad(llm: Record<string, unknown>) { return (await coldLoadSettings({ llm })).llm; }

const toolNames = (body: Record<string, any>): string[] =>
  Array.isArray(body.tools) ? body.tools.map((t: any) => t.function?.name) : [];

// Chat-completion stand-in: a forced choice calls `done` when offered (else
// the first tool), a first unforced turn with tools calls a discovery tool,
// a response_format request gets unparseable text (so djObject falls to its
// text recovery), and anything else answers the JSON object.
function chatReply(body: Record<string, any>): Response {
  const names = toolNames(body);
  const hasToolResult = (body.messages || []).some((m: any) => m.role === 'tool');
  const forced = body.tool_choice === 'required';
  let message: Record<string, unknown>;
  let finishReason = 'stop';
  if (names.length && (forced || !hasToolResult)) {
    const name = forced && names.includes('done') ? 'done' : names.find(n => n !== 'done') || names[0];
    const args = name === 'search' ? { query: 'x' } : { id: 'a' };
    message = { role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    finishReason = 'tool_calls';
  } else if (body.response_format) {
    message = { role: 'assistant', content: 'not json' };
  } else {
    message = { role: 'assistant', content: '{"id":"a"}' };
  }
  return chatCompletionResponse({ model: body.model, message, finishReason,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}

async function captureBodies(fn: () => Promise<unknown>): Promise<Record<string, any>[]> {
  const real = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return chatReply(body);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return bodies;
}

const pickTool = () => tool({ description: 'pick', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' });

function assertRequestFields(b: Record<string, any>, where: string) {
  assert.equal(b.enable_thinking, true, `${where}: enable_thinking`);
  assert.equal(b.thinking_budget, 512, `${where}: thinking_budget`);
  assert.equal(b.top_k, 20, `${where}: top_k`);
}
function assertOverlaid(b: Record<string, any>, where: string) {
  assert.equal(b.enable_thinking, false, `${where}: override replaced enable_thinking`);
  assert.equal('thinking_budget' in b, false, `${where}: null override removed thinking_budget`);
  assert.equal(b.top_k, 20, `${where}: request field kept under the overrides`);
}

test('both lists on both legs survive save and a cold load', async () => {
  await coldLoad({ ...HOSTED, fallback: { enabled: true, ...LOCAL } });
  await settings.update({ llm: {
    bodyParams: REQUEST, toolCallBodyParams: OVERRIDES,
    fallback: { bodyParams: rows({ chat_template_kwargs: '{"enable_thinking":false}' }), toolCallBodyParams: rows({ reasoning_effort: 'low' }) },
  } } as never);
  setCache(null);
  await settings.load();
  const llm = settings.get().llm;
  assert.deepEqual(llm.bodyParams, REQUEST);
  assert.deepEqual(llm.toolCallBodyParams, OVERRIDES);
  assert.deepEqual(llm.fallback.bodyParams, rows({ chat_template_kwargs: '{"enable_thinking":false}' }));
  assert.deepEqual(llm.fallback.toolCallBodyParams, rows({ reasoning_effort: 'low' }));
});

test('a settings.json from before the field loads both lists empty, and a malformed list loads as none', async () => {
  const llm = await coldLoad({ ...HOSTED, fallback: { enabled: false } });
  assert.deepEqual(llm.bodyParams, []);
  assert.deepEqual(llm.toolCallBodyParams, []);
  assert.deepEqual(llm.fallback.bodyParams, []);
  assert.deepEqual(llm.fallback.toolCallBodyParams, []);
  const bad = await coldLoad({ ...HOSTED, bodyParams: 'enable_thinking=false', toolCallBodyParams: [{ key: 'max_tokens', value: '9' }] });
  assert.deepEqual(bad.bodyParams, []);
  assert.deepEqual(bad.toolCallBodyParams, []);
});

test('reserved keys are refused at save time in both lists, on both legs', async () => {
  await coldLoad({ ...HOSTED, fallback: { enabled: false } });
  for (const key of ['model', 'messages', 'tools', 'tool_choice', 'stream', 'max_tokens', 'response_format', 'stream_options']) {
    await assert.rejects(settings.update({ llm: { bodyParams: [{ key, value: '1' }] } } as never),
      new RegExp(`llm\\.bodyParams cannot override "${key}"`));
    await assert.rejects(settings.update({ llm: { toolCallBodyParams: [{ key, value: '1' }] } } as never),
      new RegExp(`llm\\.toolCallBodyParams cannot override "${key}"`));
    await assert.rejects(settings.update({ llm: { fallback: { toolCallBodyParams: [{ key, value: '1' }] } } } as never),
      new RegExp(`llm\\.fallback\\.toolCallBodyParams cannot override "${key}"`));
  }
  await assert.rejects(settings.update({ llm: { bodyParams: [{ key: 'a b', value: '1' }] } } as never), /llm\.bodyParams name/);
  await assert.rejects(settings.update({ llm: { bodyParams: 'x' } } as never), /llm\.bodyParams must be an array/);
  assert.deepEqual(settings.get().llm.bodyParams, [], 'nothing refused was saved');
});

test('rule 1: the normal client adds request fields and never overwrites one the SDK set', async () => {
  for (const leg of [HOSTED, LOCAL]) {
    const cfg = { ...leg, bodyParams: [...REQUEST, { key: 'temperature', value: '1.5' }], toolCallBodyParams: OVERRIDES };
    const [body] = await captureBodies(() => generateText({ model: languageModel(cfg), prompt: 'hi', temperature: 0.2, maxRetries: 0 }));
    assertRequestFields(body, `${leg.compatibleMode} model`);
    assert.equal(body.temperature, 0.2, `${leg.compatibleMode}: the SDK's temperature wins`);
  }
  // A hand-edited reserved key is skipped on the wire too.
  const cfg = { ...HOSTED, bodyParams: [{ key: 'max_tokens', value: '1' }, { key: 'model', value: '"other"' }] };
  const [body] = await captureBodies(() => generateText({ model: languageModel(cfg), prompt: 'hi', maxOutputTokens: 300, maxRetries: 0 }));
  assert.equal(body.max_tokens, 300);
  assert.equal(body.model, HOSTED.model);
});

// The SDK sends `max_completion_tokens` in place of `max_tokens` only for an
// OpenAI reasoning id, so on a Qwen leg it is unset and no-clobber would let
// it through beside the station's `max_tokens` — and vLLM reads it first, so
// the 64-token link fallback would run under the operator's cap instead.
test('max_completion_tokens is reserved: refused at save, skipped on the wire', async () => {
  await coldLoad({ ...HOSTED, fallback: { enabled: false } });
  for (const list of ['bodyParams', 'toolCallBodyParams']) {
    await assert.rejects(settings.update({ llm: { [list]: [{ key: 'max_completion_tokens', value: '99999' }] } } as never),
      new RegExp(`llm\\.${list} cannot override "max_completion_tokens"`));
  }
  const cfg = { ...HOSTED, bodyParams: [{ key: 'max_completion_tokens', value: '99999' }], toolCallBodyParams: [{ key: 'max_completion_tokens', value: '99999' }] };
  for (const forceNoThink of [false, true]) {
    const [body] = await captureBodies(() => generateText({ model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxOutputTokens: 64, maxRetries: 0 }));
    assert.equal(body.max_tokens, 64);
    assert.equal('max_completion_tokens' in body, false, `forceNoThink=${forceNoThink}: no second output cap`);
  }
});

test('rule 2: the no-think client overlays the overrides, and null removes a key', async () => {
  for (const leg of [HOSTED, LOCAL]) {
    const cfg = { ...leg, bodyParams: REQUEST, toolCallBodyParams: OVERRIDES };
    const [body] = await captureBodies(() => generateText({
      model: languageModel(cfg, { forceNoThink: true }), prompt: 'hi', maxRetries: 0,
      tools: { t: pickTool() }, toolChoice: 'required',
    }));
    assertOverlaid(body, `${leg.compatibleMode} noThinkModel`);
    if (leg.compatibleMode === 'local') {
      // The local no-think injection still runs after the operator's fields.
      assert.equal(body.chat_template_kwargs?.enable_thinking, false);
    } else {
      assert.equal(body.chat_template_kwargs, undefined, 'hosted gets no local injection (#1693)');
    }
  }
});

test('rule 2 on every forced leg kind the strategies reach: agent done, objectViaToolCall, object recovery', async () => {
  const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
  const { djObject } = await import('../src/llm/internal/strategy/object.js');
  const { djText } = await import('../src/llm/internal/strategy/text.js');
  const schema = z.object({ id: z.string() });
  await coldLoad({ ...HOSTED, bodyParams: REQUEST, toolCallBodyParams: OVERRIDES });

  const bodies = await captureBodies(async () => {
    await djText({ system: 'You are a DJ.', prompt: 'say hi' });
    await djObject({ system: 'You are a DJ.', prompt: 'pick', schema });
    await djAgent({
      system: 'You are a DJ.', messages: [{ role: 'user' as const, content: 'pick' }], schema, providerDiscoveryBudget: true,
      tools: { search: tool({ description: 'search', inputSchema: z.object({ query: z.string() }), execute: async () => ({ ids: ['a'] }) }) },
    });
    await objectViaToolCall(primaryLeg(), { prompt: 'pick', schema });
  });

  const text = bodies.find(b => !b.tools && !b.response_format && JSON.stringify(b.messages).includes('say hi'));
  assert.ok(text, 'djText reached the wire');
  assertRequestFields(text, 'djText');
  const native = bodies.find(b => b.response_format);
  assert.ok(native, 'djObject native attempt reached the wire');
  assertRequestFields(native, 'djObject native attempt (normal client)');
  const recovery = bodies.find(b => JSON.stringify(b.messages).includes('Respond with a single JSON object only'));
  assert.ok(recovery, 'djObject text recovery reached the wire');
  assertOverlaid(recovery, 'djObject text recovery');
  // The agent's native run is on the no-think client from its first step
  // (agent.ts native-then-done), discovery turns included.
  const agentRuns = bodies.filter(b => toolNames(b).includes('search'));
  assert.ok(agentRuns.length, 'agent turns reached the wire');
  agentRuns.forEach((b, i) => assertOverlaid(b, `agent body ${i}`));
  const forced = bodies.filter(b => b.tool_choice === 'required');
  assert.ok(forced.some(b => toolNames(b).includes('done')), 'agent forced done reached the wire');
  assert.ok(forced.some(b => toolNames(b).includes('emit')), 'objectViaToolCall reached the wire');
  forced.forEach((b, i) => assertOverlaid(b, `forced body ${i} (${toolNames(b).join(',')})`));
});

test('the fallback leg reads its own lists, never the primary\'s', async () => {
  await coldLoad({
    ...HOSTED, bodyParams: REQUEST, toolCallBodyParams: OVERRIDES,
    fallback: { enabled: true, ...HOSTED, model: 'backup', bodyParams: rows({ seed: '7' }), toolCallBodyParams: rows({ seed: 'null', min_p: '0.1' }) },
  });
  const leg = fallbackLeg();
  assert.ok(leg);
  const bodies = await captureBodies(async () => {
    await generateText({ model: leg.model, prompt: 'hi', maxRetries: 0 });
    await generateText({ model: leg.noThinkModel, prompt: 'hi', maxRetries: 0, tools: { t: pickTool() }, toolChoice: 'required' });
  });
  assert.equal(bodies[0].seed, 7);
  assert.equal(bodies[1].seed, undefined);
  assert.equal(bodies[1].min_p, 0.1);
  for (const b of bodies) {
    assert.equal(b.model, 'backup');
    assert.equal(b.enable_thinking, undefined, 'primary request field leaked onto the fallback');
    assert.equal(b.top_k, undefined, 'primary request field leaked onto the fallback');
  }
});

test('a swap moves both lists with the leg', () => {
  const stored = { llm: {
    ...HOSTED, bodyParams: REQUEST, toolCallBodyParams: OVERRIDES,
    fallback: { enabled: true, ...LOCAL, bodyParams: rows({ seed: '7' }), toolCallBodyParams: [] },
  } };
  const { patch } = planLlmSwap(stored as never, { provider: 'ollama' });
  const llm = (patch as any).llm;
  assert.deepEqual(llm.bodyParams, rows({ seed: '7' }));
  assert.deepEqual(llm.toolCallBodyParams, []);
  assert.deepEqual(llm.fallback.bodyParams, REQUEST);
  assert.deepEqual(llm.fallback.toolCallBodyParams, OVERRIDES);
});

test('both lists key the client cache; a hosted no-think client splits off only with overrides', () => {
  const cfg = { ...HOSTED, bodyParams: REQUEST };
  // Hosted, no overrides: one shared client, as today.
  assert.equal(languageModel(cfg, { forceNoThink: true }), languageModel(cfg));
  // Either list changing builds a fresh client.
  assert.notEqual(languageModel({ ...cfg, bodyParams: rows({ top_k: '40' }) }), languageModel(cfg));
  assert.notEqual(languageModel({ ...cfg, toolCallBodyParams: OVERRIDES }), languageModel(cfg));
  // Overrides present → the hosted no-think client is its own instance (nt1).
  const over = { ...cfg, toolCallBodyParams: OVERRIDES };
  assert.notEqual(languageModel(over, { forceNoThink: true }), languageModel(over));
  // A list of removals alone still counts as overrides.
  const removal = { ...cfg, toolCallBodyParams: rows({ thinking_budget: 'null' }) };
  assert.notEqual(languageModel(removal, { forceNoThink: true }), languageModel(removal));
  // Override edits change the no-think client too.
  assert.notEqual(
    languageModel({ ...cfg, toolCallBodyParams: rows({ enable_thinking: 'false' }) }, { forceNoThink: true }),
    languageModel({ ...cfg, toolCallBodyParams: rows({ enable_thinking: '0' }) }, { forceNoThink: true }),
  );
});

test('empty lists send exactly what a station without the field sends', async () => {
  for (const leg of [HOSTED, LOCAL, { provider: 'locca', model: 'm', baseUrl: 'http://127.0.0.1:9/v1' }]) {
    for (const forceNoThink of [false, true]) {
      const run = (cfg: Record<string, unknown>) => captureBodies(async () => {
        await generateText({ model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxRetries: 0 });
        await generateText({ model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxRetries: 0, tools: { t: pickTool() }, toolChoice: 'required' });
      });
      // Absolute: nothing at all to add, so no comparison can hide a field
      // both sides gained.
      assert.deepEqual(operatorBodyParams({ ...leg, bodyParams: [], toolCallBodyParams: [] }, forceNoThink), {});
      assert.deepEqual(operatorBodyParams({ ...leg }, forceNoThink), {});
      const without = await run({ ...leg });
      const empty = await run({ ...leg, bodyParams: [], toolCallBodyParams: [] });
      assert.deepEqual(empty, without, `${leg.provider}/${(leg as any).compatibleMode} forceNoThink=${forceNoThink}`);
    }
  }
  // And the shared hosted client is the same instance with or without them.
  assert.equal(languageModel({ ...HOSTED, bodyParams: [], toolCallBodyParams: [] }, { forceNoThink: true }), languageModel({ ...HOSTED }));
});

test('providers other than openai-compatible and locca never read the lists', async () => {
  for (const provider of ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'requesty', 'gateway', 'ollama']) {
    const cfg = { provider, model: 'm', apiKey: 'k', bodyParams: REQUEST, toolCallBodyParams: OVERRIDES };
    assert.deepEqual(operatorBodyParams(cfg), {}, provider);
    assert.deepEqual(operatorBodyParams(cfg, true), {}, provider);
    assert.equal(languageModel(cfg), languageModel({ ...cfg, bodyParams: [], toolCallBodyParams: [] }), `${provider}: lists keyed its cache`);
  }
  // On the wire, for a gateway that shares the createOpenAI transport.
  const [body] = await captureBodies(() => generateText({
    model: languageModel({ provider: 'requesty', model: 'openai/gpt-4o-mini', apiKey: 'k', bodyParams: REQUEST }),
    prompt: 'hi', maxRetries: 0,
  }));
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.top_k, undefined);
});
