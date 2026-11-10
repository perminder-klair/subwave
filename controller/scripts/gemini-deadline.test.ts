// Exercise the real provider and dispatcher with abort-aware response streams.
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-gemini-deadline-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
const gemini = await import('../src/audio/gemini.js');
const tts = await import('../src/audio/tts.js');
const settings = await import('../src/settings.js');
const remote = await import('../src/audio/remoteTts.js');
after(() => rmSync(root, { recursive: true, force: true }));

const audio = Buffer.from('mock audio');
const success = () => Response.json({ output_audio: { data: audio.toString('base64') } });

function accelerateDeadline(t: TestContext) {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: any[]) => void, ms: number, ...args: any[]) =>
    realSetTimeout(fn, ms === 180_000 ? 20 : ms, ...args));
}

function stalledBody(signal: AbortSignal, status: number): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { status });
}

for (const status of [200, 429, 500, 400]) {
  test(`a stalled HTTP ${status} body times out and tries the next model`, async t => {
    accelerateDeadline(t);
    const signals: AbortSignal[] = [];
    const models: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      signals.push(init.signal!);
      models.push(JSON.parse(String(init.body)).model);
      return models.length === 1 ? stalledBody(init.signal!, status) : success();
    });
    // fetchWithTimeout's body timer is unref'd; keep the process alive while waiting.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const path = await gemini.speak('Hello.', { outPath: join(root, `stall-${status}.wav`) });
      assert.deepEqual(readFileSync(path), audio);
      assert.deepEqual(models, ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']);
      assert.equal(signals[0].aborted, true);
    } finally {
      clearInterval(keepAlive);
    }
  });
}

for (const status of [200, 500]) {
  test(`caller cancellation during an HTTP ${status} body is terminal`, async t => {
    const caller = new AbortController();
    const reason = new Error('preview cancelled');
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      requests++;
      const res = stalledBody(init.signal!, status);
      setTimeout(() => caller.abort(reason), 5);
      return res;
    });
    await assert.rejects(gemini.speak('Hello.', { signal: caller.signal }), error => error === reason);
    assert.equal(requests, 1);
  });
}

test('an already-cancelled caller never starts a provider request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => success());
  await assert.rejects(gemini.speak('Hello.', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('caller cancellation before headers does not try another model', async t => {
  const caller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    caller.abort();
    throw init.signal!.reason;
  });
  await assert.rejects(gemini.speak('Hello.', { signal: caller.signal }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 1);
});

test('malformed JSON recovers on the next Gemini model', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? new Response('{broken') : success());
  const path = await gemini.speak('Hello.', { outPath: join(root, 'malformed.wav') });
  assert.deepEqual(readFileSync(path), audio);
  assert.equal(requests, 2);
});

test('malformed response shapes try the next model', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? Response.json({ output_audio: { data: {} }, steps: {} }) : success());
  await gemini.speak('Hello.', { outPath: join(root, 'shape.wav') });
  assert.equal(requests, 2);
});

test('readable non-retryable HTTP failures stay terminal', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('invalid key', { status: 403 }));
  await assert.rejects(gemini.speak('Hello.'), /HTTP 403: invalid key/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('exhausted malformed Gemini responses reach the configured TTS rescue', async t => {
  await settings.update({
    tts: { defaultEngine: 'gemini', fallback: { enabled: true, engine: 'remote', voice: 'rescue' },
      remote: { url: 'https://rescue.test' } },
  });
  let geminiRequests = 0;
  let rescues = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/interactions')) {
      geminiRequests++;
      return new Response('{broken');
    }
    if (url === 'https://rescue.test/health') return Response.json({ ok: true });
    assert.equal(url, 'https://rescue.test/speak');
    assert.equal(JSON.parse(String(init.body)).voice, 'rescue');
    rescues++;
    return new Response(audio, { headers: { 'content-type': 'audio/wav' } });
  });
  await remote.refresh();
  const path = await tts.speak('[excited] Hello.', {
    persona: { ...settings.get().personas[0], tts: { engine: 'gemini', voice: 'Puck' } },
    speedScale: 1,
  });
  assert.deepEqual(readFileSync(path), audio);
  assert.equal(geminiRequests, 2);
  assert.equal(rescues, 1);
});
