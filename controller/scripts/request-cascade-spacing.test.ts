// The stateless request cascade spaces a request's STAND-IN (#1993), driven
// through POST /request so the route's own wiring is what runs.
// Run: `npm test -- request-cascade-spacing`.
//
// #1979 held the request agent's stand-in to artist spacing, but the cascade
// in routes/request.ts — reached on `llm.requestMatching: 'direct'`, an agent
// failure or the token cap — draws from fallback pools with no model call to
// re-pick with. Asked for an artist the library lacks, its similar-to-current
// rung offered the very artist on air. Now a stand-in by a recently-heard
// artist is drawn past when the pool holds anything else; what the listener
// asked for, and an ask naming no music, draw as they always did. The pure
// halves are pinned in scripts/request-claim.test.ts (matchedRequestStandIn)
// and scripts/artist-guard.test.ts (drawRequestCandidate).
import test, { after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { chatCompletionResponse } from './test-utils/llm.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-cascade-spacing-'));

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/request.js');
const { queue } = await import('../src/broadcast/queue.js');
const requestLog = await import('../src/broadcast/request-log.js');
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');

await settings.load();

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  queue.senderBusy = false;
  server.close();
});

const realFetch = globalThis.fetch;
const DANCETERIA = { id: 'madonna-danceteria', title: 'Danceteria', artist: 'Madonna', album: 'Iconic By Mistake', duration: 240 };
const HOLIDAY = { id: 'madonna-holiday', title: 'Holiday', artist: 'Madonna', album: 'Madonna', duration: 368, isDir: false };
const GIRLS = { id: 'cyndi-girls', title: 'Girls Just Want to Have Fun', artist: 'Cyndi Lauper', album: "She's So Unusual", duration: 238, isDir: false };
const CALIFORNIA = { id: '2pac-california', title: 'California Love', artist: '2Pac', album: 'All Eyez on Me', duration: 285 };
const CHANGES = { id: '2pac-changes', title: 'Changes', artist: '2Pac', album: 'Greatest Hits', duration: 269, isDir: false };

// The matcher's reading for an artist the library lacks.
const LIKE_MJ = {
  kind: 'track', search_terms: ['Michael Jackson'], artist: 'Michael Jackson', genre: null, language: null,
  sort: null, scope: 'song', mood: null, intent: 'Wants something like Michael Jackson.', ack: 'Coming right up.',
};

type Script = { matcher: Record<string, unknown>; similar?: any[]; search?: any[] };

const subsonicOk = (body: Record<string, unknown>) =>
  Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } });

// Everything off-box is stubbed: the matcher (openai-compatible fixture,
// answered with `matcher`), the music server's similar songs and search3, and
// a failure for anything else (Icecast, Open-Meteo).
function stubNetwork(t: TestContext, script: Script) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return realFetch(input, init);
    if (url.startsWith('http://127.0.0.1:9/')) {
      if (!url.includes('/chat/completions')) return new Response('no embeddings here', { status: 404 });
      const body = JSON.parse(String(init?.body ?? '{}'));
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      return chatCompletionResponse({
        message: tools.length
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(script.matcher) } }] }
          : { role: 'assistant', content: JSON.stringify(script.matcher) },
      });
    }
    if (url.includes('/rest/getSimilarSongs2')) return subsonicOk({ similarSongs2: { song: script.similar ?? [] } });
    if (url.includes('/rest/search3')) return subsonicOk({ searchResult3: { song: script.search ?? [] } });
    if (url.includes('/rest/')) return subsonicOk({});
    throw new Error('offline');
  });
  // The first draw from a pool is its first member, so the stand-in draws
  // first and the spacing decides the pick, not the dice.
  t.mock.method(Math, 'random', () => 0);
}

let ipSeq = 0;
async function request(text: string) {
  const res = await realFetch(`${base}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipSeq}` },
    body: JSON.stringify({ text, name: 'Tester' }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 202, JSON.stringify(body));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await (await realFetch(`${base}/request/${body.requestId}`)).json() as any;
    if (r.status !== 'pending') return { outcome: r, record: requestLog.snapshot(1)[0] };
    if (Date.now() > deadline) throw new Error(`request "${text}" never settled`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const boothLines = () => queue.djLog.filter((e: any) => e.kind === 'request-guard').map((e: any) => e.message);

beforeEach(async () => {
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.history = [];
  queue.djLog = [];
  queue.current = { track: DANCETERIA } as any;
  await settings.update({
    llm: {
      provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false }, requestMatching: 'direct',
      artistVarietyWindow: 5,
    },
    // No intro, so no second model call: the matcher is the only one.
    tts: { enabled: false },
    requests: { enabled: true, maxPending: 20, onePendingPerIp: false, repeatCooldownMin: 120 },
  } as never);
});

test('#1993: asked for an artist the library lacks, the cascade draws past the on-air artist', async (t) => {
  stubNetwork(t, { matcher: LIKE_MJ, similar: [HOLIDAY, GIRLS] });
  const { outcome, record } = await request('something like Michael Jackson');
  assert.equal(outcome.status, 'resolved', outcome.message ?? '');
  assert.equal(outcome.track?.artist, 'Cyndi Lauper', 'not Madonna straight after Madonna');
  assert.equal(record.pickSource, 'similar-to-current');
  assert.equal(record.artistMiss, 'Michael Jackson', 'still owned as a stand-in');
  assert.equal(record.guard, 'artist-spaced');
  assert.equal(queue.upcoming.at(-1)?.track?.id, GIRLS.id);
  assert.ok(boothLines().some((l) => /stand-in by recently-played artist "Madonna" set aside/.test(l)), boothLines().join(' | '));
});

test('#1993: what the listener asked for is drawn however recently its artist played', async (t) => {
  stubNetwork(t, {
    matcher: { ...LIKE_MJ, search_terms: ['Holiday', 'Madonna'], artist: 'Madonna', intent: 'Wants Holiday by Madonna.' },
    search: [HOLIDAY, GIRLS],
  });
  const { outcome, record } = await request('Holiday by Madonna please');
  assert.equal(outcome.track?.title, 'Holiday');
  assert.equal(record.pickSource, 'search');
  assert.equal(record.guard, null);
  assert.deepEqual(boothLines(), []);
});

test('#1993: an ask naming no music is never spaced', async (t) => {
  stubNetwork(t, {
    matcher: { ...LIKE_MJ, search_terms: [], artist: null, intent: 'Wants more like the current track.' },
    similar: [HOLIDAY, GIRLS],
  });
  const { outcome, record } = await request('something like this please');
  assert.equal(outcome.track?.title, 'Holiday', 'the on-air artist is the ask here');
  assert.equal(record.guard, null);
  assert.deepEqual(boothLines(), []);
});

test('#1993: a pool of nothing but recent stand-ins still fills the request', async (t) => {
  stubNetwork(t, { matcher: LIKE_MJ, similar: [HOLIDAY] });
  const { outcome, record } = await request('something like Michael Jackson');
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.track?.title, 'Holiday', 'spacing is a preference, never a lost slot');
  assert.equal(record.guard, null);
  assert.ok(boothLines().some((l) => /stand-in by recently-played artist "Madonna" allowed/.test(l)), boothLines().join(' | '));
});

test('#1993: past the token cap there is no matcher reading, so a dedication or "more of this" is never spaced', async (t) => {
  // modelFreeMatch hands the whole request on as the one search term, and no
  // dedication or deictic slot can hold a whole request: read as a name, it
  // spaced the on-air artist for both of these.
  await settings.update({ llm: { dailyTokenCap: 1000, exemptRequests: false } } as never);
  t.after(() => settings.update({ llm: { dailyTokenCap: 0 } } as never));
  addDailyUsage(5000);
  stubNetwork(t, { matcher: LIKE_MJ, similar: [HOLIDAY, GIRLS] });
  for (const text of ['something like this for Sarah', 'anything like this please, happy birthday Sarah']) {
    queue.upcoming = [];
    queue.djLog = [];
    const { outcome, record } = await request(text);
    assert.equal(outcome.track?.title, 'Holiday', text);
    assert.equal(record.pickSource, 'similar-to-current', text);
    assert.equal(record.guard, null, text);
    assert.deepEqual(boothLines(), [], text);
  }
});

test('#1993 review: a search in the listener\'s own spelling found their ask, which is never spaced', async (t) => {
  // "Tupac" is no spelling of the library's "2Pac", and 2Pac is on air. The
  // artist path misses the name; the term search finds the library's credit.
  queue.current = { track: CALIFORNIA } as any;
  stubNetwork(t, {
    matcher: { ...LIKE_MJ, search_terms: ['Tupac'], artist: 'Tupac', intent: 'Wants Tupac.' },
    search: [CHANGES, GIRLS],
  });
  const { outcome, record } = await request('play some Tupac');
  assert.equal(outcome.track?.title, 'Changes', 'the ask, not a stand-in for it');
  assert.equal(record.pickSource, 'search');
  assert.equal(record.guard, null);
  assert.deepEqual(boothLines(), []);
});

test('#1993 review: "more like this" the matcher read as the on-air track is never spaced', async (t) => {
  // The on-air title alone, and the request copied whole by a weak matcher:
  // both point at the on-air track and name nobody else, so the similar
  // rung's on-air artist is the ask.
  for (const term of ['Danceteria', 'something like this for Sarah']) {
    queue.upcoming = [];
    queue.djLog = [];
    stubNetwork(t, {
      matcher: { ...LIKE_MJ, search_terms: [term], artist: null, intent: 'Wants more like the current track.' },
      similar: [HOLIDAY, GIRLS],
    });
    const text = term === 'Danceteria' ? 'more like this please' : term;
    const { outcome, record } = await request(text);
    assert.equal(outcome.track?.title, 'Holiday', text);
    assert.equal(record.pickSource, 'similar-to-current', text);
    assert.equal(record.guard, null, text);
    assert.deepEqual(boothLines(), [], text);
    t.mock.restoreAll();
  }
});

test('#1993: a spacing window of 0 turns stand-in spacing off, as it does for picks', async (t) => {
  await settings.update({ llm: { artistVarietyWindow: 0 } } as never);
  stubNetwork(t, { matcher: LIKE_MJ, similar: [HOLIDAY, GIRLS] });
  const { outcome, record } = await request('something like Michael Jackson');
  assert.equal(outcome.track?.title, 'Holiday');
  assert.equal(record.guard, null);
  assert.deepEqual(boothLines(), []);
});
