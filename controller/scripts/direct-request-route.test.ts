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
const requestLog = await import('../src/broadcast/request-log.js');
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');
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
// The artist catalogue and genre pool the issue's lottery drew from; empty
// unless a test asks for them.
let artistSongs: RequestSong[];
let genreSongs: RequestSong[];
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
  queue.djLog = [];
  queue.senderBusy = true;
  queue._recentPlays = [];
  invalidateWeatherCache();
  bodies = [];
  modelError = false;
  introError = false;
  searchEmpty = false;
  catalogueSongs = [filler, exact];
  artistSongs = [];
  genreSongs = [];
  agentCalls = 0;
  modelOutput = { kind: 'track', title: exact.title, artist: 'Queen', search_terms: [exact.title, 'Queen'], genre: 'Rock', scope: 'song' };
  t.mock.method(requestAgent, 'run', async () => { agentCalls++; throw Error('Direct must never invoke the request agent'); });
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as any, 'doGenerate', async (options: any) => {
    bodies.push(options);
    if (modelError) throw Error('synthetic interpreter failure');
    const intro = JSON.stringify(options.prompt).includes('Write an intro for this track');
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
    const endpoint = url.pathname.split('/').at(-1);
    const artistQuery = artistSongs.length && /queen/i.test(url.searchParams.get('query') || '');
    const data = endpoint === 'search3' ? { searchResult3: { song: searchEmpty ? [] : catalogueSongs, artist: artistQuery ? [{ id: 'queen', name: 'Queen' }] : [] } }
      : endpoint === 'getStarred2' ? { starred2: { song: [filler] } }
        : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: [filler] } }
        : endpoint === 'getGenres' ? { genres: { genre: [{ value: 'Rock', songCount: 2 }] } }
          : endpoint === 'getSongsByGenre' ? { songsByGenre: { song: genreSongs } }
          : endpoint === 'getArtist' ? { artist: { album: artistSongs.length ? [{ id: 'queen-album', name: 'Sheer Heart Attack' }] : [] } }
          : endpoint === 'getAlbum' ? { album: { song: artistSongs } } : {};
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

test('Direct searches the named recording before genre candidates, with one interpretation call', async () => {
  const result = await submit();
  assert.equal(result.outcome, 'matched');
  assert.equal(result.track.title, exact.title);
  assert.equal(queue.upcoming[0].track.id, exact.id);
  assert.equal(bodies.length, 1);
  assert.ok(recentCalls.some(c => c.kind === 'matchRequest' && ['ai-sdk', 'ai-sdk:tool'].includes(c.via || '')));
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

test('review: a valid but unavailable language cannot silently fall back to another language', async () => {
  modelError = true;
  const result = await submit('Bohemian Rhapsody by Queen in Klingon');
  assert.equal(result.outcome, 'no-match');
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

test('Punjabi request requires first-class language metadata', async () => {
  const punjabi = { ...exact, id: 'punjabi-recording', title: 'Punjabi Song', artist: 'Punjabi Artist', genre: 'Punjabi Pop', language: 'pa' };
  catalogueSongs = [punjabi];
  modelOutput = { title: punjabi.title, artist: punjabi.artist, language: 'Punjabi' };
  const result = await submit(`play ${punjabi.title} by ${punjabi.artist} in Punjabi`);
  assert.equal(result.outcome, 'matched');
  assert.equal(queue.upcoming[0].track.id, punjabi.id);
});

test('Punjabi genre alone cannot satisfy a language request', async () => {
  const genreOnly = { ...exact, id: 'genre-only', title: 'Punjabi Song', artist: 'Punjabi Artist', genre: 'Punjabi Pop', language: undefined };
  catalogueSongs = [genreOnly];
  modelOutput = { title: genreOnly.title, artist: genreOnly.artist, language: 'Punjabi' };
  const result = await submit(`play ${genreOnly.title} by ${genreOnly.artist} in Punjabi`);
  assert.equal(result.outcome, 'no-match');
  assert.equal(queue.upcoming.length, 0);
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

  test(`#1961: the issue's own reply never passes a substitute off as the named song: ${text}`, async () => {
    modelOutput = issueReply;
    catalogueSongs = [filler];
    artistSongs = [killerQueen];
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.notEqual(queue.upcoming[0].track.id, exact.id);
    assert.match(result.ack, /alternative/);
    assert.doesNotMatch(result.ack, /Freddie|stage is set/);
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

  test(`#1961: a genre pool draw for a missing named song is an alternative: ${text}`, async () => {
    modelOutput = { ...issueReply, artist: null };
    catalogueSongs = [filler];
    genreSongs = [filler];
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
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

  test(`#1961: an artist pool draw for a missing named song is an alternative: ${text}`, async () => {
    modelOutput = issueReply;
    catalogueSongs = [filler];
    artistSongs = [killerQueen];
    const result = await submit(text);
    assert.equal(result.outcome, 'substituted');
    assert.equal(queue.upcoming[0].track.id, killerQueen.id);
    assert.match(result.ack, /alternative/);
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
  assert.equal(queue.upcoming[0].track.id, killerQueen.id);
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

test('a missing quoted title produces an honest alternative', async () => {
  catalogueSongs = [killerQueen];
  artistSongs = [killerQueen];
  modelOutput = { title: null, artist: 'Queen', genre: 'rock', search_terms: ['Killer Queen'] };
  const result = await submit('Play "Unavailable Example Recording"');
  assert.equal(result.outcome, 'substituted');
  assert.match(result.ack, /alternative/);
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
