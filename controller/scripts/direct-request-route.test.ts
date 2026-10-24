// Drive the public route through real interpretation, catalogue lookup and queue
// insertion. Only off-box HTTP and the provider's generation method are mocked.
import assert from 'node:assert/strict';
import test, { after, beforeEach, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RequestSong } from '../src/music/request-match.js';
import type { ListenerRequestEntry } from '../src/routes/request.js';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-direct-route-'));
process.env.NAVIDROME_URL = 'http://direct-library.invalid';
const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router, resolveListenerRequest, requestResolutionTimeoutMs, submitListenerRequest } = await import('../src/routes/request.js');
const { queue } = await import('../src/broadcast/queue.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const requestLog = await import('../src/broadcast/request-log.js');
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');
const { recentCalls } = await import('../src/llm/log.js');
const { requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
const { invalidateWeatherCache } = await import('../src/context.js');
const { REQUEST_SCHEMA_TOLERANT } = await import('../src/llm/internal/prompts/request.js');
const { WebSearchProviderError } = await import('../src/skills/web-search.js');

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
after(() => server.close());
const exact = { id: 'queen-song', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 300, genre: 'Rock', language: 'English', moods: ['energetic'] };
const titleOnlyExact = { id: 'daaku-song', title: 'Daaku', artist: 'Unknown Artist', album: 'Daaku', duration: 180 };
const filler = { id: 'filler-song', title: 'Fatigue', artist: 'The Gathering', genre: 'Rock', duration: 200 };
let ip = 0;
let modelOutput: Record<string, unknown>;
let modelError = false;
let modelStalls = false;
let introError = false;
let introStalls = false;
let searchEmpty = false;
let catalogueSongs: RequestSong[];
// The artist catalogue and genre pool the issue's lottery drew from; empty
// unless a test asks for them.
let artistSongs: RequestSong[];
let genreSongs: RequestSong[];
let bodies: any[] = [];
let agentCalls = 0;
let agentResult: any = null;
let agentError: Error | null = null;
let agentDelayMs = 0;
let modelDelayMs = 0;
let libraryStalls = false;
let libraryDelayMs = 0;
let librarySearchFails = false;
let librarySignals: Array<AbortSignal | null | undefined> = [];
// The words of every song search the library was sent.
let songSearches: string[] = [];

beforeEach(async context => {
  const t = context as TestContext;
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: { requestMatching: 'direct', provider: 'openai-compatible', compatibleMode: 'local',
      baseUrl: 'http://direct-model.invalid/v1', model: 'no-tools', fallback: { enabled: false }, dailyTokenCap: 0, requestTimeoutMs: 300000, agentTimeoutMs: 45000 },
    requests: { enabled: true, onePendingPerIp: false, maxPending: 50, globalHourlyCap: 1000, repeatCooldownMin: 120 },
  } as never);
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  queue.senderBusy = true;
  queue._recentPlays = [];
  invalidateWeatherCache();
  bodies = [];
  modelError = false;
  modelStalls = false;
  introError = false;
  introStalls = false;
  searchEmpty = false;
  catalogueSongs = [filler, exact];
  artistSongs = [];
  genreSongs = [];
  agentCalls = 0;
  agentResult = null;
  agentError = null;
  agentDelayMs = 0;
  modelDelayMs = 0;
  libraryStalls = false;
  libraryDelayMs = 0;
  librarySearchFails = false;
  librarySignals = [];
  songSearches = [];
  modelOutput = { kind: 'track', title: exact.title, artist: 'Queen', search_terms: [exact.title, 'Queen'], genre: 'Rock', scope: 'song' };
  t.mock.method(requestAgent, 'run', async () => {
    agentCalls++;
    if (agentDelayMs) await new Promise(resolve => setTimeout(resolve, agentDelayMs));
    if (agentError) throw agentError;
    if (agentResult) return agentResult;
    throw Error('Direct must never invoke the request agent');
  });
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as any, 'doGenerate', async (options: any) => {
    bodies.push(options);
    if (modelStalls) return new Promise(() => {});
    if (modelDelayMs) await new Promise(resolve => setTimeout(resolve, modelDelayMs));
    if (modelError) throw Error('synthetic interpreter failure');
    const intro = JSON.stringify(options.prompt).includes('Write an intro for this track');
    if (intro && introStalls) return new Promise(() => {});
    if (intro && introError) throw Error('synthetic intro failure');
    return { content: options.tools?.length
      ? [{ type: 'tool-call', toolCallId: 'emit-answer', toolName: 'emit', input: JSON.stringify(modelOutput) }]
      : [{ type: 'text', text: intro ? 'A clean DJ intro.' : JSON.stringify(modelOutput) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  });
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === base) return realFetch(input, init);
    if (url.hostname !== 'direct-library.invalid') throw Error('synthetic offline dependency');
    librarySignals.push(init?.signal);
    if (url.pathname.endsWith('/search3') && Number(url.searchParams.get('songCount')) > 0) songSearches.push(url.searchParams.get('query') || '');
    if (libraryStalls) return new Promise<Response>(() => {});
    if (libraryDelayMs) await new Promise(resolve => setTimeout(resolve, libraryDelayMs));
    const endpoint = url.pathname.split('/').at(-1);
    if (librarySearchFails && endpoint === 'search3') throw Error('synthetic search failure');
    const artistQuery = artistSongs.length && /queen/i.test(url.searchParams.get('query') || '');
    const data = endpoint === 'search3' ? { searchResult3: { song: searchEmpty ? [] : catalogueSongs, artist: artistQuery ? [{ id: 'queen', name: 'Queen' }] : [] } }
      : endpoint === 'getStarred2' ? { starred2: { song: [filler] } }
        : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: [filler] } }
        : endpoint === 'getGenres' ? { genres: { genre: ['Rock', 'Funk', 'R&B', 'Punjabi Pop'].map(value => ({ value, songCount: 2 })) } }
          : endpoint === 'getSongsByGenre' ? { songsByGenre: { song: genreSongs } }
          : endpoint === 'getArtist' ? { artist: { album: artistSongs.length ? [{ id: 'queen-album', name: 'Sheer Heart Attack' }] : [] } }
          : endpoint === 'getAlbum' ? { album: { song: artistSongs } } : {};
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
  });
});

async function submit(text = 'Queen, Bohemian Rhapsody', maxPolls = 250) {
  const response = await realFetch(`${base}/request`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ip}` }, body: JSON.stringify({ text, name: 'Listener' }) });
  const accepted: any = await response.json();
  assert.equal(response.status, 202, JSON.stringify(accepted));
  for (let n = 0; n < maxPolls; n++) {
    const result: any = await (await realFetch(`${base}/request/${accepted.requestId}`)).json();
    if (result.status !== 'pending') {
      if (settings.get().llm?.requestMatching !== 'agentic' && !agentResult && !agentError) {
        assert.equal(agentCalls, 0, 'Direct mode bypasses the agent');
      }
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('request did not settle');
}

async function submitShared(text: string): Promise<any> {
  const submission: any = await submitListenerRequest({
    text,
    name: 'Alexa listener',
    ip: `198.51.100.${++ip}`,
  });
  if (!submission.accepted) return submission;
  for (let n = 0; n < 250; n++) {
    const result: any = await (await realFetch(`${base}/request/${submission.requestId}`)).json();
    if (result.status !== 'pending') return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('shared request did not settle');
}

test('long lyric prose goes through the evidence agent instead of the literal parser', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const patientZero = { id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift' };
  agentResult = {
    object: { id: patientZero.id, ack: 'Found the lyric match.' },
    steps: 1,
    toolCalls: [],
    extras: { seen: new Map([[patientZero.id, patientZero]]) },
  };
  const result = await submit('But if you wanna party with somebody who might know About the devil on his shoulder under his halo When the toxins take their hold, you would rather die than let it go But if you are sick of him, I got you, I was patient zero');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, patientZero.title);
  assert.equal(result.track.artist, patientZero.artist);
  assert.equal(agentCalls, 1);
});

test('a stalled intro regeneration on the evidence path cannot discard the identified track', async () => {
  await settings.update({ tts: { enabled: true }, llm: { requestMatching: 'agentic', requestTimeoutMs: 5000 } } as never);
  introStalls = true;
  const lyric = 'But if you wanna party with somebody who might know About the devil on his shoulder under his halo When the toxins take their hold, you would rather die than let it go But if you are sick of him, I got you, I was patient zero';
  const patientZero = { id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift' };
  agentResult = {
    // The intro reads the request back, so the echo guard regenerates it.
    object: { id: patientZero.id, ack: 'Found the lyric match.', intro: `Here it is: ${lyric}` },
    steps: 1,
    toolCalls: [],
    extras: { seen: new Map([[patientZero.id, patientZero]]) },
  };
  const result = await submit(lyric, 1000);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, patientZero.id);
  assert.equal(queue.upcoming[0].introScript, null);
});

test('short transliterated lyric prose also goes through the evidence agent', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const chitteSuit = { id: 'chitte-suit', title: 'White Suit', artist: 'Fixture Punjabi Artist' };
  agentResult = {
    object: { id: chitteSuit.id, ack: 'Found the lyric match.' },
    steps: 1,
    toolCalls: [],
    extras: { seen: new Map([[chitteSuit.id, chitteSuit]]) },
  };
  const result = await submit('chite suit te daag pai gaye gali teri vich gara');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, chitteSuit.title);
  assert.equal(result.track.artist, chitteSuit.artist);
  assert.equal(agentCalls, 1);
});

test('direct mode keeps language-plus-genre requests on deterministic resolution', async () => {
  const punjabiRock = { id: 'punjabi-rock', title: 'Punjabi Rock Fixture', artist: 'Fixture Punjabi Artist', genre: 'Rock', language: 'Punjabi' };
  catalogueSongs = [punjabiRock];
  genreSongs = [punjabiRock];
  modelOutput = { kind: 'track', title: null, artist: null, genre: 'Rock', language: 'Punjabi', search_terms: [], scope: 'song' };

  const result = await submit('play some rock music in Punjabi');

  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, punjabiRock.title);
  assert.equal(agentCalls, 0);
});

test('agentic matching sends compound exclusion requests to the agent first', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const nonQueen = { id: 'non-queen', title: 'Fixture Outside Queen', artist: 'Fixture Artist' };
  agentResult = {
    object: { id: nonQueen.id, ack: 'Here is a track outside that artist.' },
    steps: 1,
    toolCalls: [{ name: 'searchLibrary' }],
    extras: { seen: new Map([[nonQueen.id, nonQueen]]) },
  };

  const result = await submit('Play anything except Queen');

  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, nonQueen.title);
  assert.equal(agentCalls, 1);
  assert.equal(bodies.length, 0, 'an agent match must not fall through to direct interpretation');
});

test('agentic matching sends recording-condition requests to the agent first', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const instrumental = { id: 'instrumental-1990s', title: 'Fixture Instrumental', artist: 'Fixture Artist' };
  agentResult = {
    object: { id: instrumental.id, ack: 'Here is an instrumental track from that era.' },
    steps: 1,
    toolCalls: [{ name: 'searchLibrary' }],
    extras: { seen: new Map([[instrumental.id, instrumental]]) },
  };

  const result = await submit('Play instrumental tracks from the 1990s');

  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, instrumental.title);
  assert.equal(agentCalls, 1);
  assert.equal(bodies.length, 0, 'an agent match must not fall through to direct interpretation');
});

test('an agentic null result falls through to the deterministic resolver', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentResult = { object: {}, toolCalls: [{ name: 'searchLibrary' }], extras: { seen: new Map() } };

  const result = await submit();

  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(agentCalls, 1);
  assert.equal(bodies.length, 1);
});

test('an agent infrastructure failure falls through to the deterministic resolver', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentError = new Error('synthetic request-agent failure');

  const result = await submit();

  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(agentCalls, 1);
  assert.equal(bodies.length, 1);
});

test('a song request naming only a film goes through evidence identification', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const shapeOfWoman = { id: 'shape-of-woman', title: 'Shape of Woman', artist: 'Fixture Artist', album: 'The Devil Wears Prada 2' };
  agentResult = {
    object: { id: shapeOfWoman.id, ack: 'Found a track from that film.' },
    steps: 1,
    toolCalls: [{ name: 'identifyRequestedTrack', result: { candidates: [shapeOfWoman] } }],
    extras: { seen: new Map([[shapeOfWoman.id, shapeOfWoman]]) },
  };
  for (const text of ['a song from The Devil Wears Prada 2', 'a song from The Devil Wears Prada2']) {
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(result.track.title, shapeOfWoman.title);
    assert.equal(result.track.artist, shapeOfWoman.artist);
    queue.upcoming = [];
  }
  assert.equal(agentCalls, 2);
});

test('an evidence-agent miss does not enter the unsupported direct-request path', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentResult = { object: {}, steps: 1, toolCalls: [{ name: 'identifyRequestedTrack' }], extras: { seen: new Map() } };
  const result = await submit('phull koyi vilyat wala lai geya ghod da main reh geya keyariyan');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.match(result.message, /identify that song/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(bodies.length, 0, 'an evidence miss must not make a second direct matcher call');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'agent:evidence-miss');
  assert.ok(requestLog.snapshot(1)[0].stages.includes('web-evidence'));
});

test('an evidence agent that declines its candidates is an honest miss, not a re-picked match', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const sameArtist = { id: 'same-artist', title: 'A Different Song', artist: 'Fixture Punjabi Artist' };
  agentResult = {
    object: { kind: 'track', id: null, ack: 'That one is not in the library.' },
    steps: 1,
    toolCalls: [{ name: 'identifyRequestedTrack' }],
    extras: { seen: new Map([[sameArtist.id, sameArtist]]) },
  };
  const result = await submit('phull koyi vilyat wala lai geya ghod da main reh geya keyariyan');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
  assert.equal(bodies.length, 0, 'a declined answer must not spend a re-pick or a direct matcher call');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'agent:evidence-miss');
});

test('an evidence agent cannot report a real stand-in id as a matched request', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const standIn = { id: 'same-artist', title: 'A Different Song', artist: 'Fixture Punjabi Artist' };
  const verifiedCandidate = { id: 'verified-song', title: 'The Requested Song', artist: 'Fixture Punjabi Artist' };
  agentResult = {
    object: { kind: 'track', id: standIn.id, ack: 'Coming up for you.' },
    steps: 1,
    toolCalls: [{
      name: 'identifyRequestedTrack',
      result: { candidates: [verifiedCandidate] },
    }],
    extras: { seen: new Map([[standIn.id, standIn], [verifiedCandidate.id, verifiedCandidate]]) },
  };
  const result = await submit('the song from the film with the unforgettable closing scene');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.match(result.message, /identify that song/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'agent:evidence-miss');
});

test('an evidence-provider failure is reported accurately without a hidden fallback', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentError = new WebSearchProviderError('searxng', 'rate-limit', 'SearXNG HTTP 429');
  const result = await submit('phull koyi vilyat wala lai geya ghod da main reh geya keyariyan');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'provider-error');
  assert.match(result.message, /search provider/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(bodies.length, 0, 'a provider failure must not silently enter another resolver');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'agent:provider-error');
});

test('Direct searches the named recording before genre candidates, with one interpretation call', async () => {
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(bodies.length, 1);
  assert.ok(recentCalls.some(c => c.kind === 'matchRequest' && ['ai-sdk', 'ai-sdk:tool'].includes(c.via || '')));
});

test('browser and Alexa submissions share the same typed resolver outcome', async () => {
  const browser = await submit();
  assert.equal(browser.outcome, 'matched');
  queue.upcoming = [];

  const resolved = await submitShared('Queen, Bohemian Rhapsody');
  assert.equal(resolved.outcome, 'matched');
  assert.equal(resolved.track?.title, browser.track.title);
});

test('latest release requests keep browser and Alexa on the same local fallback pipeline', async () => {
  artistSongs = [{ id: 'queen-newest-local', title: 'Newest Local Track', artist: 'Queen', album: 'Sheer Heart Attack' }];
  modelOutput = { kind: 'track', title: null, artist: 'Queen', search_terms: [], sort: 'latest', scope: 'song' };
  const browser = await submit('latest song by Queen');
  assert.equal(browser.outcome, 'substituted');
  assert.equal(browser.track.title, 'Newest Local Track');
  assert.match(browser.ack, /newest available track/i);
  assert.equal(agentCalls, 0, 'direct request mode bypasses the request agent');

  queue.upcoming = [];
  modelOutput = { kind: 'track', title: null, artist: 'Queen', search_terms: [], sort: 'latest', scope: 'song' };
  const resolved = await submitShared('latest song by Queen');
  assert.equal(resolved.outcome, browser.outcome);
  assert.equal(resolved.track?.title, browser.track.title);
  assert.match(resolved.ack || '', /newest available track/i);
});

test('a latest request without an artist is rejected before admission', async () => {
  const response = await realFetch(`${base}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ip}` },
    body: JSON.stringify({ text: 'latest song', name: 'Listener' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { message?: string };
  assert.match(body.message || '', /which artist/i);
  const shared = await submitShared('latest album');
  assert.equal(shared.accepted, false);
  assert.match(shared.message || '', /which artist/i);
});

test('a short title goes to the interpreter first, as anything else does', async () => {
  catalogueSongs = [filler, titleOnlyExact];
  modelOutput = { kind: 'track', title: 'Daaku', artist: null, search_terms: ['Daaku'], scope: 'song' };
  const result = await submit('daaku');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, titleOnlyExact.title);
  assert.equal(result.track.artist, titleOnlyExact.artist);
  assert.equal(queue.upcoming[0].track.id, titleOnlyExact.id);
  assert.equal(bodies.length, 1);
});

test('a missing short title the interpreter reads as a name fails without an unrelated fallback', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = { kind: 'track', title: 'Daaku', artist: null, search_terms: ['Daaku'], scope: 'song' };
  const result = await submit('daaku');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.match(result.message, /couldn't find|could not find|no match|nothing .* matched/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(bodies.length, 1);
});

test('a framed impossible title stays no-match instead of taking an agent vibe fallback', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentResult = { object: {}, toolCalls: [{ name: 'searchLibrary' }], extras: { seen: new Map() } };
  catalogueSongs = [filler];
  searchEmpty = true;
  const result = await submit('play qzxv impossible recording 918273');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'no-match');
  assert.match(result.message, /couldn.t find|could not find|no match|nothing .* matched/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(agentCalls, 1, 'agentic mode tries the agent before direct fallback');
});

test('"by" keeps its credit behind a reading of search terms alone', async () => {
  // The library has U2's Vertigo and no Queen recording of it, so it can go
  // out, but as an alternative, never "Found a match".
  const vertigo = { id: 'u2-vertigo', title: 'Vertigo', artist: 'U2', duration: 190 };
  catalogueSongs = [vertigo];
  modelOutput = { kind: 'track', title: null, artist: null, search_terms: ['Vertigo', 'Queen'], scope: 'song' };
  const miss = await submit('play Vertigo by Queen');
  assert.equal(miss.track?.title, 'Vertigo');
  assert.equal(miss.track?.artist, 'U2');
  assert.equal(miss.outcome, 'substituted');

  queue.upcoming = [];
  catalogueSongs = [filler, exact];
  modelOutput = { kind: 'track', title: null, artist: null, search_terms: [exact.title, 'Queen'], scope: 'song' };
  const hit = await submit(`play ${exact.title} by Queen`);
  assert.equal(hit.track?.title, exact.title);
  assert.equal(hit.outcome, 'matched');
});

test('an attribute reading of words holding "by" keeps its match', async () => {
  // "rock songs by candlelight" parses as a pair, but the reading is a genre,
  // so no credit was dropped and the genre's track is a match.
  genreSongs = [exact];
  modelOutput = { kind: 'track', title: null, artist: null, genre: 'Rock', search_terms: [], scope: 'song' };
  const result = await submit('rock songs by candlelight');
  assert.equal(result.track?.title, exact.title);
  assert.equal(result.outcome, 'matched');
});

test('a blocked local candidate is no near title, and nothing names it', async () => {
  const library = await import('../src/music/library.js');
  const db = await import('../src/music/library-db.js');
  const blocklist = await import('../src/music/blocklist.js');
  await library.load();
  await blocklist.load();
  db.upsertTrackMeta('lanterns-blocked', { title: 'Paper Lanterns', artist: 'Blocked Act', duration: 200 });
  db.upsertTrackMeta('lanterne-open', { title: 'Paper Lanterne', artist: 'Open Act', duration: 200 });
  await blocklist.add({ type: 'track', id: 'lanterns-blocked', name: 'Paper Lanterns', artist: 'Blocked Act' });
  try {
    catalogueSongs = [filler];
    searchEmpty = true;
    modelOutput = { kind: 'track', title: 'Paper Lantern', artist: null, search_terms: ['Paper Lantern'], scope: 'song' };
    const result = await submit('play Paper Lantern');
    // The blocked recording and the open one would tie as near titles; with
    // the blocked one gone the open one stands in alone.
    assert.doesNotMatch(JSON.stringify(result), /Paper Lanterns|Blocked Act/);
    assert.equal(result.track?.title, 'Paper Lanterne');
    assert.equal(result.outcome, 'substituted');
  } finally {
    await blocklist.remove('track', 'lanterns-blocked');
    db.getDb()!.prepare("DELETE FROM tracks WHERE id IN ('lanterns-blocked', 'lanterne-open')").run();
  }
});

test('a one-word artist remains artist-capable after a title miss', async () => {
  catalogueSongs = [filler];
  artistSongs = [exact];
  modelError = true;
  const result = await submit('Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(result.track.artist, exact.artist);
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('a stalled interpreter gives way to the literal parse instead of timing the request out', async () => {
  // 5000 ms is the settings floor for one generation.
  await settings.update({ llm: { requestTimeoutMs: 5000 } } as never);
  modelStalls = true;
  const result = await submit('Please play Bohemian Rhapsody by Queen', 650);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(requestLog.snapshot(1)[0].interpretationFallback, true);
});

test('an agent failure cannot replace an explicit voice request with another artist track', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentResult = { object: {}, toolCalls: [{ name: 'searchLibrary' }], extras: { seen: new Map() } };
  catalogueSongs = [
    { id: 'blank-space', title: 'Blank Space', artist: 'Taylor Swift' },
    { id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift' },
  ];
  modelOutput = { kind: 'track', title: 'Blank Space', artist: 'Taylor Swift', search_terms: ['Taylor Swift'] };
  const result = await submit('patient 0 by Taylor swift');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, 'Patient Zero');
  assert.equal(result.track.artist, 'Taylor Swift');
  assert.equal(queue.upcoming[0].track.id, 'patient-zero');
  assert.equal(agentCalls, 1, 'agentic mode tries the agent before deterministic fallback');
});

test('a failed interpreter falls back to a bounded title/artist parser', async () => {
  modelError = true;
  const result = await submit('Please play Bohemian Rhapsody by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('a valid empty plan still reaches a suitable library fallback', async () => {
  modelOutput = {};
  const result = await submit('Surprise me');
  assert.equal(result.outcome, 'substituted');
  assert.ok(result.track);
  assert.match(result.ack, /alternative/);
});

test('an artist-only model reply cannot erase a literal named song request', async () => {
  modelOutput = { artist: 'Queen', search_terms: ['Queen'] };
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
});

test('a title containing from queues that recording without album proof', async () => {
  const postcards = { id: 'postcards', title: 'Postcards from Italy', artist: 'Beirut', album: 'Gulag Orkestar', duration: 260 };
  const letter = { id: 'letter', title: 'Letter from America', artist: 'The Proclaimers', album: 'Sunshine on Leith', duration: 280 };
  catalogueSongs = [filler, postcards, letter];
  for (const [text, song] of [['play Postcards from Italy', postcards], ['Postcards from Italy', postcards], ['play Letter from America', letter]] as const) {
    queue.upcoming = [];
    modelOutput = { kind: 'track', title: song.title, search_terms: [song.title], scope: 'song' };
    const result = await submit(text);
    assert.equal(result.outcome, 'matched', text);
    assert.equal(result.track.title, song.title, text);
    assert.equal(queue.upcoming[0].track.id, song.id, text);
  }
});

test('a two-letter language code in a title is not a language request', async () => {
  const rockIt = { id: 'rock-it', title: 'Rock It', artist: 'Herbie Hancock', album: 'Future Shock', genre: 'Jazz', duration: 320 };
  catalogueSongs = [filler, rockIt];
  genreSongs = [filler];
  // Read by the interpreter, and by the literal parser when the interpreter fails.
  for (const failed of [false, true]) {
    queue.upcoming = [];
    modelError = failed;
    modelOutput = { kind: 'track', title: rockIt.title, search_terms: [rockIt.title], scope: 'song' };
    const result = await submit('Play Rock It');
    assert.equal(result.outcome, 'matched', `interpreter failed: ${failed}`);
    assert.equal(result.track.title, rockIt.title, `interpreter failed: ${failed}`);
    assert.equal(queue.upcoming[0].track.id, rockIt.id, `interpreter failed: ${failed}`);
  }
});

test('a failed intro preserves the requested music and reports success', async () => {
  await settings.update({ tts: { enabled: true } } as never);
  introError = true;
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(queue.upcoming[0].introScript, null);
  assert.equal(requestLog.snapshot(1)[0].introFailure, 'intro-failed');
  assert.equal(requestLog.snapshot(1)[0].guard, null);
  assert.ok(queue.djLog.some((line: any) => /optional intro failed/.test(line.message)));
  assert.ok(!queue.djLog.some((line: any) => /intro echoed request text/.test(line.message)));
});

test('a late intro cannot discard an already selected track', async () => {
  // 5000 ms is the settings floor for one generation, so the request settles
  // after about five seconds and must be waited for.
  await settings.update({ tts: { enabled: true }, llm: { requestTimeoutMs: 5000 } } as never);
  introStalls = true;
  const result = await submit(undefined, 1000);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(queue.upcoming[0].introScript, null);
  assert.equal(requestLog.snapshot(1)[0].introFailure, 'intro-failed');
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

test('an explicit named miss is reported without silently substituting another track', async () => {
  searchEmpty = true;
  const result = await submit();
  assert.equal(result.outcome, 'no-match');
  assert.equal(result.track, null);
  assert.equal(queue.upcoming.length, 0);
  assert.doesNotMatch(result.ack || '', /alternative|Freddie|Queen/);
});

test('a framed impossible title is not mistaken for lyric evidence and substituted', async () => {
  searchEmpty = true;
  const result = await submit('play qzxv no such recording 918273');
  assert.equal(result.outcome, 'no-match');
  assert.equal(result.track, null);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(agentCalls, 0);
  assert.equal(bodies.length, 1);
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

test('unmet mood stays diagnostic when the requested artist is matched', async () => {
  modelOutput = { artist: 'Queen', mood: 'calm', search_terms: ['Queen'] };
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.artist, 'Queen');
  assert.doesNotMatch(result.ack, /alternative|verify the requested mood/);
  assert.equal(queue.upcoming.length, 1);
});

test('an artist mood description is not restored as a literal song title', async () => {
  catalogueSongs.push({ ...exact, id: 'calm', title: 'Calm Example', moods: ['calm'] });
  modelOutput = { artist: 'Queen', mood: 'calm', search_terms: ['Queen'] };
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, 'calm');
});

test('failed interpretation can preserve an artist and treat mood as a preference', async () => {
  modelError = true;
  const result = await submit('Play something calm by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.artist, 'Queen');
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

for (const text of ['Play some soul, avoid stadium rock', 'Play soul with no metal']) {
  test(`an omitted negative instruction cannot queue a track: ${text}`, async () => {
    modelOutput = { artist: 'Queen' };
    const result = await submit(text);
    assert.equal(result.outcome, 'unsupported');
    assert.equal(queue.upcoming.length, 0);
  });
}

test('an omitted bare-decade era cannot queue a track', async () => {
  modelOutput = { genre: 'rock' };
  const result = await submit('Play some rock from the 80s, for my brother');
  assert.equal(result.outcome, 'unsupported');
  assert.deepEqual(requestLog.snapshot(1)[0].unsupported, ['era']);
  assert.equal(queue.upcoming.length, 0);
});

for (const title of ['Anything But Love', 'Other Than This']) {
  test(`an exclusion-like title still reaches the queue: ${title}`, async () => {
    catalogueSongs = [{ ...exact, title }];
    modelOutput = { title, artist: 'Queen' };
    const result = await submit(`Play ${title} by Queen`);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0]?.track.title, title);
  });
}

test('model-detected unsupported conditions survive an otherwise empty plan', async () => {
  modelOutput = { unsupported: ['earlier conversation'] };
  const result = await submit('Play the one we discussed earlier');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});

test('a dedication the model files under unsupported still queues a track (#2133)', async () => {
  modelOutput = { kind: 'track', unsupported: ['dedication'], mood: 'reflective', search_terms: [], scope: 'song',
    intent: 'A song in memory of an aunt.', ack: 'Sending this one out with love.' };
  const result = await submit('Dedicate a song to my favorite Aunt that just passed away. Aunty Mary, I will miss you…');
  assert.equal(result.status, 'resolved');
  assert.notEqual(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 1);
  const logged = requestLog.snapshot(1)[0];
  assert.deepEqual(logged.unsupported, []);
  assert.deepEqual(logged.ignoredUnsupported, ['dedication']);
  assert.ok(queue.djLog.some(line => /unsupported label\(s\).*ignored: dedication/.test(line.message)));
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


for (const [title, artist, forms] of [
  ['A Horse with No Name', 'America', ['America - A Horse with No Name', 'America, A Horse with No Name', 'A Horse with No Name by America']],
  ['But Not for Me', 'Ella Fitzgerald', ['Ella Fitzgerald, But Not for Me']],
  ['Anything but Ordinary', 'Avril Lavigne', ['Avril Lavigne, Anything but Ordinary']],
  ['Anything But Love', 'Queen', ['Queen, Anything But Love']],
] as Array<[string, string, string[]]>) {
  for (const text of forms) test(`review: model names shield condition-like words: ${text}`, async () => {
    catalogueSongs = [{ ...exact, title, artist }];
    modelOutput = { title, artist };
    assert.equal((await submit(text)).outcome, 'matched');
    assert.equal(queue.upcoming[0].track.title, title);
  });
}

test('review: a year in a recognised artist name is not an era request', async () => {
  catalogueSongs = [{ ...exact, artist: 'The 1975', title: 'Somebody Else' }];
  modelOutput = { artist: 'The 1975', title: null };
  assert.equal((await submit('play something from The 1975')).outcome, 'matched');
});

test('review: conversational decades do not turn a chat answer into a refusal', async () => {
  modelOutput = { kind: 'chat', ack: 'I enjoyed the guitar bands.' };
  const result = await submit('what was your favourite band in the 1990s?');
  assert.equal(result.outcome, 'chat');
  assert.equal(result.ack, modelOutput.ack);
  assert.equal(queue.upcoming.length, 0);
});

for (const metadata of [{ genre: undefined }, { language: undefined }, { genre: undefined, language: undefined }]) {
  test(`review: the issue's guessed attributes cannot displace its named song: ${JSON.stringify(metadata)}`, async () => {
    catalogueSongs = [{ ...exact, ...metadata }, filler];
    modelOutput = { artist: 'Queen', search_terms: ['Bohemian Rhapsody', 'Queen'], genre: 'rock', mood: 'celebratory', language: 'English' };
    const result = await submit();
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
    assert.doesNotMatch(result.ack, /alternative|verify the requested mood/);
    assert.ok(requestLog.snapshot(1)[0].unmetPreferences.includes('mood'));
  });
}

test('review: condition words inside a named title do not make a guessed genre explicit', async () => {
  catalogueSongs = [{ ...exact, title: 'Jazz Song', genre: undefined }];
  modelOutput = { artist: 'Queen', title: 'Jazz Song', genre: 'Jazz' };
  assert.equal((await submit('Queen, Jazz Song')).outcome, 'matched');
});

test('review: explicit language still constrains fallback after interpreter failure', async () => {
  modelError = true;
  catalogueSongs = [{ ...exact, language: undefined }, filler];
  const result = await submit('Queen - Bohemian Rhapsody in French');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

for (const text of ['Queen', 'Queen - Bohemian Rhapsody', 'Jay-Z - Empire State of Mind']) {
  test(`review: literal identity at the token cap: ${text}`, async () => {
    await settings.update({ llm: { dailyTokenCap: 1000, exemptRequests: false } } as never);
    addDailyUsage(5000);
    if (text.startsWith('Jay-Z')) catalogueSongs = [{ ...exact, title: 'Empire State of Mind (feat. Alicia Keys)', artist: 'Jay-Z' }];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(bodies.length, 0);
    assert.equal(queue.upcoming.length, 1);
  });
}

test('review: dash-separated identity survives an interpreter outage', async () => {
  modelError = true;
  assert.equal((await submit('Queen - Bohemian Rhapsody')).outcome, 'matched');
});

for (const suffix of ['(feat. Alicia Keys)', '(featuring Alicia Keys)', '(ft. Alicia Keys)', '(Radio Edit)', '(Single Version)', '(Album Version)', '(Explicit)']) {
  test(`review: catalogue decoration ${suffix} does not replace the requested recording`, async () => {
    catalogueSongs = [{ ...exact, title: `Empire State of Mind ${suffix}`, artist: 'Jay-Z' }, filler];
    modelOutput = { title: 'Empire State of Mind', artist: 'Jay-Z' };
    const result = await submit('Jay-Z - Empire State of Mind');
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.title, `Empire State of Mind ${suffix}`);
  });
}

test('review: matched acknowledgements keep the screened persona-language answer', async () => {
  modelOutput = { ...modelOutput, ack: 'Je regarde cela pour vous.' };
  assert.equal((await submit()).ack, modelOutput.ack);
});

test('review: interpreter failure keeps a suitable fallback without claiming an exact match', async () => {
  modelError = true;
  searchEmpty = true;
  const result = await submit('surprise me');
  assert.equal(result.outcome, 'substituted');
  assert.equal(result.track.title, filler.title);
  assert.match(result.ack, /alternative/);
});

test('review: literal condition-like titles need catalogue proof before fallback can relax identity', async () => {
  modelError = true;
  assert.equal((await submit('Play soul with no metal by Queen')).outcome, 'unsupported');
  catalogueSongs = [{ ...exact, title: 'A Horse with No Name', artist: 'America' }];
  assert.equal((await submit('A Horse with No Name by America')).outcome, 'matched');
});

test('review: the shortcut keeps a soft two-hour preference independently of repeatCooldownMin', async () => {
  queue.current = { track: exact } as never;
  const other = { ...exact, id: 'other-queen', title: 'Killer Queen' };
  catalogueSongs = [exact, other];
  queue._recentPlays = [{ ...other, endedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }];
  await settings.update({ requests: { repeatCooldownMin: 240 } } as never);
  const result = await submit('more like this');
  assert.equal(result.track.title, other.title);
  assert.equal(result.outcome, 'matched');
});


test('review: alias search hits are tried before unrelated starred favourites', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const aliasTrack = { ...exact, artist: '2Pac', title: 'Changes' };
  catalogueSongs = [aliasTrack];
  modelOutput = { artist: 'Tupac', search_terms: ['Tupac'] };
  const result = await submit('play some Tupac');
  assert.equal(result.track.title, aliasTrack.title);
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'search');
});


test('review: a valid empty plan can still recover an unambiguous literal name pair', async () => {
  modelOutput = {};
  const result = await submit('Bohemian Rhapsody by Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(requestLog.snapshot(1)[0].interpretationFallback, false);
});


for (const [title, artist] of [['A Day in the Life', 'The Beatles'], ['Your Hand in Mine', 'Explosions in the Sky'], ['Back in Black', 'AC/DC']]) {
  test(`review: literal name recovery keeps in-phrases in ${title}`, async () => {
    catalogueSongs = [{ ...exact, title, artist }];
    modelError = true;
    const result = await submit(`${title} by ${artist}`);
    assert.equal(result.outcome, 'matched');
    assert.equal(result.track.title, title);
    assert.equal(result.track.artist, artist);
  });
}

test('review: an unknown literal language cannot silently fall back to another language', async () => {
  modelError = true;
  const result = await submit('Bohemian Rhapsody by Queen in Klingon');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});


test('review: shortcut intro failures also have their own diagnostic', async () => {
  queue.current = { track: exact } as never;
  await settings.update({ tts: { enabled: true } } as never);
  introError = true;
  const result = await submit('more like this');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].introScript, null);
  assert.equal(requestLog.snapshot(1)[0].introFailure, 'intro-failed');
  assert.equal(requestLog.snapshot(1)[0].guard, null);
  assert.ok(!queue.djLog.some((line: any) => /intro echoed request text/.test(line.message)));
});


for (const [text, language] of [
  ['Joue Bohemian Rhapsody de Queen en français', 'French'],
  ['Toca Bohemian Rhapsody de Queen en francés', 'French'],
  ['Play Bohemian Rhapsody by Queen in español', 'Spanish'],
]) {
  test(`translated language remains a hard requirement: ${text}`, async () => {
    catalogueSongs = [exact];
    modelOutput = { title: exact.title, artist: 'Queen', language };
    const result = await submit(text);
    assert.equal(result.outcome, 'no-match');
    assert.equal(queue.upcoming.length, 0);
  });
}

test('translated language selects the eligible recording rather than merely refusing', async () => {
  const french = { ...exact, id: 'french-recording', language: 'French' };
  catalogueSongs = [exact, french];
  modelOutput = { title: exact.title, artist: 'Queen', language: 'French' };
  const result = await submit('Joue Bohemian Rhapsody de Queen en français');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, french.id);
});

test('Punjabi request accepts ISO language metadata and Punjabi genre tags', async () => {
  const punjabi = { ...exact, id: 'punjabi-recording', title: 'Punjabi Song', artist: 'Punjabi Artist', genre: 'Punjabi Pop', language: 'pa' };
  catalogueSongs = [punjabi];
  modelOutput = { title: punjabi.title, artist: punjabi.artist, language: 'Punjabi' };
  const result = await submit(`play ${punjabi.title} by ${punjabi.artist} in Punjabi`);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, punjabi.id);
});

for (const [text, genre] of [['Play some hiphop', 'Hip Hop'], ['Play some hip hop', 'HipHop']]) {
  test(`canonical genre spelling cannot relax an explicit requirement: ${text}`, async () => {
    modelOutput = { genre, title: null, artist: null, search_terms: [] };
    const result = await submit(text);
    assert.equal(result.outcome, 'no-match');
    assert.equal(queue.upcoming.length, 0);
  });
}

for (const field of ['title', 'artist', 'album']) {
  test(`an unverified model ${field} cannot conceal an exclusion`, async () => {
    catalogueSongs = [exact];
    modelOutput = { [field]: 'anything except Queen', search_terms: [] };
    const result = await submit('Play anything except Queen');
    assert.equal(result.outcome, 'unsupported');
    assert.equal(queue.upcoming.length, 0);
    assert.deepEqual(requestLog.snapshot(1)[0].unsupported, ['exclusions']);
  });
}

test('an unverified model name cannot conceal a recording condition', async () => {
  catalogueSongs = [exact];
  modelOutput = { title: 'instrumental music', search_terms: [] };
  const result = await submit('Play instrumental music');
  assert.equal(result.outcome, 'unsupported');
  assert.equal(queue.upcoming.length, 0);
});

test('a genuine condition-like artist name is verified before it may hide condition words', async () => {
  catalogueSongs = [{ ...exact, artist: 'Everything but the Girl', title: 'Missing' }];
  modelOutput = { artist: 'Everything but the Girl', title: null };
  const result = await submit('Play something by Everything but the Girl');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.artist, 'Everything but the Girl');
});

// The reply quoted in #1961, verbatim: no title key, and a genre and mood the
// listener never asked for. The tolerant schema reads the missing title as null.
const issueReply = {
  kind: 'track', search_terms: ['Bohemian Rhapsody', 'Queen'], artist: 'Queen', genre: 'rock', language: null, sort: null,
  scope: 'song', mood: 'celebratory', intent: 'Wants the classic Queen anthem.',
  ack: 'The stage is set — here comes a bit of Freddie and Brian.',
};
const killerQueen = { id: 'killer-queen', title: 'Killer Queen', artist: 'Queen', album: 'Sheer Heart Attack', duration: 180, genre: 'Rock' };
const issuePhrasings = ['Queen, Bohemian Rhapsody', 'Bohemian Rhapsody by Queen', 'play Bohemian Rhapsody from Queen',
  'Queen Bohemian Rhapsody', 'Queen: Bohemian Rhapsody', 'play Bohemian Rhapsody'];

for (const text of issuePhrasings) {
  test(`#1961: the issue's own reply queues the named song: ${text}`, async () => {
    modelOutput = issueReply;
    artistSongs = [killerQueen];
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });

  test(`#1961: a named title-only miss never uses an unrelated alternative: ${text}`, async () => {
    modelOutput = issueReply;
    catalogueSongs = [filler];
    artistSongs = [killerQueen];
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'no-match');
    assert.equal(result.track, null);
    assert.equal(queue.upcoming.length, 0);
    assert.doesNotMatch(result.ack || '', /Freddie|stage is set|alternative/);
  });
}

test('#1961: a reply that names no artist still keeps a song the listener named', async () => {
  modelOutput = { ...issueReply, artist: null, search_terms: ['Bohemian Rhapsody'] };
  genreSongs = [filler];
  const result = await submit('play Bohemian Rhapsody');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

// Neither search term sits alone with request framing here, so neither is
// read as the title outright; each is searched as one before any pool.
for (const text of ['Queen, Bohemian Rhapsody', 'Bohemian Rhapsody by Queen', 'Queen - Bohemian Rhapsody']) {
  test(`#1961: a reply without its artist searches the named song before the genre pool: ${text}`, async () => {
    modelOutput = { ...issueReply, artist: null };
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });

  test(`#1961: a term with no title or artist beside it holds nothing, so the pool draw is labelled: ${text}`, async () => {
    modelOutput = { ...issueReply, artist: null };
    catalogueSongs = [filler];
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming.length, 1);
    assert.match(result.ack, /alternative/);
    assert.doesNotMatch(result.ack, /Freddie|stage is set/);
  });
}

for (const text of ['Play Bohemian Rhapsody by Queen, it is my birthday', 'Bohemian Rhapsody by Queen for my mum']) {
  test(`#1961: words after the named song do not turn it into an artist lottery: ${text}`, async () => {
    modelOutput = issueReply;
    artistSongs = [killerQueen];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });

  test(`#1961: an artist pool draw cannot replace a missing named song: ${text}`, async () => {
    modelOutput = issueReply;
    catalogueSongs = [filler];
    artistSongs = [killerQueen];
    const result = await submit(text);
    assert.equal(result.outcome, 'no-match');
    assert.equal(result.track, null);
    assert.equal(queue.upcoming.length, 0);
    assert.doesNotMatch(result.ack || '', /alternative|Killer Queen/);
  });
}

test('#1961: a vibe phrase left in search_terms is not read as a named song', async () => {
  modelOutput = { kind: 'track', title: null, artist: null, genre: 'rock', mood: null, search_terms: ['overcast evening'] };
  genreSongs = [filler];
  const result = await submit('some rock for an overcast evening');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, filler.id);
});

test('a model that respells a name with "The" cannot turn a word in it into a hard genre', async () => {
  const heyYou = { id: 'hey-you', title: 'Hey You', artist: 'The Rock Steady Crew', genre: 'Hip-Hop', duration: 240 };
  catalogueSongs = [filler, heyYou];
  modelOutput = { kind: 'track', title: 'Hey You', artist: 'The Rock Steady Crew', genre: 'rock', search_terms: ['Hey You'] };
  const result = await submit('Hey You by Rock Steady Crew');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, heyYou.id);
});

test('"I\'d like X by Y" offers Y\'s catalogue for a missing X, not a track like the one on air', async () => {
  queue.current = { track: { id: 'on-air', title: 'Dancing Queen', artist: 'ABBA' } } as never;
  catalogueSongs = [filler];
  artistSongs = [killerQueen];
  modelOutput = { kind: 'track', title: 'Missing Song', artist: 'Queen', search_terms: ['Missing Song'] };
  const result = await submit("I'd like Missing Song by Queen");
  assert.equal(result.outcome, 'substituted');
  assert.equal(result.track.title, killerQueen.title);
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'artist-alternative');
});

test('a request pointing at the on-air track still reaches the similarity rung', async () => {
  queue.current = { track: { id: 'on-air', title: 'Dancing Queen', artist: 'ABBA' } } as never;
  modelOutput = { kind: 'track', title: null, artist: null, search_terms: [] };
  const result = await submit('play something like this');
  assert.equal(result.outcome, 'matched');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'similar-to-current');
});

test('a credit found by searching the listener\'s own spelling is not called a different artist', async () => {
  // "Tupac" finds the library's 2Pac. The controller cannot prove they are one
  // act, so the track stays an alternative, but the intro is not told it is
  // by somebody else.
  const changes = { id: '2pac-changes', title: 'Changes', artist: '2Pac', album: 'Greatest Hits', duration: 269 };
  catalogueSongs = [changes];
  modelOutput = { kind: 'track', title: null, artist: 'Tupac', search_terms: ['Tupac'] };
  const result = await submit('play some Tupac');
  assert.equal(result.outcome, 'substituted');
  assert.equal(queue.upcoming[0].track.id, changes.id);
  assert.equal(requestLog.snapshot(1)[0].artistMiss, null);
});

test('an interpreter outage still finds a song written "Title - Artist"', async () => {
  modelError = true;
  const result = await submit('Bohemian Rhapsody - Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('a model reply that kept only the artist recovers a "Title - Artist" title', async () => {
  artistSongs = [killerQueen];
  modelOutput = { kind: 'track', title: null, artist: 'Queen', search_terms: ['Queen'] };
  const result = await submit('Bohemian Rhapsody - Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

// The reply omits title, so the literal reading supplies one, and that keeps
// whatever the listener said after the name.
for (const text of ['Queen, Bohemian Rhapsody for my mum', 'Bohemian Rhapsody for my mum - Queen', 'Queen - Bohemian Rhapsody please DJ']) {
  test(`a recovered literal title leaves out what follows the name: ${text}`, async () => {
    artistSongs = [killerQueen];
    modelOutput = { kind: 'track', artist: 'Queen', search_terms: ['Bohemian Rhapsody', 'Queen'], scope: 'song' };
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });
}


for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
  test(`a quoted title is recovered without trusting an unrelated search term: ${open}`, async () => {
    const wrong = { ...killerQueen, title: open === '‘' ? 'Play' : 'Killer Queen' };
    catalogueSongs = [exact, wrong];
    artistSongs = [wrong];
    modelOutput = { title: null, artist: 'Queen', genre: 'rock', mood: 'celebratory', search_terms: [wrong.title] };
    const result = await submit(`Play ${open}Bohemian Rhapsody${close}`);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });
}

test('a missing quoted title refuses substitution', async () => {
  catalogueSongs = [killerQueen];
  artistSongs = [killerQueen];
  modelOutput = { title: null, artist: 'Queen', genre: 'rock', search_terms: ['Killer Queen'] };
  const result = await submit('Play "Unavailable Example Recording"');
  assert.equal(result.outcome, 'no-match');
  assert.equal(result.track, null);
  assert.doesNotMatch(result.ack || '', /alternative/);
});

// Words after the closing quote are not part of the name. Reading everything
// after the opening quote as the title lost each of these songs.
const oneCrowdedHour = { id: 'one-crowded-hour', title: 'One Crowded Hour', artist: 'Augie March', album: 'Moo, You Bloody Choir', duration: 300 };
const coldAcre = { id: 'cold-acre', title: 'The Cold Acre', artist: 'Augie March', album: 'Moo, You Bloody Choir', duration: 240 };
for (const [text, song] of [
  ['Play "Bohemian Rhapsody" next', exact], ['Play "Bohemian Rhapsody" for my mum', exact], ['Play "Bohemian Rhapsody" again', exact],
  ['play "Bohemian Rhapsody" from Queen', exact], ['play "One Crowded Hour" from Augie March', oneCrowdedHour],
] as const) {
  for (const artist of [song.artist, null]) {
    test(`a quoted title followed by other words keeps the named song (artist ${artist ?? 'null'}): ${text}`, async () => {
      catalogueSongs = [filler, killerQueen, coldAcre, song];
      artistSongs = song === exact ? [killerQueen] : [coldAcre];
      modelOutput = { kind: 'track', title: null, artist, search_terms: [song.title], scope: 'song' };
      const result = await submit(text);
      assert.equal(result.outcome, 'matched');
      assert.equal(queue.upcoming[0].track.id, song.id);
    });
  }
}

test('a quoted title followed by a dedication still outranks an unrelated search term', async () => {
  catalogueSongs = [exact, killerQueen];
  artistSongs = [killerQueen];
  modelOutput = { title: null, artist: 'Queen', genre: 'rock', mood: 'celebratory', search_terms: ['Killer Queen'] };
  const result = await submit('Play "Bohemian Rhapsody" for my mum');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});


for (const [title, artist, text] of [
  ['Touched by the Hand of God', 'New Order', 'Play "Touched by the Hand of God" by New Order'],
  ['September', 'Earth, Wind & Fire', '"Earth, Wind & Fire", "September"'],
  ['One - Two', 'Fixture Band', '"One - Two" - "Fixture Band"'],
]) {
  test(`literal recovery ignores separators inside quoted names: ${text}`, async () => {
    modelError = true;
    catalogueSongs = [{ ...exact, title, artist }];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.title, title);
    assert.equal(queue.upcoming[0].track.artist, artist);
  });
}


test('a punctuation-only artist is an identity, not an unrestricted artist request', async t => {
  t.mock.method(Math, 'random', () => 0);
  const wanted = { ...exact, id: 'punctuation-artist', artist: '!!!', title: 'Normal People' };
  catalogueSongs = [filler, wanted];
  modelOutput = { artist: '!!!', title: null, search_terms: [] };
  const result = await submit('Play something by !!!');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, wanted.id);
});

test('distinct punctuation-only titles never match each other', async t => {
  t.mock.method(Math, 'random', () => 0);
  const wanted = { ...exact, id: 'question-title', artist: 'OutKast', title: '?' };
  catalogueSongs = [{ ...wanted, id: 'wrong-title', title: '!!!' }, wanted];
  modelOutput = { artist: 'OutKast', title: null, genre: 'rock', search_terms: ['!!!'] };
  const result = await submit('Play "?"');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, wanted.id);
});


// --- Agent first, direct as the fallback: no request develop serves is lost. ---

const searched = { toolCalls: [{ name: 'searchLibrary' }], steps: 1 };
const agentFoundNothing = () => ({ object: {}, ...searched, extras: { seen: new Map() } });
const agentPicked = (song: RequestSong) => ({ object: { id: song.id, ack: 'Here you go.' }, ...searched, extras: { seen: new Map([[song.id, song]]) } });

// The deadlines are tens of seconds, so these run on mocked clocks through the
// exported entry the POST handler calls. Real I/O still gets event-loop turns.
function listenerEntry(text: string): ListenerRequestEntry {
  return { id: `mock-time-${++ip}`, status: 'pending', requester: 'Listener', text, createdAt: Date.now() };
}
const eventLoopTurns = async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); };
async function advance(t: TestContext, ms: number, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    await eventLoopTurns();
    t.mock.timers.tick(Math.min(step, ms - done));
  }
  await eventLoopTurns();
}
// A stubbed delay starts a tick or two after the request does, so this steps
// until the request settles. Past the limit it fails rather than hangs.
async function advanceUntilSettled(t: TestContext, entry: { status: string }, limitMs: number) {
  for (let done = 0; done < limitMs && entry.status === 'pending'; done += 1000) {
    await eventLoopTurns();
    t.mock.timers.tick(1000);
  }
  // The last step may have released real I/O, which mock time cannot hurry.
  const started = performance.now();
  while (entry.status === 'pending' && performance.now() - started < 2000) await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(entry.status, 'pending', `still pending after ${limitMs} ms`);
}

// At default deadlines the interpreter gets the time left less the library's
// 25 s: 20 s once the agent has spent its 45 s.
test('an agent that fails at its deadline still leaves the interpreter 20 s and the library its 25 s', async t => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentDelayMs = 45_000;
  agentError = Object.assign(new Error('djAgentRequest exceeded 45000ms deadline'), { name: 'AgentDeadlineError' });
  modelDelayMs = 19_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('Bohemian Rhapsody by Queen');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 70_000);
  assert.equal((await settled).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(bodies.length, 1, 'the interpreter was given its time');
  agentError = null;
});

test('a raised Agent deadline is honoured: an answer at 70 s still queues', async t => {
  await settings.update({ llm: { requestMatching: 'agentic', agentTimeoutMs: 120_000 } } as never);
  agentDelayMs = 70_000;
  agentResult = agentPicked(exact);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('Bohemian Rhapsody by Queen');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 75_000);
  assert.equal((await settled).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('requestTimeoutMs bounds one generation and never shortens the request', async t => {
  await settings.update({ llm: { requestMatching: 'agentic', requestTimeoutMs: 5000 } } as never);
  agentDelayMs = 30_000;
  agentResult = agentPicked(exact);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('Bohemian Rhapsody by Queen');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 35_000);
  assert.equal((await settled).outcome, 'matched');
});

test('the interpreter is capped by the time left, so the literal parse runs instead of a timeout', async t => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentDelayMs = 45_000;
  agentResult = agentFoundNothing();
  modelStalls = true;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('surprise me');
  const settled = resolveListenerRequest(entry);
  // The agent's 45 s, then the interpreter's 20 s: still its turn at 60 s.
  await advance(t, 60_000);
  assert.equal(entry.status, 'pending', 'the interpreter still holds its share');
  await advanceUntilSettled(t, entry, 10_000);
  await settled;
  assert.equal(entry.outcome, 'substituted');
  assert.equal(entry.interpretationFallback, true);
});

test('the ceiling is the agent deadline plus a fallback reserve, and it still ends the request', async t => {
  assert.equal(requestResolutionTimeoutMs(), 90_000);
  await settings.update({ llm: { agentTimeoutMs: 120_000, requestTimeoutMs: 5000 } } as never);
  assert.equal(requestResolutionTimeoutMs(), 165_000, 'follows the agent deadline, not one generation');
  libraryStalls = true;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('Bohemian Rhapsody by Queen');
  void resolveListenerRequest(entry);
  await advance(t, 164_000, 4000);
  assert.equal(entry.status, 'pending');
  await advance(t, 2_000);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.outcome, 'timeout');
  assert.equal(queue.upcoming.length, 0);
});

for (const [text, song, fields] of [
  ['Smells Like Teen Spirit', { title: 'Smells Like Teen Spirit', artist: 'Nirvana' }, { title: 'Smells Like Teen Spirit', artist: 'Nirvana' }],
  ['Stairway To Heaven Led Zeppelin', { title: 'Stairway To Heaven', artist: 'Led Zeppelin' }, { title: 'Stairway To Heaven', artist: 'Led Zeppelin' }],
  ["Don't Stop Me Now", { title: "Don't Stop Me Now", artist: 'Queen' }, { title: "Don't Stop Me Now", artist: 'Queen' }],
  ['Queen Bohemian Rhapsody please', { title: 'Bohemian Rhapsody', artist: 'Queen' }, { title: 'Bohemian Rhapsody', artist: 'Queen' }],
] as Array<[string, { title: string; artist: string }, Record<string, unknown>]>) {
  test(`a null answer without an evidence run reaches the resolver: ${text}`, async () => {
    await settings.update({ llm: { requestMatching: 'agentic' } } as never);
    agentResult = agentFoundNothing();
    catalogueSongs = [filler, { ...exact, id: 'wanted', ...song }];
    modelOutput = { kind: 'track', search_terms: [song.title], scope: 'song', ...fields };
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, 'wanted');
    const logged = requestLog.snapshot(1)[0];
    assert.ok(!logged.stages.includes('web-evidence'), 'no web search could happen');
    assert.equal(logged.evidenceSource, null);
  });
}

for (const text of ['play something nice for my mum', 'i want to hear some good music']) {
  test(`a vibe with a null answer and no evidence run still gets a stand-in: ${text}`, async () => {
    await settings.update({ llm: { requestMatching: 'agentic' } } as never);
    agentResult = agentFoundNothing();
    catalogueSongs = [filler];
    modelOutput = { kind: 'track', title: null, search_terms: [], scope: 'song' };
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming.length, 1);
  });
}

for (const text of ['anything except Queen', 'instrumental tracks from the 1990s']) {
  test(`an omitted id with a real candidate is salvaged by the corrective call: ${text}`, async () => {
    await settings.update({ llm: { requestMatching: 'agentic' } } as never);
    const pick = { id: 'candidate', title: 'Fixture Outside Queen', artist: 'Fixture Artist', duration: 200 };
    agentResult = { object: { ack: 'Coming up.' }, ...searched, extras: { seen: new Map([[pick.id, pick]]) } };
    modelOutput = { kind: 'track', id: pick.id, ack: 'Here you go.', search_terms: [], scope: 'song' };
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, pick.id);
    assert.equal(bodies.length, 1, 'one corrective call, no fall-through');
    assert.equal(requestLog.snapshot(1)[0].path, 'agent');
  });
}

test('a null answer after a real evidence run stays a miss even with verified candidates', async () => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  const verified = { id: 'verified-song', title: 'The Requested Song', artist: 'Fixture Artist' };
  agentResult = {
    object: { kind: 'track', id: null, ack: 'Not sure that is the one.' },
    steps: 1,
    toolCalls: [{ name: 'identifyRequestedTrack', result: { candidates: [verified] } }],
    extras: { seen: new Map([[verified.id, verified]]) },
  };
  const result = await submit('phull koyi vilyat wala lai geya ghod da main reh geya keyariyan');
  assert.equal(result.outcome, 'no-match');
  assert.match(result.message, /identify that song/i);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(bodies.length, 0, 'a declined answer must not spend a re-pick');
});

const titleWords = ['Focus', 'Sunny', 'Love', 'Rain', 'Work', 'Morning', 'Rock', 'Party', 'Dance'];
for (const word of titleWords) {
  const track = { id: `title-${word}`, title: word, artist: 'Fixture Artist', duration: 200 };
  test(`a word that is also an attribute is a title when the interpreter reads one: ${word}`, async () => {
    catalogueSongs = [filler, track];
    genreSongs = [filler];
    modelOutput = { kind: 'track', title: word, artist: null, search_terms: [word], scope: 'song' };
    const result = await submit(`play ${word}`);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, track.id);
    assert.equal(bodies.length, 1);
  });

  test(`the same word is found when the agent comes back empty and the interpreter is down: ${word}`, async () => {
    await settings.update({ llm: { requestMatching: 'agentic' } } as never);
    agentResult = agentFoundNothing();
    modelError = true;
    catalogueSongs = [filler, track];
    genreSongs = [filler];
    const result = await submit(`play ${word}`);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, track.id);
  });
}

for (const condition of ['interpreter up', 'interpreter down']) {
  const read = () => {
    modelError = condition === 'interpreter down';
    modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
  };
  test(`a bare attribute word with no such title or artist keeps its attribute reading (${condition})`, async () => {
    catalogueSongs = [filler];
    genreSongs = [filler];
    read();
    const result = await submit('play Rock');
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, filler.id);
  });

  test(`a bare attribute word gets no fuzzy title reading (${condition})`, async () => {
    catalogueSongs = [filler, { id: 'rocks', title: 'Rocks', artist: 'Primal Scream', duration: 200 }];
    genreSongs = [filler];
    read();
    const result = await submit('play Rock');
    assert.equal(queue.upcoming[0].track.id, filler.id, JSON.stringify(result));
  });

  test(`framing words say an attribute was meant, so a same-named track does not win (${condition})`, async () => {
    catalogueSongs = [filler, { id: 'title-rock', title: 'Rock', artist: 'Fixture Artist', duration: 200 }];
    genreSongs = [filler];
    read();
    const result = await submit('play some rock');
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, filler.id);
  });

  test(`a quoted attribute word is a name, so a miss takes no pool (${condition})`, async () => {
    catalogueSongs = [filler];
    genreSongs = [filler];
    read();
    const result = await submit('play "Rock"');
    assert.equal(result.outcome, 'no-match');
    assert.equal(queue.upcoming.length, 0);
  });
}

test('a bare attribute word can be an artist, read or not', async () => {
  const band = { id: 'love-band', title: 'Alone Again Or', artist: 'Love', duration: 200 };
  for (const down of [false, true]) {
    queue.upcoming = [];
    catalogueSongs = [filler, band];
    modelError = down;
    modelOutput = { kind: 'track', title: null, artist: 'Love', search_terms: [], scope: 'song' };
    const result = await submit('play Love');
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, band.id);
  }
});

test('a named comparison with nothing on air still owns the miss on its stand-in', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  const result = await submit('something like Michael Jackson');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'fallback');
  assert.equal(requestLog.snapshot(1)[0].artistMiss, 'Michael Jackson');
});

const vertigo = { id: 'vertigo', title: 'Vertigo', artist: 'U2', genre: 'Rock', duration: 200 };
test('the interpreter reads "play U2 rock" as the act', async () => {
  catalogueSongs = [filler, vertigo];
  genreSongs = [filler];
  modelOutput = { kind: 'track', title: null, artist: 'U2', genre: 'Rock', search_terms: [], scope: 'song' };
  const result = await submit('play U2 rock');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, vertigo.id);
  assert.equal(bodies.length, 1);
});

test('"play U2 rock" with the interpreter down takes a labelled alternative, never a match', async () => {
  catalogueSongs = [filler];
  genreSongs = [filler];
  modelError = true;
  const result = await submit('play U2 rock');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
  assert.equal(queue.upcoming.length, 1);
});

for (const failure of ['interpreter down', 'token cap']) {
  for (const text of ['something chill for the evening', 'play me some rock']) {
    test(`a vibe phrase is not held to an exact title (${failure}): ${text}`, async () => {
      catalogueSongs = [filler];
      searchEmpty = true;
      if (failure === 'interpreter down') modelError = true;
      else {
        await settings.update({ llm: { dailyTokenCap: 1000, exemptRequests: false } } as never);
        addDailyUsage(5000);
      }
      const result = await submit(text);
      assert.equal(result.outcome, 'substituted');
      assert.equal(queue.upcoming.length, 1);
      assert.match(result.ack, /alternative/);
    });
  }
}

// Three ways a station reaches the fallback with less than a healthy model.
async function fallbackWithNoModel(failure: string) {
  if (failure === 'agent failed') {
    await settings.update({ llm: { requestMatching: 'agentic' } } as never);
    agentError = Error('synthetic agent failure');
    modelError = true;
  } else if (failure === 'token cap') {
    await settings.update({ llm: { dailyTokenCap: 1000, exemptRequests: false } } as never);
    addDailyUsage(5000);
  } else modelError = true;
}
const NO_MODEL = ['interpreter down', 'agent failed', 'token cap'];

for (const [title, artist] of [['Love Song', 'Sara Bareilles'], ['Work Song', 'Hozier'], ['Sad Songs', 'Elton John'], ['Party Music', 'The Coup'], ['Rock Music', 'Pixies'], ['Dance Music', 'The Mountain Goats']]) {
  const track = { id: `title-${title}`, title, artist, duration: 200 };
  for (const condition of ['interpreter up', ...NO_MODEL]) {
    test(`a trailing "song" or "music" leaves the title (${condition}): ${title}`, async () => {
      catalogueSongs = [filler, track];
      genreSongs = [filler];
      modelOutput = { kind: 'track', title, artist: null, search_terms: [title], scope: 'song' };
      if (condition !== 'interpreter up') await fallbackWithNoModel(condition);
      const result = await submit(`play ${title}`);
      assert.equal(result.outcome, 'matched');
      assert.equal(queue.upcoming[0].track.id, track.id);
    });
  }
}

test('a trailing "music" with no such title is still the genre', async () => {
  catalogueSongs = [filler];
  genreSongs = [filler];
  modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
  const result = await submit('play rock music');
  assert.equal(result.outcome, 'matched');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Rock');
});

test('a track named with the opening frame is found, and the frame alone finds nothing', async () => {
  const someLove = { id: 'some-love', title: 'Some Love', artist: 'Fixture Artist', duration: 200 };
  catalogueSongs = [filler, someLove];
  genreSongs = [filler];
  modelError = true;
  assert.equal((await submit('play Some Love')).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, someLove.id);
});

for (const failure of ['the agent answered nothing', 'the agent failed']) {
  for (const [text, reading, outcome] of [
    ['play funk', { genre: 'Funk' }, 'matched'],
    ['रॉक', { genre: 'Rock' }, 'matched'],
    ['play mellow', { mood: 'calm' }, 'substituted'],
    ['play happy', { mood: 'celebratory' }, 'substituted'],
    ['play oldies', {}, 'substituted'],
    ['play hits', {}, 'substituted'],
    ['play instrumental', {}, 'substituted'],
    ['play christmas', { mood: 'festival' }, 'substituted'],
    ['प्यार', { mood: 'romantic' }, 'substituted'],
  ] as const) {
    test(`one word goes to the interpreter (${failure}): ${text}`, async () => {
      await settings.update({ llm: { requestMatching: 'agentic' } } as never);
      if (failure === 'the agent failed') agentError = Error('synthetic agent failure');
      else agentResult = agentFoundNothing();
      catalogueSongs = [filler];
      searchEmpty = true;
      genreSongs = [filler];
      modelOutput = { kind: 'track', title: null, search_terms: [], scope: 'song', ...reading };
      const result = await submit(text);
      assert.equal(result.outcome, outcome);
      assert.equal(queue.upcoming.length, 1);
      assert.equal(bodies.length, 1, 'the interpreter read it');
    });
  }
}

test('Direct reads one word too, and the agent stays out of it', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [filler];
  modelOutput = { kind: 'track', title: null, genre: 'Funk', search_terms: [], scope: 'song' };
  const result = await submit('play funk');
  assert.equal(result.outcome, 'matched');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Funk');
  assert.equal(bodies.length, 1);
});

for (const text of ['R&B', 'play R&B', 'R&B please']) {
  test(`"&" reaches the genre alias: ${text}`, async () => {
    catalogueSongs = [filler];
    searchEmpty = true;
    genreSongs = [filler];
    modelError = true;
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:R&B');
  });
}

for (const failure of NO_MODEL) {
  test(`a genre the library lacks is no refusal when no model confirmed it (${failure})`, async () => {
    catalogueSongs = [filler];
    searchEmpty = true;
    genreSongs = [];
    await fallbackWithNoModel(failure);
    const result = await submit('play metal');
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming.length, 1);
    assert.match(result.ack, /alternative/);
  });
}

test('a genre the library lacks stays a miss when the interpreter confirms it', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [];
  modelOutput = { kind: 'track', title: null, genre: 'Metal', search_terms: [], scope: 'song' };
  const result = await submit('play metal');
  assert.equal(result.outcome, 'no-match');
  assert.equal(bodies.length, 1);
});

test('an interpreter that reads no genre takes the request off the literal one', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [];
  modelOutput = { kind: 'track', title: null, search_terms: [], scope: 'song' };
  const result = await submit('play metal');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
});

test('a language the library lacks stays a miss with no model', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [];
  modelError = true;
  assert.equal((await submit('हिंदी गाने')).outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('a one-word chat still reaches the interpreter', async () => {
  searchEmpty = true;
  modelOutput = { kind: 'chat', ack: 'Cheers, friend!', search_terms: [], scope: 'song' };
  const result = await submit('lol');
  assert.equal(result.ack, 'Cheers, friend!');
  assert.equal(queue.upcoming.length, 0);
});

const vibes = [
  'can you play something chill for the evening', 'could you play me some rock', 'i want something chill for the evening', 'give me something chill',
  'got anything upbeat', 'any chill songs for tonight', "i'd love some jazz tonight",
  'something chill for the evening', 'play me some rock', 'put on something mellow for me please', 'hey dj something chill', 'something upbeat for the drive home',
  'please play something relaxing for my mum', 'some chill tunes for the evening',
  'रोमांटिक गाने', 'рок музыка', 'música rock', 'something from the movie Titanic',
  // Nothing marks these as vibes, which is why the default has to be the alternative.
  'lazy sunday', 'sunday brunch', 'late night jazz', 'top 40', 'funk', 'daaku',
];
for (const failure of NO_MODEL) {
  for (const text of vibes) {
    test(`with no model a miss keeps its honest alternative (${failure}): ${text}`, async () => {
      catalogueSongs = [filler];
      searchEmpty = true;
      await fallbackWithNoModel(failure);
      const result = await submit(text);
      assert.equal(result.outcome, 'substituted');
      assert.equal(queue.upcoming.length, 1);
      assert.match(result.ack, /alternative/);
    });
  }

  for (const text of ['play U2 rock', 'play 2Pac rap', 'तेरे बिना love', 'something by Nobody Special', 'Imaginary Title by Nobody', 'Nobody, Imaginary Title', 'Nobody - Imaginary Title', 'something by the fire']) {
    test(`with no model the literal parse is no reason to refuse (${failure}): ${text}`, async () => {
      catalogueSongs = [filler];
      searchEmpty = true;
      genreSongs = [filler];
      await fallbackWithNoModel(failure);
      const result = await submit(text);
      assert.equal(result.outcome, 'substituted');
      assert.equal(queue.upcoming.length, 1);
      assert.match(result.ack, /alternative/);
    });
  }

  for (const text of ['play "Nonexistent Song"', 'play "Rock"', '"lazy sunday"', 'play qzxv no such recording']) {
    test(`with no model only a quote or the no-such-recording cue holds (${failure}): ${text}`, async () => {
      catalogueSongs = [filler];
      searchEmpty = true;
      genreSongs = [filler];
      await fallbackWithNoModel(failure);
      const result = await submit(text);
      assert.equal(result.outcome, 'no-match');
      assert.equal(queue.upcoming.length, 0);
    });
  }
}

test('a reading with no name takes the request off its literal wording', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [filler];
  modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
  for (const text of ['late night rock', 'play lazy sunday brunch classics', 'play good songs for my mum']) {
    queue.upcoming = [];
    const result = await submit(text);
    assert.equal(result.outcome, 'matched', text);
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Rock', text);
  }
});

test('a title the interpreter reads for a generic "from" wording is used', async () => {
  const result = await submit('the song from the new Dune movie');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('"from" names no artist the library must hold, whatever a model reads', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  for (const [text, reading] of [
    ['something from the movie Titanic', { title: null, search_terms: ['Titanic'] }],
    ['something from Queen', { title: null, artist: 'Queen', search_terms: [] }],
    ['music from Iceland', { title: null, search_terms: [] }],
  ] as const) {
    queue.upcoming = [];
    modelOutput = { kind: 'track', scope: 'song', ...reading };
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted', text);
    assert.match(result.ack, /alternative/, text);
  }
});

test('an act the interpreter reads, with no such act, is a miss', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = { kind: 'track', title: null, artist: 'Nobody Special', search_terms: [], scope: 'song' };
  assert.equal((await submit('play Nobody Special')).outcome, 'no-match');
});

test('music from a film is a kind of music, a song from one is an identification', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = { kind: 'track', title: null, search_terms: [], scope: 'song' };
  assert.equal((await submit('music from the movie Titanic')).outcome, 'substituted');
  assert.equal((await submit('a song from the movie Titanic')).outcome, 'unsupported');
});

test('a generic ask gets no fuzzy reading of a title made of the same word', async () => {
  const something = { id: 'something', title: 'Something', artist: 'The Beatles', duration: 200 };
  catalogueSongs = [filler, something];
  modelError = true;
  const result = await submit('play me something');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
});

test('a word asking for a kind of music keeps the alternative whatever title a model reads', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = { kind: 'track', title: 'Anything Upbeat', artist: null, search_terms: ['Anything Upbeat'], scope: 'song' };
  const result = await submit('got anything upbeat');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
});

test('a title the interpreter reads, with no such track, is a miss', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = { kind: 'track', title: 'Imaginary Title Here', artist: null, search_terms: ['Imaginary Title Here'], scope: 'song' };
  const result = await submit('Imaginary Title Here');
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('a stand-in for the seed is no seed: its neighbours are not a match', async () => {
  const george = { id: 'george', title: 'Faith', artist: 'George Michael', genre: 'Pop', duration: 200 };
  catalogueSongs = [filler, george];
  const result = await submit('something like Michael Jackson');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
  assert.notEqual(requestLog.snapshot(1)[0].pickSource, 'similar-to-seed');
});

const rockTrack = { id: 'title-rock', title: 'Rock', artist: 'Fixture Artist', duration: 200 };
const refusals: Array<[string, string, () => void]> = [
  ['cooldown', 'cooldown', () => { queue._recentPlays = [{ ...rockTrack, endedAt: new Date().toISOString() }] as never; }],
  ['in the queue', 'already-queued', () => { queue.upcoming = [{ track: rockTrack, requestedBy: 'Someone' }] as never; }],
];
for (const [state, refused, setUp] of refusals) {
  test(`a bare word whose title is refused takes the attribute the interpreter reads (${state})`, async () => {
    catalogueSongs = [filler, rockTrack];
    genreSongs = [filler];
    setUp();
    modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
    const result = await submit('play Rock');
    assert.equal(result.outcome, 'matched');
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Rock');
    assert.ok(queue.upcoming.some(item => item.track.id === filler.id));
  });

  test(`a bare word the interpreter reads as the title keeps its refusal (${state})`, async () => {
    catalogueSongs = [filler, rockTrack];
    genreSongs = [filler];
    setUp();
    modelOutput = { kind: 'track', title: 'Rock', artist: null, search_terms: ['Rock'], scope: 'song' };
    assert.equal((await submit('play Rock')).outcome, refused);
  });

  test(`a bare word with its title refused and no interpreter keeps the refusal (${state})`, async () => {
    catalogueSongs = [filler, rockTrack];
    genreSongs = [filler];
    setUp();
    modelError = true;
    assert.equal((await submit('play Rock')).outcome, refused);
  });

  test(`a quoted title keeps its refusal whatever a model reads (${state})`, async () => {
    catalogueSongs = [filler, rockTrack];
    genreSongs = [filler];
    setUp();
    modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
    assert.equal((await submit('play "Rock"')).outcome, refused);
  });
}

test('a vibe gets the whole interpreter budget, as a slow model needs', async t => {
  genreSongs = [filler];
  catalogueSongs = [filler];
  searchEmpty = true;
  modelDelayMs = 35_000;
  modelOutput = { kind: 'track', title: null, genre: 'Rock', search_terms: [], scope: 'song' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('something chill for the evening');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 40_000);
  await settled;
  assert.equal(entry.outcome, 'matched');
  assert.notEqual(entry.interpretationFallback, true);
});

test('one word gets the whole interpreter budget too', async t => {
  genreSongs = [filler];
  catalogueSongs = [filler];
  searchEmpty = true;
  modelDelayMs = 35_000;
  modelOutput = { kind: 'track', title: null, genre: 'Funk', search_terms: [], scope: 'song' };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const entry = listenerEntry('play funk');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 40_000);
  await settled;
  assert.equal(entry.outcome, 'matched');
  assert.notEqual(entry.interpretationFallback, true);
});

for (const text of ['Bohemian Rhapsody', 'Queen Bohemian Rhapsody', 'Bohemian Rhapsody by Queen', 'lazy sunday']) {
  test(`no wording shortens the interpreter's budget: ${text}`, async t => {
    catalogueSongs = [filler, exact];
    modelDelayMs = 35_000;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const entry = listenerEntry(text);
    const settled = resolveListenerRequest(entry);
    await advanceUntilSettled(t, entry, 40_000);
    await settled;
    assert.notEqual(entry.interpretationFallback, true);
    assert.equal(entry.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });
}

test('a stalled re-pick leaves a slow library its reserve at default deadlines', async t => {
  await settings.update({ llm: { requestMatching: 'agentic' } } as never);
  agentDelayMs = 44_000;
  agentResult = { object: { ack: 'x' }, ...searched, extras: { seen: new Map([[filler.id, filler]]) } };
  modelStalls = true;
  libraryDelayMs = 3000;
  // Earlier tests leave the request breaker open, which would skip the agent
  // and the re-pick this is about. An hour on, its cooldown has passed.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 3_600_000 });
  const entry = listenerEntry('Bohemian Rhapsody by Queen');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 91_000);
  await settled;
  assert.equal(agentCalls, 1);
  assert.ok(bodies.length > 0, 'the re-pick reached the model');
  assert.equal(entry.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

// The interpreter reads first, as it does on develop. Nothing the literal parse
// or the catalogue finds outranks its reading, and a track called what the
// listener typed is no answer to a word that meant something else.
const read = (reading: Record<string, unknown>) => ({ kind: 'track', title: null, artist: null, search_terms: [], scope: 'song', ...reading });
const titled = (title: string, artist = 'Fixture Artist') => ({ id: `titled-${title}`, title, artist, genre: 'Pop', duration: 200 });

test('"play Queen" is the act the interpreter reads, not a track called Queen', async () => {
  catalogueSongs = [titled('Queen', 'Perfume Genius'), exact];
  artistSongs = [exact];
  modelOutput = read({ artist: 'Queen' });
  const result = await submit('play Queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(bodies.length, 1);
});

for (const [text, title] of [['play rock', 'Rock'], ['rock please', 'Rock'], ['rock!', 'Rock'], ['play rock music', 'Rock Music']]) {
  test(`a track called what the listener typed does not outrank the genre read: ${text}`, async () => {
    catalogueSongs = [filler, titled(title)];
    genreSongs = [filler];
    modelOutput = read({ genre: 'Rock' });
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Rock');
    assert.equal(bodies.length, 1);
  });
}

for (const text of ['like that', 'like this', 'something like that']) {
  test(`a comparison is read, whatever the library calls a track: ${text}`, async () => {
    queue.current = { track: exact } as never;
    catalogueSongs = [filler, titled('Like That'), titled('Like This'), titled('Something Like That')];
    modelOutput = read({});
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'similar-to-current');
    assert.equal(bodies.length, 1);
  });
}

test('a comparison whose wording is a refused title is still read', async () => {
  const title = titled('Something Like That');
  catalogueSongs = [filler, title];
  queue._recentPlays = [{ ...title, endedAt: new Date().toISOString() }] as never;
  modelOutput = read({});
  assert.equal((await submit('something like that')).outcome, 'substituted');
  assert.equal(bodies.length, 1);
  modelError = true;
  assert.equal((await submit('something like that')).outcome, 'cooldown', 'with no interpreter the refusal stands');
});

for (const word of ['help', 'sorry', 'why', 'wow', 'stop', 'more', 'next', 'again']) {
  test(`"${word}" is chat when the interpreter reads chat, whatever the library holds`, async () => {
    catalogueSongs = [filler, titled(word[0].toUpperCase() + word.slice(1))];
    modelOutput = { kind: 'chat', ack: 'Cheers, friend!', search_terms: [], scope: 'song' };
    const result = await submit(word);
    assert.equal(result.outcome, 'chat');
    assert.equal(queue.upcoming.length, 0);
  });
}

test('an explicit language is read, and the genre naming it is a match', async () => {
  const punjabi = { id: 'punjabi', title: 'Punjabi Fixture', artist: 'Fixture Artist', genre: 'Punjabi Pop', duration: 200 };
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [punjabi];
  modelOutput = read({ language: 'Punjabi' });
  const result = await submit('play something in Punjabi');
  assert.equal(bodies.length, 1);
  assert.equal(result.outcome, 'matched');
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'language-genre:Punjabi Pop');
});

// A comma, dash or "by" is a parse for the catalogue to try, never an identity
// claim that outranks the reading.
for (const [text, reading] of [
  ['hey dj, play some rock', { genre: 'Rock' }],
  ['rock, please', { genre: 'Rock' }],
  ['thanks for the show, play rock', { genre: 'Rock' }],
  ['rock, pop', { genre: 'Rock' }],
  ['chill - rock', { genre: 'Rock' }],
] as const) {
  test(`an answer that reads no name takes the request off the literal pair: ${text}`, async () => {
    catalogueSongs = [filler];
    searchEmpty = true;
    genreSongs = [filler];
    modelOutput = read(reading);
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'genre:Rock');
  });
}

for (const text of ['something chill by the fire', 'something romantic by candlelight', 'songs by candlelight']) {
  test(`"by" in a vibe asks the interpreter and is held to nobody: ${text}`, async () => {
    catalogueSongs = [filler];
    searchEmpty = true;
    modelOutput = read({ mood: 'calm' });
    const result = await submit(text);
    assert.equal(bodies.length, 1);
    assert.notEqual(result.outcome, 'no-match');
    assert.equal(queue.upcoming.length, 1);
  });
}

for (const text of [
  'Bohemian Rhapsody, please', 'Bohemian Rhapsody, thanks', 'hey dj, Bohemian Rhapsody by Queen', 'good evening, Queen - Bohemian Rhapsody',
  'for my mum, play Bohemian Rhapsody by Queen', 'Bohemian Rapsody by Quen',
]) {
  test(`a title the interpreter read outranks a parse it disagrees with: ${text}`, async () => {
    modelOutput = read({ title: exact.title, artist: 'Queen' });
    const result = await submit(text);
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });
}

test('the wording ahead of a reading takes no alternative, so the reading gets its turn', async () => {
  artistSongs = [killerQueen];
  modelOutput = read({ title: exact.title, artist: 'Queen' });
  const result = await submit('please play that bohemian rhapsody song by queen');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('a reading behind "from" gets its turn too, without the parse\'s context', async () => {
  const creep = { id: 'creep', title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', duration: 200 };
  catalogueSongs = [filler, creep];
  modelOutput = read({ title: 'Creep', artist: 'Radiohead' });
  const result = await submit('hi, Creep from Radiohead');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, creep.id);
});

test('a track the listener\'s own words prove outranks a reading that rewrites them', async () => {
  const other = { id: 'other', title: 'We Will Rock You', artist: 'Queen', duration: 200 };
  catalogueSongs = [other, exact];
  modelOutput = read({ title: other.title, artist: 'Queen' });
  assert.equal((await submit('Bohemian Rhapsody by Queen')).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('"Stand by Me" is the title the interpreter reads, not "Stand" by "Me"', async () => {
  const stand = { id: 'stand', title: 'Stand by Me', artist: 'Ben E. King', duration: 200 };
  catalogueSongs = [filler, stand];
  modelOutput = read({ title: stand.title, artist: stand.artist });
  assert.equal((await submit('Stand by Me')).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, stand.id);
});

test('a comma with a title-only reading is not given the other side as a credit', async () => {
  modelOutput = read({ title: exact.title });
  for (const text of ['Bohemian Rhapsody, thanks', 'hey dj, Bohemian Rhapsody']) {
    queue.upcoming = [];
    assert.equal((await submit(text)).outcome, 'matched', text);
    assert.equal(queue.upcoming[0].track.id, exact.id, text);
  }
});

test('"by" keeps its credit behind a title-only reading, so a match is never claimed on another act', async () => {
  modelOutput = read({ title: exact.title });
  assert.equal((await submit('Bohemian Rhapsody by Elvis')).outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('an album the interpreter reads is not turned into a title by "by"', async () => {
  modelOutput = read({ album: exact.album, artist: 'Queen', scope: 'album' });
  assert.equal((await submit(`${exact.album} by Queen`)).outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

for (const text of ['a rock song by Queen', 'the latest by Queen', 'Missing Song by Queen']) {
  test(`a title only the parse supplied holds nobody to it, with the act in the library: ${text}`, async () => {
    catalogueSongs = [filler, exact];
    artistSongs = [exact];
    modelOutput = read({ artist: 'Queen' });
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming[0].track.id, exact.id);
  });
}

test('a quoted act is still found with no interpreter', async () => {
  catalogueSongs = [filler];
  artistSongs = [exact];
  modelError = true;
  const result = await submit('play "Queen"');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, exact.id);
});

test('the seed of a comparison holds nobody to it, whatever the model read', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = read({ title: 'Imaginary Band' });
  const result = await submit('something like Imaginary Band');
  assert.equal(result.outcome, 'substituted');
  assert.equal(queue.upcoming.length, 1);
});

test('a seed the parse read as an attribute is no seed, so a track of that name proves nothing', async () => {
  catalogueSongs = [filler, titled('Rock')];
  modelError = true;
  const result = await submit('something like rock');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
});

for (const [text, title] of [['play Love Song', 'Love Song'], ['play Rock Music', 'Rock Music'], ['rock', 'Rock']]) {
  test(`an empty plan takes no attribute from the parse, so no pool claims a match: ${text}`, async () => {
    catalogueSongs = [filler, titled(title)];
    genreSongs = [filler];
    modelOutput = read({});
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.match(result.ack, /alternative/);
  });
}

test('a pair the interpreter left empty keeps the alternative', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = read({});
  assert.equal((await submit('Imaginary Title by Nobody')).outcome, 'substituted');
  assert.equal(queue.upcoming.length, 1);
});

for (const [text, term] of [['lazy sunday', 'lazy sunday'], ['road trip', 'road trip'], ['deep cuts', 'deep cuts']]) {
  test(`a vibe echoed in search_terms beside an attribute is no name: ${text}`, async () => {
    catalogueSongs = [filler];
    searchEmpty = true;
    modelOutput = read({ mood: 'calm', search_terms: [term] });
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming.length, 1);
  });
}

test('a hard condition the act cannot meet keeps its alternative inside that condition', async () => {
  const funky = { id: 'funky', title: 'Funky Fixture', artist: 'Fixture Artist', genre: 'Funk', duration: 200 };
  catalogueSongs = [exact, funky];
  artistSongs = [exact];
  modelOutput = read({ artist: 'Queen', genre: 'Funk' });
  const result = await submit('Queen funk');
  assert.equal(result.outcome, 'substituted');
  assert.equal(queue.upcoming[0].track.id, funky.id);
});

test('"rock in Punjabi" with no model stays a miss rather than dropping the genre', async () => {
  const punjabi = { id: 'punjabi', title: 'Punjabi Fixture', artist: 'Fixture Artist', genre: 'Punjabi Pop', duration: 200 };
  catalogueSongs = [filler, punjabi];
  genreSongs = [filler];
  modelError = true;
  assert.equal((await submit('rock in Punjabi')).outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
});

test('a lookup that failed on the exact step stays on the record when the parse then answers', async () => {
  librarySearchFails = true;
  genreSongs = [filler];
  modelError = true;
  const result = await submit('play Rock');
  assert.equal(result.outcome, 'matched');
  assert.match(String(requestLog.snapshot(1)[0].lookupErrors), /synthetic search failure/);
});

test('the request deadline reaches the library step that runs with no interpreter', async t => {
  modelError = true;
  libraryStalls = true;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 7_200_000 });
  const entry = listenerEntry('play Rock');
  const settled = resolveListenerRequest(entry);
  await advanceUntilSettled(t, entry, 91_000);
  await settled;
  assert.equal(entry.outcome, 'timeout');
  assert.ok(librarySignals.length > 0);
  assert.equal(librarySignals.at(-1)?.aborted, true);
});

// A bare string that misses as a title is tried as an exact artist before any
// near title, with or without a reading, so a one-word act never lands on
// another act's track one letter away. A reading whose title is its own artist
// asks for the act the same way.
const queens = { id: 'queens', title: 'Queens', artist: 'Mr Little Jeans', genre: 'Indie', duration: 200 };
for (const [condition, reading] of [
  ['interpreter down', null],
  ['a reading of search terms alone', read({ search_terms: ['Queen'] })],
  ['the act read as a title', read({ title: 'Queen', search_terms: ['Queen'] })],
  ['the act read as title and artist', read({ title: 'Queen', artist: 'Queen', search_terms: ['Queen'] })],
] as const) {
  test(`"play Queen" is the act, never another act's "Queens" (${condition})`, async () => {
    catalogueSongs = [queens, filler];
    artistSongs = [exact];
    if (reading) modelOutput = reading;
    else modelError = true;
    const result = await submit('play Queen');
    assert.equal(result.outcome, 'matched');
    assert.equal(queue.upcoming[0].track.id, exact.id);
    assert.equal(requestLog.snapshot(1)[0].pickSource, 'artist-albums');
  });
}

test('"play Kiss" is still the title when the library holds it', async () => {
  catalogueSongs = [titled('Kiss', 'Prince'), filler];
  artistSongs = [exact];
  modelError = true;
  const result = await submit('play Kiss');
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.title, 'Kiss');
});

// A title equal only after fuzzy scoring may still be queued, but one edit is a
// typo or another song ("Angel" and "Angels"), so it is labelled an alternative.
for (const condition of ['the title read', 'interpreter down']) {
  for (const [text, title, near] of [['play Angel', 'Angel', 'Angels'], ['play Kesaria', 'Kesaria', 'Kesariya']]) {
    test(`a near title is an alternative, never a match (${condition}): ${text}`, async () => {
      catalogueSongs = [titled(near), filler];
      if (condition === 'the title read') modelOutput = read({ title, search_terms: [title] });
      else modelError = true;
      const result = await submit(text);
      assert.equal(result.outcome, 'substituted');
      assert.match(result.ack, /alternative/);
      assert.equal(queue.upcoming[0].track.title, near);
      assert.match(requestLog.snapshot(1)[0].pickSource, /fuzzy$/);
    });
  }
}

// The exact-artist step takes only the act the words name, inside the
// request's hard conditions, and reuses the title's search hits.
test('"play Queens" is never a match on Queen when the artist search answers Queen', async () => {
  catalogueSongs = [filler];
  artistSongs = [exact];
  modelError = true;
  const result = await submit('play Queens');
  assert.notEqual(result.outcome, 'matched');
  assert.notEqual(queue.upcoming.at(-1)?.track?.id, exact.id);
});

test('the act read as a title still meets the request\'s hard language', async () => {
  catalogueSongs = [filler];
  artistSongs = [exact];
  modelOutput = read({ title: 'Queen', language: 'Punjabi', search_terms: ['Queen'] });
  const result = await submit('play Queen in Punjabi');
  assert.notEqual(result.outcome, 'matched');
  assert.equal(queue.upcoming.length, 0);
});

test('a bare string tried as an artist doesn\'t search the same words twice', async () => {
  catalogueSongs = [filler];
  modelError = true;
  await submit('play Imaginary Song');
  assert.equal(songSearches.filter(query => query === 'Imaginary Song').length, 1, songSearches.join(' | '));
});

// A near title is no identity, so one the station can't play right now is
// refused by nobody's name: develop's stand-in answers instead.
for (const state of ['on cooldown', 'already queued']) {
  test(`a near title ${state} is no refusal: play Angel`, async () => {
    const angels = titled('Angels', 'Robbie Williams');
    catalogueSongs = [angels, filler];
    modelError = true;
    if (state === 'on cooldown') queue._recentPlays = [{ ...angels, endedAt: new Date().toISOString() }];
    else queue.upcoming = [{ track: angels, requestedBy: 'Someone' }] as never;
    const result = await submit('play Angel');
    assert.equal(result.outcome, 'substituted');
    assert.notEqual(queue.upcoming.at(-1)?.track?.id, angels.id);
  });
}

// A title the same as the reading's own genre or mood is that attribute echoed,
// so it holds nothing: the request keeps develop's alternative.
for (const [text, reading] of [
  ['play rock', read({ title: 'Rock', genre: 'Rock', search_terms: ['Rock'] })],
  ['play chill', read({ title: 'Chill', mood: 'chill', search_terms: ['Chill'] })],
] as const) {
  test(`a title that is the reading's own attribute is no name: ${text}`, async () => {
    catalogueSongs = [filler];
    genreSongs = [filler];
    modelOutput = reading;
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming.length, 1);
  });
}

// pinExplicitRequestMatch only runs behind a reading that named something.
test('a chat reading of a comma pair stays chat, with nothing queued', async () => {
  catalogueSongs = [exact, filler];
  modelOutput = { kind: 'chat', ack: 'A classic, that one.' };
  const result = await submit('Queen, Bohemian Rhapsody');
  assert.equal(result.outcome, 'chat');
  assert.equal(queue.upcoming.length, 0);
});

// A reading carries a comparison only when the words start "something like" or
// "anything like", and those words never hold, so a seed a model also read as a
// title takes the comparison's honest stand-in.
test('a comparison whose seed a model read as a title is no hold', async () => {
  catalogueSongs = [filler];
  searchEmpty = true;
  modelOutput = read({ title: 'Creep', artist: 'Radiohead', search_terms: ['Creep', 'Radiohead'] });
  const result = await submit('something like Creep');
  assert.equal(result.outcome, 'substituted');
  assert.equal(queue.upcoming.length, 1);
});

// Last, because it leaves a mood in the library for every test after it.
test('with no model the rest of a request is an alternative once its genre is dropped', async () => {
  const db = await import('../src/music/library-db.js');
  const library = await import('../src/music/library.js');
  await library.load();
  db.upsertTrackMeta('calm-one', { title: 'Calm One', artist: 'Fixture Artist', album: 'Fixture', genres: ['Ambient'], year: 2000 });
  db.upsertTrackTags('calm-one', { moods: ['calm'], energy: 'medium', source: 'llm', model: 'test-model' });
  catalogueSongs = [filler];
  searchEmpty = true;
  genreSongs = [];
  modelError = true;
  const result = await submit('chill techno');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
  assert.equal(requestLog.snapshot(1)[0].pickSource, 'library-mood:calm');
});
