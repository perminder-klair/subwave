// OpenRouter models that cannot switch reasoning off (#2092).
//
// With reasoning off, the openrouter leg is built with `reasoning:{enabled:false}`.
// A model or endpoint that mandates reasoning answers that with a 400 —
// "Reasoning is mandatory for this endpoint and cannot be disabled." — and the
// mood tagger dropped each such batch to per-track tagging. A router id
// (`openrouter/free` picks a free model at random per request) lands on such a
// model only some of the time, which is the "occasionally" in the report, so no
// model-id list can fix it.
//
// Pinned here: registry.openRouterFetch re-sends that one rejected request at
// the mandatory floor (effort:'minimal'), once. Every other request and response
// is untouched, so a model that accepts `enabled:false` still gets it, in
// exactly one request. Driven at the fetch wrapper and through the real tagger
// (tagBatch → djObject → languageModel) against a stubbed global fetch. No
// credentials and no external host.

import assert from 'node:assert/strict';
import { chatCompletionResponse } from './test-utils/llm.js';
import { coldLoadSettings } from './test-utils/settings.js';
import test from 'node:test';
import { openRouterFetch, mandatoryReasoningFloor } from '../src/llm/internal/provider/registry.js';
import { tagBatch } from '../src/music/tagger-core.js';

const URL = 'https://openrouter.ai/api/v1/chat/completions';

// OpenRouter's rejection, as relayed to clients (musistudio/claude-code-router#1238).
function mandatoryRejection(): Response {
  return Response.json({
    error: {
      message: 'Reasoning is mandatory for this endpoint and cannot be disabled.',
      code: 400,
      metadata: { provider_name: null },
    },
  }, { status: 400 });
}

function okReply(content = 'ok'): Response {
  return chatCompletionResponse({ model: 'm', message: { role: 'assistant', content } });
}

interface Sent { url: unknown; init: any; body: any }

// A base fetch that records each request and answers from `reply`.
function recorder(reply: (body: any, n: number) => Response) {
  const sent: Sent[] = [];
  const base = async (url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url, init, body });
    return reply(body, sent.length);
  };
  return { sent, base };
}

// Carries a real signal, as the SDK's postToApi does, so the retry can be held
// to the caller's deadline.
function request(body: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal };
}

const OFF = { model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, reasoning: { enabled: false } };

test('a mandatory-reasoning rejection is sent again once at the floor, nothing else changed', async () => {
  const { sent, base } = recorder((body) => (body.reasoning?.enabled === false ? mandatoryRejection() : okReply()));
  const init = request(OFF);
  const res = await openRouterFetch(base)(URL, init);
  assert.equal(res.status, 200);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body.reasoning, { enabled: false });
  assert.deepEqual(sent[1].body.reasoning, mandatoryReasoningFloor());
  assert.deepEqual(sent[1].body.reasoning, { effort: 'minimal' });
  // Same URL, same headers, same everything but the reasoning block.
  assert.equal(sent[1].url, URL);
  assert.equal(sent[1].init.headers, init.headers);
  assert.equal(sent[1].init.signal, init.signal, 'the retry is held to the caller\'s abort signal');
  assert.deepEqual({ ...sent[1].body, reasoning: undefined }, { ...sent[0].body, reasoning: undefined });
});

// Without the signal, a deadline would stop waiting for the retry but leave it
// generating on OpenRouter, billed and unread.
test('an abort that lands after the rejection stops the retry', async () => {
  const ac = new AbortController();
  let calls = 0;
  const base = async (_url: unknown, init: RequestInit) => {
    calls++;
    if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    ac.abort();
    return mandatoryRejection();
  };
  await assert.rejects(openRouterFetch(base)(URL, request(OFF, ac.signal)), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('a model that accepts reasoning off sees exactly one untouched request', async () => {
  const { sent, base } = recorder(() => okReply());
  const init = request(OFF);
  const res = await openRouterFetch(base)(URL, init);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init, init, 'the same init object, not a rewrite');
  assert.equal(res.bodyUsed, false, 'a successful response is never read');
});

test('any other error passes through untouched and still readable', async () => {
  for (const reply of [
    () => Response.json({ error: { message: 'max_tokens must be at most 500', code: 400 } }, { status: 400 }),
    () => Response.json({ error: { message: 'Provider returned error', code: 502 } }, { status: 502 }),
  ]) {
    const { sent, base } = recorder(reply);
    const res = await openRouterFetch(base)(URL, request(OFF));
    assert.equal(sent.length, 1);
    assert.match((await res.json()).error.message, /max_tokens|Provider returned error/);
  }
});

test('a request that did not ask for reasoning off is never re-sent', async () => {
  for (const body of [
    { ...OFF, reasoning: { effort: 'minimal' } },
    { ...OFF, reasoning: undefined },
  ]) {
    const { sent, base } = recorder(() => mandatoryRejection());
    const res = await openRouterFetch(base)(URL, request(body));
    assert.equal(sent.length, 1);
    assert.equal(res.status, 400);
  }
});

test('the retry happens once: a second rejection is returned as-is', async () => {
  const { sent, base } = recorder(() => mandatoryRejection());
  const res = await openRouterFetch(base)(URL, request(OFF));
  assert.equal(sent.length, 2);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Reasoning is mandatory/);
});

// ── Through the tagger ──────────────────────────────────────────────────────

const SONGS = [
  { title: 'Song A', artist: 'Artist A' },
  { title: 'Song B', artist: 'Artist B' },
];
const RESULTS = { results: [{ moods: ['calm'], energy: 'low' }, { moods: ['energetic'], energy: 'high' }] };

// Runs fn with globalThis.fetch (debugFetch, the openrouter transport's inner
// fetch, delegates to it) answering every chat completion. `mandatory` makes the
// stub behave like a model that cannot switch reasoning off; `content` picks the
// reply text per request body.
async function onTheWire(
  mandatory: boolean,
  fn: () => Promise<unknown>,
  content: (body: any) => string = () => JSON.stringify(RESULTS),
): Promise<{ bodies: any[]; out: unknown }> {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (mandatory && body.reasoning?.enabled === false) return mandatoryRejection();
    return okReply(content(body));
  }) as typeof fetch;
  try {
    return { bodies, out: await fn() };
  } finally {
    globalThis.fetch = real;
  }
}

async function openRouterStation(model: string, reasoning: boolean) {
  await coldLoadSettings({ llm: { provider: 'openrouter', model, reasoning, keys: { openrouter: 'sk-or-test' } } });
}

test('the tagger batch call succeeds on a model that cannot switch reasoning off', async () => {
  await openRouterStation('openrouter/free', false);
  const { bodies, out } = await onTheWire(true, () => tagBatch(SONGS));
  assert.deepEqual(out, RESULTS.results);
  // One rejected request, one retry at the floor; no per-track salvage and no
  // recovery attempt behind it.
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  assert.deepEqual(bodies[1].reasoning, { effort: 'minimal' });
});

test('a model that accepts reasoning off gets one request with enabled:false, as before', async () => {
  await openRouterStation('z-ai/glm-4.6', false);
  const { bodies, out } = await onTheWire(false, () => tagBatch(SONGS));
  assert.deepEqual(out, RESULTS.results);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
});

test('reasoning on sends no reasoning block, so the rejection cannot happen', async () => {
  await openRouterStation('openrouter/free', true);
  const { bodies, out } = await onTheWire(true, () => tagBatch(SONGS));
  assert.deepEqual(out, RESULTS.results);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning, undefined);
});

// Forced-tool and recovery legs run on a separate reasoning-disabled instance
// (languageModel forceNoThink), so they send `enabled:false` even with reasoning
// on. That instance must carry the retry too.
test('with reasoning on, the reasoning-disabled recovery instance is retried at the floor too', async () => {
  await openRouterStation('openrouter/free', true);
  // The native attempt (no reasoning block) answers prose, so djObject falls to
  // its text recovery on the no-think instance, which the model rejects.
  const { bodies, out } = await onTheWire(true, () => tagBatch(SONGS),
    (body) => (body.reasoning === undefined ? 'not json' : JSON.stringify(RESULTS)));
  assert.deepEqual(out, RESULTS.results);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].reasoning, undefined);
  assert.deepEqual(bodies[1].reasoning, { enabled: false });
  assert.deepEqual(bodies[2].reasoning, { effort: 'minimal' });
});
