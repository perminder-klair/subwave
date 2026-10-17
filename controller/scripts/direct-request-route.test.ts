// Drive the public route through real interpretation, catalogue lookup and queue
// insertion. Only off-box HTTP and the provider's generation method are mocked.
import assert from 'node:assert/strict';
import test, { after, beforeEach, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RequestSong } from '../src/music/request-match.js';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-direct-route-'));
process.env.NAVIDROME_URL = 'http://direct-library.invalid';
const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/request.js');
const { queue } = await import('../src/broadcast/queue.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { recentCalls } = await import('../src/llm/log.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { invalidateWeatherCache } = await import('../src/context.js');
const { REQUEST_SCHEMA_TOLERANT } = await import('../src/llm/internal/prompts/request.js');

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
after(() => server.close());
const exact = { id: 'queen-song', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 300, genre: 'Rock', language: 'English', moods: ['energetic'] };
const filler = { id: 'filler-song', title: 'Fatigue', artist: 'The Gathering', genre: 'Rock', duration: 200 };
let ip = 0;
let modelOutput: Record<string, unknown>;
let modelError = false;
let introError = false;
let searchEmpty = false;
let catalogueSongs: RequestSong[];
let bodies: any[] = [];
let agentCalls = 0;

beforeEach(async context => {
  const t = context as TestContext;
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: { requestMatching: 'direct', provider: 'openai-compatible', compatibleMode: 'local',
      baseUrl: 'http://direct-model.invalid/v1', model: 'no-tools', fallback: { enabled: false }, dailyTokenCap: 0 },
    requests: { enabled: true, onePendingPerIp: false, maxPending: 50, globalHourlyCap: 1000, repeatCooldownMin: 120 },
  } as never);
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.senderBusy = true;
  queue._recentPlays = [];
  invalidateWeatherCache();
  bodies = [];
  modelError = false;
  introError = false;
  searchEmpty = false;
  catalogueSongs = [filler, exact];
  agentCalls = 0;
  modelOutput = { kind: 'track', title: exact.title, artist: 'Queen', search_terms: [exact.title, 'Queen'], genre: 'Rock', scope: 'song' };
  t.mock.method(requestAgent, 'run', async () => { agentCalls++; throw Error('Direct must never invoke the request agent'); });
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as any, 'doGenerate', async (options: any) => {
    bodies.push(options);
    assert.ok(!options.tools?.length, 'no tools are sent to a tool-incapable model');
    assert.ok(!options.responseFormat || options.responseFormat.type === 'text', 'no native-schema capability is required');
    if (modelError) throw Error('synthetic interpreter failure');
    const intro = JSON.stringify(options.prompt).includes('Write an intro for this track');
    if (intro && introError) throw Error('synthetic intro failure');
    return { content: [{ type: 'text', text: intro ? 'A clean DJ intro.' : JSON.stringify(modelOutput) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  });
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === base) return realFetch(input, init);
    if (url.hostname !== 'direct-library.invalid') throw Error('synthetic offline dependency');
    const endpoint = url.pathname.split('/').at(-1);
    const data = endpoint === 'search3' ? { searchResult3: { song: searchEmpty ? [] : catalogueSongs } }
      : endpoint === 'getStarred2' ? { starred2: { song: [filler] } }
        : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: [filler] } }
        : endpoint === 'getGenres' ? { genres: { genre: [{ value: 'Rock', songCount: 2 }] } }
          : endpoint === 'getArtist' ? { artist: { album: [] } } : {};
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
  });
});

async function submit(text = 'Queen, Bohemian Rhapsody') {
  const response = await realFetch(`${base}/request`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ip}` }, body: JSON.stringify({ text, name: 'Listener' }) });
  const accepted: any = await response.json();
  assert.equal(response.status, 202, JSON.stringify(accepted));
  for (let n = 0; n < 250; n++) {
    const result: any = await (await realFetch(`${base}/request/${accepted.requestId}`)).json();
    if (result.status !== 'pending') {
      assert.equal(agentCalls, 0, 'Direct bypasses the agent, including when its failure could be caught');
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('request did not settle');
}

test('Direct searches the named recording before genre candidates, with one tool-free model call', async () => {
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(bodies.length, 1);
  assert.ok(recentCalls.some(c => c.kind === 'matchRequest' && c.via === 'ai-sdk:json'));
});

test('a failed interpreter falls back to a bounded title/artist parser', async () => {
  modelError = true;
  const result = await submit('Please play Bohemian Rhapsody by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('an empty but valid model reply falls back to literal request identity', async () => {
  modelOutput = {};
  const result = await submit('Bohemian Rhapsody by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
});

test('an artist-only model reply cannot erase a literal named song request', async () => {
  modelOutput = { artist: 'Queen', search_terms: ['Queen'] };
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
});

test('a failed intro preserves the requested music and reports success', async () => {
  await settings.update({ tts: { enabled: true } } as never);
  introError = true;
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(queue.upcoming[0].introScript, null);
});

test('the player receives an explicit cooldown refusal rather than a queued success', async () => {
  queue._recentPlays = [{ ...exact, endedAt: new Date().toISOString() }];
  const result = await submit();
  assert.equal(result.outcome, 'cooldown');
  assert.equal(result.queuePosition, null);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(result.track.title, exact.title);
});

test('the configured four-hour cooldown reaches selection', async () => {
  await settings.update({ requests: { repeatCooldownMin: 240 } } as never);
  queue._recentPlays = [{ ...exact, endedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }];
  assert.equal((await submit()).outcome, 'cooldown');
});

test('disabling cooldown permits a recently played exact recording', async () => {
  await settings.update({ requests: { repeatCooldownMin: 0 } } as never);
  queue._recentPlays = [{ ...exact, endedAt: new Date().toISOString() }];
  assert.equal((await submit()).outcome, 'matched');
});

test('a queued exact recording is acknowledged without selecting a different song', async () => {
  queue.upcoming.push({ track: exact } as never);
  const result = await submit();
  assert.equal(result.outcome, 'already-queued');
  assert.equal(queue.upcoming.length, 1);
  assert.equal(result.track.title, exact.title);
});

test('substitution wording describes the real outcome without claiming library absence', async () => {
  searchEmpty = true;
  const result = await submit();
  assert.equal(result.outcome, 'substituted');
  assert.equal(result.track.title, filler.title);
  assert.match(result.ack, /alternative/);
  assert.doesNotMatch(result.ack, /artist.*(?:find|library|crates)|Freddie|Queen/);
});

test('chat responses do not queue a track', async () => {
  modelOutput = { kind: 'chat', ack: 'Hello from the booth.' };
  const result = await submit('Hello DJ');
  assert.equal(result.outcome, 'chat');
  assert.equal(result.track, null);
  assert.equal(queue.upcoming.length, 0);
});

test('a named song in an unavailable language does not queue the wrong language', async () => {
  modelOutput = { title: exact.title, artist: 'Queen', language: 'French' };
  const result = await submit('Play Bohemian Rhapsody by Queen in French');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('an unmet mood is acknowledged as a compromise rather than an exact match', async () => {
  modelOutput = { artist: 'Queen', mood: 'calm', search_terms: ['Queen'] };
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'substituted');
  assert.equal(result.track.artist, 'Queen');
  assert.match(result.ack, /verify the requested mood/);
  assert.equal(queue.upcoming.length, 1);
});

test('an artist mood description is not restored as a literal song title', async () => {
  catalogueSongs.push({ ...exact, id: 'calm', title: 'Calm Example', moods: ['calm'] });
  modelOutput = { artist: 'Queen', mood: 'calm', search_terms: ['Queen'] };
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, 'calm');
});

test('failed interpretation cannot discard an artist mood description', async () => {
  modelError = true;
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});

test('failed interpretation cannot relax a trailing language condition into an artist match', async () => {
  modelError = true;
  const result = await submit('Play Bohemian Rhapsody by Queen in French');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('a model cannot silently discard a common exclusion', async () => {
  modelOutput = { artist: 'Queen' };
  const result = await submit('Play anything except Queen');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'unsupported');
  assert.match(result.message, /conditions/);
  assert.equal(queue.upcoming.length, 0);
});

test('model-detected unsupported conditions survive an otherwise empty plan', async () => {
  modelOutput = { unsupported: ['earlier conversation'] };
  const result = await submit('Play the one we discussed earlier');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});

test('the exclusion backstop still works when interpretation fails', async () => {
  modelError = true;
  const result = await submit('Play anything except Queen');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});

test('more like this excludes its seed and reaches the similarity fallback', async () => {
  queue.current = { track: exact } as never;
  const result = await submit('more like this');
  assert.equal(result.track.title, filler.title);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, filler.id);
  assert.equal(bodies.length, 0, 'the shortcut needs neither interpretation nor tools');
});

test('the final queue blocklist gate still refuses a selected exact recording', async t => {
  t.mock.method(queue, 'push', async () => -2);
  const result = await submit();
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('a concurrent queue insertion is reported as already queued', async t => {
  t.mock.method(queue, 'push', async () => -1);
  const result = await submit();
  assert.equal(result.outcome, 'already-queued');
  assert.equal(result.queuePosition, null);
});

test('small-model omissions default descriptive fields without losing identity', () => {
  const parsed: any = REQUEST_SCHEMA_TOLERANT.parse({ title: exact.title, artist: 'Queen' });
  assert.equal(parsed.title, exact.title);
  assert.equal(parsed.kind, 'track');
  assert.equal(parsed.scope, 'song');
  assert.deepEqual(parsed.search_terms, []);
  assert.equal(parsed.ack, '');
  assert.deepEqual(parsed.unsupported, []);
});
