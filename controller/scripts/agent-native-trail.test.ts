// A native miss must not hide what the native run already found. Seen live on a
// listener request: the native run searched, found "Around the World", then
// answered with text that would not parse. The done-tool run started from the
// bare messages, searched again, and the tool reported every match "already
// shown this pick" (the shared `seen` map), handing back similar-by-feel tracks
// instead. The model told the listener the library did not hold the song.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-native-trail-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'trail-test';
process.env.ADMIN_PASS = 'trail-test';

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { djAgent, nativeToolExchange } = await import('../src/llm/internal/strategy/agent.js');
const { tool } = await import('ai');
const { z } = await import('zod');

const schema = z.object({ id: z.string(), ack: z.string() });
const FOUND = { id: 'atw-radio-edit', title: 'Around the World (Radio Edit)', artist: 'Daft Punk' };

function reply(body: any, message: any) {
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Native run: search, then an answer that is not JSON. Done-tool run: answer
// through `done` with whatever id its context shows, or 'not-found'.
function scriptedModel(bodies: any[]) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const names: string[] = (body.tools || []).map((t: any) => t.function?.name);
    const lastIsTool = body.messages.at(-1)?.role === 'tool';
    if (!names.includes('done')) {
      if (!lastIsTool) {
        return reply(body, { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'searchLibrary', arguments: '{"query":"Around the World Daft Punk"}' } }] });
      }
      return reply(body, { role: 'assistant', content: 'Sure! Here is a lovely pick for you.' });
    }
    const sawIt = JSON.stringify(body.messages).includes(FOUND.id);
    const answer = { id: sawIt ? FOUND.id : 'not-found', ack: sawIt ? 'Here it is.' : 'Not in the library.' };
    return reply(body, { role: 'assistant', content: null, tool_calls: [{ id: 'd1', type: 'function', function: { name: 'done', arguments: JSON.stringify(answer) } }] });
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

test('the done-tool run sees what the native run found before it missed', async (t) => {
  await hosted();
  let searches = 0;
  const tools = {
    // Like the real registry: a second search of the same thing returns
    // nothing new, because `seen` already holds it.
    searchLibrary: tool({
      description: 'search the library', inputSchema: z.object({ query: z.string() }),
      execute: async () => (searches++ === 0 ? [FOUND] : { tracks: [], note: '1 matching track(s) exist but were all already shown this pick' }),
    }),
  };
  const bodies: any[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', scriptedModel(bodies));
  try {
    const out: any = await djAgent({
      system: 'Resolve the listener request.',
      messages: [{ role: 'user', content: 'Listener asks: Around the World by Daft Punk.' }],
      schema, tools, maxSteps: 3, kind: 'djAgentRequest',
    } as never);
    assert.equal(out.object.id, FOUND.id, 'the pick comes from the native run\'s own search');
  } finally {
    fetchMock.mock.restore();
  }
  // Requests 1-2 are the native run (search, then the unparseable answer);
  // request 3 opens the done-tool run.
  const opening = JSON.stringify(bodies[2].messages);
  assert.ok(opening.includes(FOUND.id), 'the native tool result rides into the done-tool run');
  assert.ok(!opening.includes('lovely pick'), 'the native run\'s unusable answer stays out');
  assert.equal(searches, 1, 'no second search was needed to see it');
});

test('nativeToolExchange keeps tool turns only, and only with a result', () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'x', input: {} }] } as any;
  const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'x', output: { type: 'json', value: 1 } }] } as any;
  const prose = { role: 'assistant', content: [{ type: 'text', text: 'here you go' }] } as any;
  assert.deepEqual(nativeToolExchange([call, result, prose]), [call, result]);
  assert.deepEqual(nativeToolExchange([prose]), []);
  assert.deepEqual(nativeToolExchange([call]), [], 'a call with no result is not carried');
});
