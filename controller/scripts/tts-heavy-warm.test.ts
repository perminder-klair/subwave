// Unit tests for warmHeavy() (audio/ttsHeavyClient.ts) — the call that asks the
// tts-heavy sidecar to start reloading an engine its idle unload released
// (#1579), so the model comes back before the DJ needs it rather than on the
// line itself.
//
// The property under test is that it is TOTAL. Two callers fire it and neither
// awaits it: the idle pause releasing (broadcast/stream-idle.ts, inside the
// tick's try/catch, where a throw would hold the pause) and a talk slot firing
// (broadcast/scheduler.ts). Nothing downstream depends on the result — a warm
// that never lands just means the next render pays the model load itself,
// which is the un-warmed behaviour — so every failure path has to resolve
// quietly rather than reject. An unhandled rejection from a `void`-ed call is
// how a memory optimisation takes the station down.
//
// globalThis.fetch swap, matching scripts/weather-settings-live.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TTS_HEAVY_URL = 'http://tts-heavy.test:8080';
const { warmHeavy } = await import('../src/audio/ttsHeavyClient.js');

type Call = { url: string; method?: string; body?: string };

function stubFetch(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('warms every enabled engine with one unnamed POST', async () => {
  const f = stubFetch(() => ok({ ok: true, warming: ['chatterbox'], disabled: [], loaded: [], cold: [] }));
  try {
    await warmHeavy();
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /\/warm$/);
    assert.equal(f.calls[0].method, 'POST');
    // The caller is a station-wide event and cannot know which persona speaks
    // first, so it names no engine and the sidecar warms the lot.
    assert.deepEqual(JSON.parse(f.calls[0].body || '{}'), { engine: '' });
  } finally {
    f.restore();
  }
});

test('a sidecar that is down resolves quietly instead of rejecting', async () => {
  const f = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  try {
    // Not assert.doesNotReject-for-its-own-sake: stream-idle.ts fires this
    // inside the tick's try/catch, and a throw there would be caught as an
    // idle-transition failure and hold the programme paused.
    await assert.doesNotReject(() => warmHeavy(), 'a down sidecar must not throw at its caller');
  } finally {
    f.restore();
  }
});

test('an older image with no /warm route is a no-op, not an error', async () => {
  const f = stubFetch(() => new Response('Not Found', { status: 404 }));
  try {
    await assert.doesNotReject(() => warmHeavy());
  } finally {
    f.restore();
  }
});

test('a malformed body is swallowed — the reply is only ever logged', async () => {
  const f = stubFetch(() => new Response('<html>nope</html>', { status: 200 }));
  try {
    await assert.doesNotReject(() => warmHeavy());
  } finally {
    f.restore();
  }
});

test('no sidecar configured makes no request at all', async () => {
  const f = stubFetch(() => ok({ ok: true, warming: [] }));
  const saved = process.env.TTS_HEAVY_URL;
  try {
    // config is read once at import, so drive the same branch the way the
    // module does: the URL is empty in every non-sidecar deployment, and
    // warmHeavy must not manufacture a request to nowhere.
    const { config } = await import('../src/config.js');
    const original = config.ttsHeavy.url;
    config.ttsHeavy.url = '';
    try {
      await warmHeavy();
      assert.equal(f.calls.length, 0, 'no URL, no call');
    } finally {
      config.ttsHeavy.url = original;
    }
  } finally {
    process.env.TTS_HEAVY_URL = saved;
    f.restore();
  }
});
