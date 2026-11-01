// A request intro that push() drops as a stand-in was never said, so it must
// not be remembered as said. Each caller used to record its own copy of the
// model's text: the DJ's window then offered "placeholder" to the next prompt
// as its own speech, and public GET /session served it to listeners. push()
// reports the drop, and these drive the three callers through to what those
// surfaces then show.
//
// Run: npm test -- stand-in-request

import assert from 'node:assert/strict';
import test, { after, beforeEach, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-request-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://stand-in-library.invalid';

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { router: requestRouter } = await import('../src/routes/request.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { queue } = await import('../src/broadcast/queue.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const requestLog = await import('../src/broadcast/request-log.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { runRequest } = await import('../src/broadcast/dj-agent.js');
const { invalidateWeatherCache } = await import('../src/context.js');

const app = express();
app.use(express.json());
app.use(requestRouter);
app.use(publicRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
const realRequestRun = requestAgent.run;

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const SHOW = 's_stand_in_request';
const song = { id: 'queen-song', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 300, genre: 'Rock' };
const other = { id: 'queen-other', title: 'Somebody to Love', artist: 'Queen', album: 'A Day at the Races', duration: 280, genre: 'Rock' };
const ctx = () => ({
  at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
  weather: null, festival: null, dominantMood: 'calm',
  activeShow: { id: SHOW, name: 'Stand-in', topic: 'tests' },
}) as never;

let intro = 'placeholder';
let ip = 0;

beforeEach(async context => {
  const t = context as TestContext;
  intro = 'placeholder';
  await settings.load();
  await settings.update({
    personas: [HOST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    llm: { requestMatching: 'direct', provider: 'openai-compatible', compatibleMode: 'local',
      baseUrl: 'http://stand-in-model.invalid/v1', model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0 },
    requests: { enabled: true, onePendingPerIp: false, maxPending: 50, globalHourlyCap: 1000, repeatCooldownMin: 120 },
  } as never);
  session.start(ctx());
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  queue.senderBusy = true;
  queue._recentPlays = [];
  invalidateWeatherCache();
  requestAgent.run = realRequestRun;

  const plan = { kind: 'track', title: song.title, artist: song.artist, search_terms: [song.title, song.artist], genre: 'Rock', scope: 'song', ack: 'Found it, coming up.' };
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as never, 'doGenerate', (async (options: any) => {
    const writingIntro = JSON.stringify(options.prompt).includes('Write an intro for this track');
    return {
      content: options.tools?.length && !writingIntro
        ? [{ type: 'tool-call', toolCallId: 'emit', toolName: 'emit', input: JSON.stringify(plan) }]
        : [{ type: 'text', text: writingIntro ? intro : JSON.stringify(plan) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    };
  }) as never);
  t.mock.method(globalThis, 'fetch', (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === base) return realFetch(input, init);
    if (url.hostname !== 'stand-in-library.invalid') throw Error('synthetic offline dependency');
    const endpoint = url.pathname.split('/').at(-1);
    const data = endpoint === 'search3' ? { searchResult3: { song: [song, other], artist: [{ id: 'queen', name: 'Queen' }] } }
      : endpoint === 'getArtist' ? { artist: { album: [{ id: 'queen-album', name: 'Albums' }] } }
        : endpoint === 'getAlbum' ? { album: { song: [song, other] } } : {};
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
  }) as never);
});

after(async () => {
  server.close();
  requestAgent.run = realRequestRun;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

async function submit(text: string) {
  const response = await realFetch(`${base}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ip}` },
    body: JSON.stringify({ text, name: 'Listener' }),
  });
  const accepted: any = await response.json();
  assert.equal(response.status, 202, JSON.stringify(accepted));
  for (let n = 0; n < 250; n++) {
    const result: any = await (await realFetch(`${base}/request/${accepted.requestId}`)).json();
    if (result.status !== 'pending') return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('request did not settle');
}

// The two surfaces a turn reaches, read the way their readers read them.
async function assertNotRemembered(line: string) {
  const memory = JSON.stringify(session.windowMessages());
  assert.ok(!memory.includes(line), `DJ memory holds ${JSON.stringify(line)}: ${memory}`);
  const feed = await (await realFetch(`${base}/session`)).text();
  assert.ok(!feed.includes(line), `GET /session serves ${JSON.stringify(line)}: ${feed}`);
}

async function assertRemembered(line: string) {
  assert.ok(JSON.stringify(session.windowMessages()).includes(line), `DJ memory lacks ${JSON.stringify(line)}`);
  assert.ok((await (await realFetch(`${base}/session`)).text()).includes(line), `GET /session lacks ${JSON.stringify(line)}`);
}

test('the request cascade records the ack when push() drops the intro', async () => {
  const result = await submit('Queen, Bohemian Rhapsody');
  assert.equal(result.outcome, 'matched');
  const item = queue.upcoming.find(i => i.requestedBy === 'Listener')!;
  assert.ok(item, 'the requested track is still queued');
  assert.equal(item.introScript, null);
  await assertNotRemembered('placeholder');
  await assertRemembered(result.ack);
  assert.equal(requestLog.snapshot(1)[0].introScript, null, 'the request log keeps what aired');
});

test('the more-like-this path records the ack when push() drops the intro', async () => {
  queue.current = { track: { id: 'seed', title: 'Seed', artist: 'Queen' } } as never;
  const result = await submit('more like this');
  assert.ok(result.track, JSON.stringify(result));
  await assertNotRemembered('placeholder');
  await assertRemembered('More from Queen, coming up.');
  assert.equal(requestLog.snapshot(1)[0].introScript, null);
});

test('the conversational agent records the ack when push() drops the intro', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  requestAgent.run = (async () => ({
    object: { kind: 'track', id: song.id, ack: 'Found it, coming up.', intro: 'placeholder' },
    steps: 1, toolCalls: [], extras: { seen: new Map([[song.id, song]]) },
  })) as never;

  // The route posts this first. The window drops a leading assistant turn, so
  // without it the DJ's line would vanish from memory whatever push() did.
  session.appendTurn({ role: 'event', kind: 'request', text: 'Listener "Listener" requests: "the one about the rhapsody"' });
  const result = await runRequest(queue, { requester: 'Listener', text: 'the one about the rhapsody' });

  assert.equal(result?.introScript, null, 'the route logs this as what will air');
  assert.equal(queue.upcoming[0].track.id, song.id);
  await assertNotRemembered('placeholder');
  await assertRemembered(String(result?.ack));
});

test('a real intro is still remembered as said', async () => {
  intro = 'Here comes the big one for you.';
  await submit('Queen, Bohemian Rhapsody');
  assert.equal(queue.upcoming.find(i => i.requestedBy === 'Listener')!.introScript, intro);
  await assertRemembered(intro);
  assert.equal(requestLog.snapshot(1)[0].introScript, intro);
});
