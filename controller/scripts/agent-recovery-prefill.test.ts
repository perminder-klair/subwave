// The done-only recovery must never hand the model a conversation that ends on
// its own turn. When the first run stops with plain text instead of calling
// `done`, the replayed trail's last message is that assistant reply, and current
// Claude generations reject it ("This model does not support assistant message
// prefill"). The recovery then threw and the whole segment was lost.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-recovery-prefill-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'prefill-test';
process.env.ADMIN_PASS = 'prefill-test';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { endOnUserTurn, RECOVERY_USER_TURN } = await import('../src/llm/internal/core/pure.js');
const { tool } = await import('ai');
const { z } = await import('zod');

test('endOnUserTurn appends a user turn only after an assistant turn', () => {
  const user = [{ role: 'user', content: 'pick' }];
  assert.equal(endOnUserTurn(user), user, 'already ends on the user: untouched, so roles still alternate');
  const toolEnd = [...user, { role: 'assistant', content: [] }, { role: 'tool', content: [] }];
  assert.equal(endOnUserTurn(toolEnd), toolEnd, 'a tool result is a valid end too');
  const assistantEnd = [...user, { role: 'assistant', content: 'I think track a fits.' }];
  const out = endOnUserTurn(assistantEnd);
  assert.equal(out.length, 3);
  assert.deepEqual(out.at(-1), { role: 'user', content: RECOVERY_USER_TURN });
  assert.equal(assistantEnd.length, 2, 'the input is not mutated');
  assert.deepEqual(endOnUserTurn([]), []);
});

// A model behind an OpenAI-compatible endpoint that (1) answers the first run
// with prose instead of calling `done`, and (2) refuses any request whose last
// message is the assistant's, exactly as Sonnet 5.5 does through a proxy.
function prefillRefusingModel(bodies: Record<string, any>[]) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const last = body.messages.at(-1);
    if (last?.role === 'assistant') {
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'This model does not support assistant message prefill. The conversation must end with a user message.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const names: string[] = (body.tools || []).map((t: any) => t.function?.name);
    const onlyDone = names.length === 1 && names[0] === 'done';
    const message = onlyDone
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ line: 'ok' }) } }] }
      : { role: 'assistant', content: 'Here is a thought about the record instead of a tool call.' };
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message, finish_reason: onlyDone ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('a recovery after a prose-only first run ends on a user turn and succeeds', async (t) => {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'openai-compatible', model: 'claude-sonnet-5-5', baseUrl: 'http://proxy.invalid/v1',
    compatibleMode: 'local', fallback: { enabled: false },
  } }));
  setCache(null);
  await settings.load();

  const bodies: Record<string, any>[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', prefillRefusingModel(bodies));
  try {
    const out = await djAgent({
      system: 'You are a DJ.',
      messages: [{ role: 'user', content: 'say something' }],
      schema: z.object({ line: z.string() }),
      tools: { search: tool({ description: 'search', inputSchema: z.object({ q: z.string() }), execute: async () => ({ ids: [] }) }) },
    } as never);
    assert.deepEqual((out as any).object, { line: 'ok' }, 'the recovery produced the answer');
  } finally {
    fetchMock.mock.restore();
  }

  const recovery = bodies.filter(b => b.messages.some((m: any) => m.role === 'assistant'));
  assert.ok(recovery.length >= 1, 'a recovery request replayed the first run');
  for (const b of recovery) {
    assert.notEqual(b.messages.at(-1).role, 'assistant', 'never sent as assistant prefill');
  }
  assert.equal(recovery[0].messages.at(-1).content, RECOVERY_USER_TURN);
});
