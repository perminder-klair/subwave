// Thinking-mandatory Claude generations (Sonnet 5.5, Opus 5.5, Fable 5) — the
// wire half of capabilities.thinkingMandatoryModel.
//
// These models 400 on `tool_choice` any/tool ("tool_choice: type "tool" and
// "any" are not supported for this model") and on `thinking:{type:"disabled"}`.
// The station hit the first one live: an openai-compatible proxy in front of
// claude-sonnet-5-5 turned the picker's toolChoice:'required' into
// tool_choice:any, and every forced `emit` call came back 400.
//
// llm-pure.test.ts pins the mapping; this file pins what the SDKs actually put
// on the wire for it, through the real objectViaToolCall, so an SDK upgrade
// that re-maps 'auto' or 'minimal' fails here rather than on air. Each case has
// a control model from the previous generation, which proves the capture sees
// the forced shape when we do ask for it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { objectViaToolCall } from '../src/llm/internal/strategy/object-via-tool.js';
import { openAICompatibleFetch } from '../src/llm/internal/provider/registry.js';

const schema = z.object({ id: z.string(), reason: z.string() });
const ANSWER = { id: 'abc', reason: 'fits' };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function anthropicCall(model: string): Promise<any> {
  let sent: any = null;
  const provider = createAnthropic({
    apiKey: 'test',
    fetch: async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return json({
        id: 'msg_1', type: 'message', role: 'assistant', model,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit', input: ANSWER }],
        stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const cfg = { provider: 'anthropic', model, reasoning: false };
  const out = await objectViaToolCall({ cfg, model: provider(model) }, { prompt: 'pick', schema, temperature: 0.5, maxOutputTokens: 500 });
  assert.deepEqual(out.object, ANSWER);
  return sent;
}

async function compatibleCall(model: string): Promise<any> {
  let sent: any = null;
  const cfg = { provider: 'openai-compatible', model, reasoning: false };
  const provider = createOpenAI({
    baseURL: 'http://proxy.test/v1',
    apiKey: 'test',
    fetch: openAICompatibleFetch(cfg, async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return json({
        id: 'c1', object: 'chat.completion', created: 0, model,
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'emit', arguments: JSON.stringify(ANSWER) } }] },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }, true),
  });
  const out = await objectViaToolCall({ cfg, model: provider.chat(model) }, { prompt: 'pick', schema, temperature: 0.5, maxOutputTokens: 500 });
  assert.deepEqual(out.object, ANSWER);
  return sent;
}

test('native anthropic, claude-sonnet-5-5: tool_choice auto and thinking never disabled', async () => {
  const body = await anthropicCall('claude-sonnet-5-5');
  assert.equal(body.tool_choice?.type, 'auto');
  assert.notEqual(body.thinking?.type, 'disabled');
});

test('native anthropic, claude-opus-5-5: tool_choice auto and thinking never disabled', async () => {
  const body = await anthropicCall('claude-opus-5-5');
  assert.equal(body.tool_choice?.type, 'auto');
  assert.notEqual(body.thinking?.type, 'disabled');
});

test('native anthropic control, claude-sonnet-5: still forced with thinking disabled', async () => {
  const body = await anthropicCall('claude-sonnet-5');
  assert.equal(body.tool_choice?.type, 'any');
  assert.equal(body.thinking?.type, 'disabled');
});

test('openai-compatible proxy, claude-sonnet-5-5: tool_choice auto and no thinking:disabled in the body', async () => {
  const body = await compatibleCall('claude-sonnet-5-5');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
});

test('openai-compatible control, a local model: still required with the full no-think set', async () => {
  const body = await compatibleCall('qwen3');
  assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.thinking, { type: 'disabled' });
});
