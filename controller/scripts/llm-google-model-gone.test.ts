// #2101: Gemini answers a mistyped or retired model id with a 404 whose only
// model signal is its wording ("models/<id> is not found for API version …").
// The reporter's Google primary on such an id must hand each call to the
// configured Ollama fallback, not die with the backup idle. Real settings,
// legs, failover and both provider adapters; every fetch is intercepted.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-google-model-gone-'));
process.env.STATE_DIR = stateRoot;
after(() => removeTempDir(stateRoot));

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { djText, djObject, djAgent } = await import('../src/llm/sdk.js');
const { recentCalls } = await import('../src/llm/log.js');
const { resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');

const GONE = 'models/gemini-test-bad is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.';

// Which leg each intercepted request went to, in order.
type Leg = 'google' | 'ollama';
// The backup's reply: its text, or fields built from the tools the request offers.
type BackupReply = string | ((tools: string[]) => Record<string, unknown>);

async function withStation(googleMessage: string, backup: BackupReply, run: (legs: Leg[]) => Promise<void>) {
  resetFailoverStickyForTest();
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'google', model: 'gemini-test-bad', keys: { google: 'test-key' },
    fallback: { enabled: true, provider: 'ollama', model: 'gemma4:e2b' },
  } }));
  setCache(null);
  await settings.load();
  recentCalls.length = 0;
  const legs: Leg[] = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  console.log = () => {};
  globalThis.fetch = (async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === 'generativelanguage.googleapis.com') {
      legs.push('google');
      return new Response(JSON.stringify({ error: { code: 404, message: googleMessage, status: 'NOT_FOUND' } }),
        { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } });
    }
    assert.equal(target.pathname, '/api/chat');
    legs.push('ollama');
    const offered = (JSON.parse(String(init?.body)).tools ?? []).map((t: { function: { name: string } }) => t.function.name);
    return new Response(JSON.stringify({
      model: 'gemma4:e2b', created_at: new Date().toISOString(),
      message: { role: 'assistant', ...(typeof backup === 'string' ? { content: backup } : { content: '', ...backup(offered) }) },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1,
    }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run(legs);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

test('a Gemini "models/<id> is not found" primary hands a DJ link to the Ollama fallback in one attempt', async () => {
  await withStation(GONE, 'backup link', async (legs) => {
    assert.equal(await djText({ prompt: 'link' }), 'backup link');
    assert.deepEqual(legs, ['google', 'ollama']);
    const failed = recentCalls.find((call) => !call.ok)!;
    assert.equal(failed.model, 'google:gemini-test-bad');
    assert.match(failed.via, /:failover→ollama:gemma4:e2b$/);
    assert.equal(recentCalls.find((call) => call.ok)!.model, 'ollama:gemma4:e2b');
  });
});

test('a structured pick skips schema recovery on the gone Gemini model and fails over', async () => {
  await withStation(GONE, '{"ok":true}', async (legs) => {
    assert.deepEqual(await djObject({ prompt: 'pick', schema: z.object({ ok: z.boolean() }) }), { ok: true });
    // One Gemini request: recovery cannot bring a missing model back. The
    // backup's own output-path attempts are its business.
    assert.equal(legs.filter((leg) => leg === 'google').length, 1);
    assert.equal(legs[0], 'google');
    assert.ok(legs.length > 1 && legs.slice(1).every((leg) => leg === 'ollama'), legs.join());
  });
});

test('a tool-loop pick fails over at the native pass instead of retrying the gone model on the done-tool path', async () => {
  const tools = { weather: tool({ description: 'current weather', inputSchema: z.object({}), execute: async () => ({ summary: 'rain' }) }) };
  // The backup explores while it may, then answers through `done`.
  const reply = (offered: string[]) => ({ tool_calls: [{ function: offered.includes('done')
    ? { name: 'done', arguments: { ok: true } }
    : { name: 'weather', arguments: {} } }] });
  await withStation(GONE, reply, async (legs) => {
    const out = await djAgent({
      system: 'pick', messages: [{ role: 'user', content: 'pick' }],
      schema: z.object({ ok: z.boolean() }), tools, maxSteps: 3,
    } as never);
    assert.deepEqual(out.object, { ok: true });
    // One Gemini request: the native pass hands the error to failover rather
    // than to the done-tool run, which would only ask the missing model again.
    assert.equal(legs.filter((leg) => leg === 'google').length, 1);
    assert.equal(legs[0], 'google');
    assert.ok(legs.slice(1).every((leg) => leg === 'ollama'), legs.join());
  });
});

test('a Gemini NOT_FOUND that names no model stays on the primary (no bare-404 failover)', async () => {
  await withStation('Requested entity was not found.', 'must not be used', async (legs) => {
    await assert.rejects(djText({ prompt: 'link' }), { statusCode: 404 });
    assert.deepEqual(legs, ['google']);
  });
});
