// Regression coverage for the announce-only writer fallback.
// The only mocked component is the external OpenAI-compatible HTTP boundary;
// generateLink, provider selection, prompt composition and sampling all run.
// Run: npm test -- announce-fallback

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-announce-fallback-'));

const settings = await import('../src/settings.js');
const { generateLink } = await import('../src/llm/internal/prompts/scripts.js');

await settings.update({
  llm: {
    provider: 'openai-compatible',
    model: 'fixture-model',
    baseUrl: 'http://127.0.0.1:9/v1',
    pickerAgent: false,
    fallback: { enabled: false },
  },
});

interface WireRequest {
  messages?: unknown[];
  temperature?: unknown;
}

const realFetch = globalThis.fetch;
const requests: WireRequest[] = [];
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body || '{}')) as WireRequest);
  return new Response(JSON.stringify({
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'A longer editorial link from the fixture model.' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function lastWireRequest(): WireRequest {
  assert.ok(requests.length > 0, 'the writer must reach the configured model boundary');
  return requests.at(-1)!;
}

function assertAnnounceOnlyContract(request: WireRequest) {
  const wire = JSON.stringify(request.messages ?? []);
  assert.match(wire, /This is/);
  assert.match(wire, /Next up/);
  assert.doesNotMatch(wire, /Give a brief spoken introduction/,
    'announce-only fallback must not silently use the natural editorial-link task');
  assert.equal(request.temperature, 0.2, 'translation/romanisation is a low-variance task');
}

test('non-English announce fallback sends a constrained announce-only translation task', async () => {
  requests.length = 0;
  await generateLink({
    previous: null,
    current: { title: 'Dönence', artist: 'Barış Manço' },
    context: {},
    persona: {
      name: 'Deniz',
      soul: 'warm and direct',
      language: 'Turkish',
      linkStyle: 'announce',
      scriptLength: 'concise',
    },
  });
  assertAnnounceOnlyContract(lastWireRequest());
});

test('CJK announce fallback sends a constrained announce-only romanisation task', async () => {
  requests.length = 0;
  await generateLink({
    previous: null,
    current: { title: '稲妻', artist: 'ウルフルズ' },
    context: {},
    persona: {
      name: 'Nova',
      soul: 'warm and direct',
      language: 'English',
      linkStyle: 'announce',
      scriptLength: 'concise',
    },
  });
  assertAnnounceOnlyContract(lastWireRequest());
});
