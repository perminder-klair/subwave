// A native answer that needs no data must not be discarded for lacking a tool
// call. Seen live on Sonnet 5.5 in hosted mode: the segment director decided to
// stay silent ("air": false) without touching a data tool, the native answer was
// thrown away as unexplored, and every five-minute tick paid the done-tool run
// AND the recovery on top (~11s, 13k input tokens) to reach the same silence.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-settled-native-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'settled-test';
process.env.ADMIN_PASS = 'settled-test';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { tool } = await import('ai');
const { z } = await import('zod');

const SILENT = { reason: 'nothing fresh', air: false, segment: { kind: '', text: '', sfx: null } };
const SPOKEN = { reason: 'weather turned', air: true, segment: { kind: 'weather', text: 'Rain later.', sfx: null } };
const schema = z.object({
  reason: z.string(),
  air: z.boolean(),
  segment: z.object({ kind: z.string(), text: z.string(), sfx: z.string().nullable() }),
});

// A hosted model that answers every structured request straight away, with no
// tool call, and calls `done` whenever it is the only tool on offer.
function answeringModel(bodies: Record<string, any>[], answer: unknown) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const names: string[] = (body.tools || []).map((t: any) => t.function?.name);
    const callDone = names.includes('done') && (names.length === 1 || body.tool_choice === 'required');
    const message = callDone
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'done', arguments: JSON.stringify(answer) } }] }
      : { role: 'assistant', content: JSON.stringify(answer) };
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message, finish_reason: callDone ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function hosted() {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'openai-compatible', model: 'claude-sonnet-5-5', baseUrl: 'http://proxy.invalid/v1',
    compatibleMode: 'hosted', fallback: { enabled: false },
  } }));
  setCache(null);
  await settings.load();
}

const weatherTool = () => ({
  weather: tool({ description: 'current weather', inputSchema: z.object({}), execute: async () => ({ summary: 'rain' }) }),
});

async function run(t: any, answer: unknown, settledWithoutTools?: (o: any) => boolean) {
  const bodies: Record<string, any>[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', answeringModel(bodies, answer));
  try {
    const out = await djAgent({
      system: 'You are a DJ deciding whether to speak.',
      messages: [{ role: 'user', content: 'The current moment: afternoon.' }],
      schema, tools: weatherTool(), maxSteps: 2, kind: 'djAgentSegment',
      ...(settledWithoutTools ? { settledWithoutTools } : {}),
    } as never);
    return { object: (out as any).object, calls: bodies.length };
  } finally {
    fetchMock.mock.restore();
  }
}

const silenceIsSettled = (o: any) => o?.air === false;

test('a silent decision with no tool call is accepted on the first request', async (t) => {
  await hosted();
  const { object, calls } = await run(t, SILENT, silenceIsSettled);
  assert.deepEqual(object, SILENT);
  assert.equal(calls, 1, 'one native request, no done-tool run and no recovery');
});

test('without the opt-in the same answer still falls through (the old cost)', async (t) => {
  await hosted();
  const { object, calls } = await run(t, SILENT);
  assert.deepEqual(object, SILENT);
  assert.ok(calls > 1, `fell through to the done-tool path (${calls} requests)`);
});

test('a line that airs without a data call still falls through', async (t) => {
  await hosted();
  const { calls } = await run(t, SPOKEN, silenceIsSettled);
  assert.ok(calls > 1, 'only silence is settled; a spoken line must have explored');
});
