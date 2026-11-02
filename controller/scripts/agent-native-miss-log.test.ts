// A native miss's log line must say WHICH failure it was. The SDK message alone
// reads "could not parse the response" for both prose and an EMPTY reply (a
// hosted Claude thinking, then ending its turn with no text), and "No output
// generated" for a run that hit its step cap still calling tools. Live, every
// miss logged only that message, so the cause could not be told from the logs.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-native-miss-log-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'miss-log-test';
process.env.ADMIN_PASS = 'miss-log-test';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { djAgent, describeNativeMiss } = await import('../src/llm/internal/strategy/agent.js');
const { tool } = await import('ai');
const { z } = await import('zod');

test('an empty reply reads as one, with its billed tokens', () => {
  const line = describeNativeMiss({ text: '' }, [
    { toolCalls: [{ toolName: 'tracksByMood' }, { toolName: 'deepCuts' }] },
    { toolCalls: [], finishReason: 'stop', text: '', usage: { outputTokens: 21 } },
  ] as any, 4);
  assert.equal(line, 'steps tracksByMood+deepCuts → reply(stop, 0 chars, 21 out)');
});

test('a run that ran out of steps still searching says so', () => {
  const search = { toolCalls: [{ toolName: 'tracksByMood' }] };
  const line = describeNativeMiss(new Error('No output generated.'), [search, search, search, search] as any, 4);
  assert.equal(line, 'steps tracksByMood → tracksByMood → tracksByMood → tracksByMood · hit the 4-step cap still calling tools');
});

test('unparsed prose is quoted, short and on one line', () => {
  const prose = `Here is my pick:\n\n${'x'.repeat(200)}`;
  const line = describeNativeMiss({ text: prose }, [{ toolCalls: [], finishReason: 'stop', text: prose }] as any, 4);
  assert.match(line, /^steps reply\(stop, 218 chars, 0 out\) · text "Here is my pick: x+"$/);
  assert.equal(line.split('text "')[1].length, 121, '120 characters plus the closing quote');
});

test('the live log line carries the diagnosis', async (t) => {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'openai-compatible', model: 'claude-sonnet-5-5', baseUrl: 'http://proxy.invalid/v1',
    compatibleMode: 'hosted', discoverySteps: 3, fallback: { enabled: false },
  } }));
  setCache(null);
  await settings.load();
  let n = 0;
  const reply = (body: any, message: any, completion = 1) => new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: completion, total_tokens: completion + 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchMock = t.mock.method(globalThis, 'fetch', (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    n++;
    const names = (body.tools || []).map((x: any) => x.function?.name);
    if (names.includes('done')) return reply(body, { role: 'assistant', content: null, tool_calls: [{ id: 'd', type: 'function', function: { name: 'done', arguments: '{"id":"t1"}' } }] });
    if (n === 1) return reply(body, { role: 'assistant', content: null, tool_calls: [{ id: 's', type: 'function', function: { name: 'searchLibrary', arguments: '{"query":"q"}' } }] });
    // The live signature: thought, then ended the turn with no text.
    return reply(body, { role: 'assistant', content: '' }, 44);
  }) as typeof fetch);
  const lines: string[] = [];
  const logMock = t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')); });
  try {
    const out: any = await djAgent({
      system: 'Pick.', messages: [{ role: 'user', content: 'Pick.' }],
      schema: z.object({ id: z.string() }), maxSteps: 2, kind: 'djAgentPick', providerDiscoveryBudget: true,
      tools: { searchLibrary: tool({ description: 's', inputSchema: z.object({ query: z.string() }), execute: async () => [{ id: 't1' }] }) },
    } as never);
    assert.equal(out.object.id, 't1');
  } finally {
    logMock.mock.restore();
    fetchMock.mock.restore();
  }
  const miss = lines.find((l) => l.includes('native output failed'));
  assert.ok(miss, 'the native miss was logged');
  assert.match(miss!, /could not parse the response\.; steps searchLibrary → reply\(stop, 0 chars, 44 out\)\) — falling back to done-tool/);
});
