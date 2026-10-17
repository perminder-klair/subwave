// Capture real SDK HTTP payloads: Direct must not silently require tools,
// function calling, or provider-native structured output on a local model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-direct-provider-'));
const settings = await import('../src/settings.js');
const { matchRequest, generateIntro } = await import('../src/llm/dj.js');

for (const provider of ['ollama', 'openai-compatible'] as const) {
  for (const recover of [false, true]) {
    test(`${provider}: ${recover ? 'JSON recovery' : 'one-shot JSON'} sends no tools or schema mode`, async t => {
      await settings.load();
      await settings.update({ llm: { provider, model: 'plain-json-only', compatibleMode: 'local',
        baseUrl: 'http://plain-json.invalid/v1', ollamaUrl: 'http://plain-json.invalid', fallback: { enabled: false } } } as never);
      const calls: any[] = [];
      t.mock.method(globalThis, 'fetch', async (_input: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        assert.equal(body.tools, undefined);
        assert.equal(body.tool_choice, undefined);
        assert.equal(body.response_format, undefined);
        assert.equal(body.format, undefined);
        assert.match(JSON.stringify(body), /JSON Schema/);
        const output = recover && calls.length === 1 ? 'not JSON'
          : JSON.stringify({ title: 'Bohemian Rhapsody', artist: 'Queen' });
        return provider === 'ollama'
          ? Response.json({ model: body.model, message: { role: 'assistant', content: output }, done: true,
            done_reason: 'stop', prompt_eval_count: 10, eval_count: 10, total_duration: 1 })
          : Response.json({ id: 'direct', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
      });
      const result = await matchRequest('Queen, Bohemian Rhapsody');
      assert.equal(result.title, 'Bohemian Rhapsody');
      assert.equal(result.artist, 'Queen');
      assert.equal(calls.length, recover ? 2 : 1);
    });
  }
}

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
