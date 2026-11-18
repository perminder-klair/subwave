// The honest substitution intro remains part of the identity fix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-direct-provider-'));
const settings = await import('../src/settings.js');
const { generateIntro } = await import('../src/llm/dj.js');

test('a substitution intro cannot claim the named song or artist is absent', async t => {
  await settings.load();
  await settings.update({ llm: { provider: 'openai-compatible', model: 'intro-fixture', baseUrl: 'http://plain-json.invalid/v1',
    fallback: { enabled: false } } } as never);
  let prompt = '';
  t.mock.method(globalThis, 'fetch', async (_input: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    prompt = JSON.stringify(body.messages);
    return Response.json({ id: 'intro', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'An alternative for the moment.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  });
  await generateIntro({ track: { title: 'Another Song', artist: 'Queen' }, context: {}, requestSubstitution: true });
  assert.match(prompt, /not an exact fulfilment/);
  assert.match(prompt, /never promise the named song or claim it is absent/);
});

test('worked-example acks read as a found request, never a holding line', async () => {
  // The listener sees a matched request's ack after the library search, so a
  // copied "let me look" line would answer a request that is already queued.
  const { requestMatcherSystem } = await import('../src/llm/internal/prompts/request.js');
  const acks = [...requestMatcherSystem(null).matchAll(/\{"kind":"track"[^\n]*?"ack":"([^"]*)"/g)].map(m => m[1]);
  assert.ok(acks.length >= 10, `found ${acks.length} track examples`);
  for (const ack of acks) assert.doesNotMatch(ack, /\blook(?:ing)? for\b|\blet me (?:check|see)\b|\bsearching\b/i, ack);
});
