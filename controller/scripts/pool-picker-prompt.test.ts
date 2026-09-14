// The pool picker's rendered chronology contract, through the real public
// prompt entrypoint and provider adapter. Only model HTTP is faked.
// Run: npm test -- pool-picker-prompt

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pool-picker-prompt-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { pickNextTrack } = await import('../src/llm/dj.js');

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    fallback: { enabled: false },
  },
});

interface ModelMessage {
  role?: string;
  content?: string;
}

interface ModelRequest {
  messages?: ModelMessage[];
}

const requests: ModelRequest[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body || '{}')) as ModelRequest;
  requests.push(body);
  return new Response(JSON.stringify({
    id: 'chatcmpl-pool-prompt',
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_fixture_pick',
          type: 'function',
          function: {
            name: 'emit',
            arguments: JSON.stringify({
              id: 'track-c',
              reason: 'Track C follows the queued predecessor.',
              transition: null,
            }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(stateRoot, { recursive: true, force: true });
});

test('rendered pool prompt distinguishes the expected predecessor from aired history', async () => {
  const chosen = await pickNextTrack({
    candidates: [{ id: 'track-c', title: 'Track C', artist: 'Artist C' }],
    recentPlays: [{ title: 'Track A', artist: 'Artist A' }],
    current: { title: 'Track B', artist: 'Artist B' },
    context: {
      time: { period: 'evening', vibe: 'settled' },
      dominantMood: 'calm',
    },
  });

  assert.equal(chosen.id, 'track-c');
  assert.equal(requests.length, 1);

  const system = requests[0]?.messages
    ?.filter(message => message.role === 'system')
    .map(message => message.content || '')
    .join('\n') || '';
  const user = requests[0]?.messages?.find(message => message.role === 'user')?.content || '';
  const payload = JSON.parse(user) as {
    now: { current: { title: string } };
    recentPlays: Array<{ title: string }>;
  };

  assert.equal(payload.now.current.title, 'Track B', 'queued predecessor is the transition anchor');
  assert.equal(payload.recentPlays[0]?.title, 'Track A', 'aired history remains independently truthful');
  assert.match(system, /now\.current is the expected predecessor/i);
  assert.match(system, /may not be on air yet/i);
  assert.match(system, /recentPlays contains only tracks that have already aired/i);
  assert.match(system, /track this pick is expected to follow/i);
  assert.match(system, /near that predecessor's tempo/i);
  assert.doesNotMatch(system, /what's playing(?: now)?|track on air right now/i);
});
