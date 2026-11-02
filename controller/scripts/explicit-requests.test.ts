// A clean show and the two kinds of people who can ask for a track.
//
// A LISTENER's ask for a track tagged explicit is refused the way the blocklist
// refuses one: the standard not-found copy, so the reason does not leak, and
// before any intro is written. Driven through POST /request, so the route's own
// wiring is what runs. The agent path hides the track from the model instead.
//
// An OPERATOR's press is exempt from every automatic gate: POST /dj/queue-track
// and /dj/queue-block still air it.
// Run: `npm test -- explicit-requests`.

import test, { after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { chatCompletionResponse } from './test-utils/llm.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-explicit-requests-'));
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/request.js');
const { router: djRouter } = await import('../src/routes/dj.js');
const { queue } = await import('../src/broadcast/queue.js');
const requestLog = await import('../src/broadcast/request-log.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { runRequest } = await import('../src/broadcast/dj-agent.js');

await settings.load();

const app = express();
app.use(express.json());
app.use(router);
app.use(djRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  queue.senderBusy = false;
  server.close();
});

const realFetch = globalThis.fetch;
const TAGGED = { id: 'tagged', title: 'Tagged Song', artist: 'Tagged Act', album: 'A', duration: 240, explicitStatus: 'explicit' };
const OTHER = { id: 'other', title: 'Other Song', artist: 'Other Act', album: 'B', duration: 240, explicitStatus: '' };
const NAMED = {
  kind: 'track', search_terms: ['Tagged Song'], artist: 'Tagged Act', title: 'Tagged Song', genre: null, language: null,
  sort: null, scope: 'song', mood: null, intent: 'Wants Tagged Song.', ack: 'Coming right up.',
};

const subsonicOk = (body: Record<string, unknown>) =>
  Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } });

let modelCalls = 0;
function stubNetwork(t: TestContext, { search = [TAGGED], matcher = NAMED as Record<string, unknown>, albums = {} as Record<string, unknown[]>, similar = [] as unknown[] } = {}) {
  modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return realFetch(input, init);
    if (url.startsWith('http://127.0.0.1:9/')) {
      if (!url.includes('/chat/completions')) return new Response('no', { status: 404 });
      modelCalls++;
      const body = JSON.parse(String(init?.body ?? '{}'));
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      return chatCompletionResponse({
        message: tools.length
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tools[0].function.name, arguments: JSON.stringify(matcher) } }] }
          : { role: 'assistant', content: JSON.stringify(matcher) },
      });
    }
    if (url.includes('/rest/search3')) return subsonicOk({ searchResult3: { song: search, artist: Object.keys(albums).length ? [{ id: 'act', name: 'Tagged Act' }] : [] } });
    if (url.includes('/rest/getTopSongs')) return subsonicOk({ topSongs: { song: search } });
    if (url.includes('/rest/getArtist.') || url.includes('/rest/getArtist?')) {
      return subsonicOk({ artist: { id: 'act', name: 'Tagged Act', album: Object.keys(albums).map(id => ({ id, name: id })) } });
    }
    if (url.includes('/rest/getAlbum.') || url.includes('/rest/getAlbum?')) {
      const id = new URL(url).searchParams.get('id')!;
      return subsonicOk({ album: { id, name: id, song: albums[id] ?? [] } });
    }
    if (url.includes('/rest/getSimilarSongs')) return subsonicOk({ similarSongs: { song: similar }, similarSongs2: { song: similar } });
    if (url.includes('/rest/')) return subsonicOk({});
    throw new Error('offline');
  });
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

async function onAir(show: Record<string, unknown>) {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_clean', name: 'Clean Hour', personaId: settings.get().personas[0].id, ...show }],
    scheduleOverride: { showId: 's_clean', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
}

const booth = () => queue.djLog.filter((e: any) => e.kind === 'blocked').map((e: any) => e.message as string);

beforeEach(async () => {
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.history = [];
  queue.djLog = [];
  queue.current = { track: { id: 'on-air', title: 'On Air', artist: 'Tagged Act' } } as any;
  await settings.update({
    llm: {
      provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false }, requestMatching: 'direct',
    },
    tts: { enabled: true },
    requests: { enabled: true, maxPending: 20, onePendingPerIp: false, repeatCooldownMin: 120, globalHourlyCap: 10000 },
  } as never);
});

test('a named track tagged explicit is declined in the blocklist\'s words, with nothing queued', async (t) => {
  stubNetwork(t);
  await onAir({ excludeExplicit: true });
  const { outcome, record } = await request('Tagged Song by Tagged Act please');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.message, 'Sorry Tester, nothing in the crates matched that.', 'the reason does not leak');
  assert.equal(queue.upcoming.length, 0);
  assert.equal(record.outcome, 'no-match');
  assert.match(record.pickSource, /:explicit$/);
  assert.ok(booth().some(l => /Tagged Song.*tagged explicit, clean show "Clean Hour"/.test(l)), booth().join(' | '));
});

test('the refusal comes before generation: no intro is written for a track that will not air', async (t) => {
  stubNetwork(t);
  await onAir({ excludeExplicit: true });
  await request('Tagged Song by Tagged Act please');
  assert.equal(modelCalls, 1, 'the matcher, and no intro after it');
});

// The draws are random: without the show's rule inside them each of these
// lands on the tagged track about half the time, so the repeats are the test.
const DRAWS = 10;
const CLEAN_CUT = { ...TAGGED, id: 'clean-cut', album: 'Clean Edit', explicitStatus: 'clean' };
const ALSO_BY = { ...OTHER, id: 'also-by', title: 'Also By', artist: 'Tagged Act' };
const SECOND_TAGGED = { ...TAGGED, id: 'tagged-2', title: 'Tagged Two' };
const ARTIST_ONLY = { ...NAMED, search_terms: ['Tagged Act'], title: null, scope: 'artist' };

async function everyDraw(text: string) {
  const aired = new Set<string>();
  for (let i = 0; i < DRAWS; i++) {
    queue.upcoming = [];
    const { outcome } = await request(text);
    assert.equal(outcome.status, 'resolved', outcome.message ?? '');
    aired.add(queue.upcoming.at(-1)?.track?.id);
  }
  return [...aired];
}

test('a song with a clean recording airs that recording, never a refusal', async (t) => {
  stubNetwork(t, { search: [TAGGED, CLEAN_CUT] });
  await onAir({ excludeExplicit: true });
  assert.deepEqual(await everyDraw('Tagged Song by Tagged Act please'), ['clean-cut']);
});

test('a wholly tagged album is stepped over for the rest of the artist', async (t) => {
  stubNetwork(t, { search: [], matcher: ARTIST_ONLY, albums: { loud: [TAGGED, SECOND_TAGGED], soft: [ALSO_BY] } });
  await onAir({ excludeExplicit: true });
  assert.deepEqual(await everyDraw('play some Tagged Act'), ['also-by']);
});

test('more-like-this draws around a tagged track too', async (t) => {
  stubNetwork(t, { search: [TAGGED, SECOND_TAGGED, ALSO_BY], matcher: ARTIST_ONLY });
  await onAir({ excludeExplicit: true });
  assert.deepEqual(await everyDraw('more like this'), ['also-by']);
});

test('more-like-this falling back to similar tracks draws around a tagged one', async (t) => {
  const SIMILAR_TAGGED = { ...TAGGED, id: 'similar-tagged', artist: 'Someone Else' };
  const SIMILAR_CLEAN = { ...OTHER, id: 'similar-clean', artist: 'Someone Else' };
  stubNetwork(t, { search: [], similar: [SIMILAR_TAGGED, SIMILAR_CLEAN] });
  await onAir({ excludeExplicit: true });
  assert.deepEqual(await everyDraw('more like this'), ['similar-clean']);
});

test('a show that is not clean draws from the whole pool, as it always did', async (t) => {
  stubNetwork(t, { search: [TAGGED, CLEAN_CUT] });
  await onAir({});
  const aired = new Set<string>();
  for (let i = 0; i < 30; i++) {
    queue.upcoming = [];
    await request('Tagged Song by Tagged Act please');
    aired.add(queue.upcoming.at(-1)?.track?.id);
  }
  assert.deepEqual([...aired].sort(), ['clean-cut', 'tagged']);
});

test('a tagged track that only the show holds back is not reported as played recently', async (t) => {
  stubNetwork(t);
  await onAir({ excludeExplicit: true });
  // On cooldown as well: the show is the reason, and the listener hears one answer.
  t.mock.method(queue, 'recentlyPlayedIds', () => new Set(['tagged']));
  const { outcome } = await request('Tagged Song by Tagged Act please');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.message, 'Sorry Tester, nothing in the crates matched that.');
});

test('more-like-this is held to the same line', async (t) => {
  stubNetwork(t);
  await onAir({ excludeExplicit: true });
  const { outcome, record } = await request('more like this');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /Couldn't find anything close/);
  assert.equal(queue.upcoming.length, 0);
  assert.match(record.pickSource, /:explicit$/);
});

test('an untagged track still gets through a clean show', async (t) => {
  stubNetwork(t, {
    search: [OTHER],
    matcher: { ...NAMED, search_terms: ['Other Song'], artist: 'Other Act', title: 'Other Song' },
  });
  await onAir({ excludeExplicit: true });
  const { outcome } = await request('Other Song by Other Act please');
  assert.equal(outcome.status, 'resolved', outcome.message ?? '');
  assert.equal(queue.upcoming.at(-1)?.track?.id, 'other');
});

test('a show that is not clean takes the same request as it always did', async (t) => {
  stubNetwork(t);
  await onAir({});
  const { outcome } = await request('Tagged Song by Tagged Act please');
  assert.equal(outcome.status, 'resolved', outcome.message ?? '');
  assert.equal(queue.upcoming.at(-1)?.track?.id, 'tagged');
  assert.deepEqual(booth(), []);
});

test('the request agent never sees a tagged track on a clean show, and sees everything otherwise', async (t) => {
  stubNetwork(t);
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const scopes: any[] = [];
  const realRun = requestAgent.run;
  requestAgent.run = (async (args: any) => {
    scopes.push(args.scope);
    return { object: { kind: 'chat', id: null, ack: 'Noted.' }, toolCalls: [], extras: { seen: new Map() }, steps: 1 };
  }) as never;
  try {
    await onAir({ excludeExplicit: true });
    await runRequest(queue, { requester: 'Tester', text: 'hello there' });
    await onAir({});
    await runRequest(queue, { requester: 'Tester', text: 'hello again' });
  } finally {
    requestAgent.run = realRun;
  }
  assert.deepEqual(scopes.map(s => s.excludeExplicit), [true, false]);
});

const admin = (path: string, body: unknown) => realFetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-subwave-console': '1' },
  body: JSON.stringify(body),
});

test('an operator queueing a tagged track on a clean show still gets it', async (t) => {
  stubNetwork(t);
  await onAir({ excludeExplicit: true });
  const res = await admin('/dj/queue-track', TAGGED);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(queue.upcoming.at(-1)?.track?.id, 'tagged');
  assert.equal(queue.upcoming.at(-1)?.operator, true);
});

test('an operator block with tagged tracks on a clean show keeps them all', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) return realFetch(input, init);
    if (url.includes('/rest/getAlbum')) return subsonicOk({ album: { id: 'alb', name: 'A', song: [{ ...TAGGED, track: 1 }, { ...OTHER, track: 2 }] } });
    if (url.includes('/rest/')) return subsonicOk({});
    throw new Error('offline');
  });
  await onAir({ excludeExplicit: true });
  const res = await admin('/dj/queue-block', { kind: 'album', id: 'alb' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(queue.upcoming.map((i: any) => i.track.id), ['tagged', 'other']);
});
