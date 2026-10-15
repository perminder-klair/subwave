// After a native miss, the done-tool run must not repeat discovery the native
// run already spent, and a hung native call must not hold the whole deadline.
// Seen live on a hosted Claude (tool_choice 'auto'): the native run searched
// three times and answered with text that would not parse; the done-tool run
// was then gated into three MORE discovery-only steps, the model answered in
// text instead, and every miss paid for a wasted run before done-only recovery.
// Separately, one native call hung for the whole 90s deadline and the pick fell
// to the pool with the rest of the cascade never asked.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-native-budget-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'budget-test';
process.env.ADMIN_PASS = 'budget-test';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { djAgent, remainingDiscoverySteps } = await import('../src/llm/internal/strategy/agent.js');
const { tool } = await import('ai');
const { recentCalls } = await import('../src/llm/log.js');
const { z } = await import('zod');

const schema = z.object({ id: z.string() });

function reply(body: any, message: any) {
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
const search = (n: number) => ({ role: 'assistant', content: null, tool_calls: [{ id: `s${n}`, type: 'function', function: { name: 'searchLibrary', arguments: `{"query":"q${n}"}` } }] });
const done = (id: string) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ id }) } }] });

async function hosted() {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'openai-compatible', model: 'claude-sonnet-5-5', baseUrl: 'http://proxy.invalid/v1',
    compatibleMode: 'hosted', discoverySteps: 3, fallback: { enabled: false },
  } }));
  setCache(null);
  await settings.load();
}

function searchTool() {
  let n = 0;
  return tool({
    description: 'search the library', inputSchema: z.object({ query: z.string() }),
    execute: async () => [{ id: `track-${++n}`, title: `Track ${n}`, artist: `Artist ${n}` }],
  });
}

const toolNames = (body: any): string[] => (body.tools || []).map((t: any) => t.function?.name);
const toolTurns = (body: any) => body.messages.filter((m: any) => m.role === 'tool').length;

test('a native run that spent the discovery budget leaves the done-tool run to commit at once', async (t) => {
  await hosted();
  const bodies: any[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (toolNames(body).includes('done')) return reply(body, done('track-3'));
    // Native: three searches, then prose that is not the object.
    if (bodies.length <= 3) return reply(body, search(bodies.length));
    if (bodies.length === 4) return reply(body, { role: 'assistant', content: 'Track 3 it is — lovely.' });
    // A gated discovery-only step after the model already has its answer: on
    // tool_choice 'auto' it answers in text, which ends the run without `done`.
    return reply(body, { role: 'assistant', content: 'I already have it: track-3.' });
  }) as typeof fetch);
  let out: any;
  try {
    out = await djAgent({
      system: 'Pick the next track.',
      messages: [{ role: 'user', content: 'Pick the next track.' }],
      schema, tools: { searchLibrary: searchTool() }, maxSteps: 2, kind: 'djAgentPick',
      providerDiscoveryBudget: true,
    } as never);
  } finally {
    fetchMock.mock.restore();
  }
  assert.equal(out.object.id, 'track-3');
  assert.equal(bodies.length, 5, 'four native requests, then ONE done-tool request — no wasted run, no recovery');
  assert.deepEqual(toolNames(bodies[4]), ['done'], 'the done-tool run commits at step 0');
  assert.equal(toolTurns(bodies[4]), 3, 'with all three native results in view');
  assert.equal(recentCalls[0].via, 'ai-sdk:agent', 'recorded as the done-tool path, not as a native answer');
});

test('a native run that explored less keeps the rest of the budget', () => {
  const searched = { toolCalls: [{ toolName: 'searchLibrary' }] } as any;
  const answered = { toolCalls: [] } as any;
  assert.equal(remainingDiscoverySteps(3, [searched, answered]), 2);
  assert.equal(remainingDiscoverySteps(3, [searched, searched, searched, answered]), 0);
  assert.equal(remainingDiscoverySteps(1, [searched, searched]), 0, 'never negative');
  assert.equal(remainingDiscoverySteps(3, []), 3, 'nothing carried, nothing spent');
});

test('a hung native call is cut at its share, and the done-tool path still answers', async (t) => {
  await hosted();
  const bodies: any[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) {
      // The native call hangs until it is aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
      });
    }
    if (toolNames(body).includes('done')) return reply(body, done('track-1'));
    return reply(body, search(bodies.length));
  }) as typeof fetch);
  const started = Date.now();
  let out: any;
  try {
    out = await djAgent({
      system: 'Pick the next track.',
      messages: [{ role: 'user', content: 'Pick the next track.' }],
      schema, tools: { searchLibrary: searchTool() }, maxSteps: 2, kind: 'djAgentPick',
      providerDiscoveryBudget: true, timeoutMs: 2000,
    } as never);
  } finally {
    fetchMock.mock.restore();
  }
  const elapsed = Date.now() - started;
  assert.equal(out.object.id, 'track-1', 'the done-tool path filled the pick');
  assert.ok(elapsed >= 900 && elapsed < 2000, `native held only its share of the deadline (${elapsed}ms)`);
});
