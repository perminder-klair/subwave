// Real preparation -> controller search -> selection -> separate link writer.
// All HTTP is synthetic; assert the model has no executable discovery tools.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before, after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-targeted-route-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://targeted-library.invalid';
process.env.LIQUIDSOAP_HOST = 'targeted-mixer.invalid';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { buildShortlist } = await import('../src/music/shortlist.js');
const { CandidateOffers } = await import('../src/music/shortlist-offers.js');
const { pickerScope, PICKER_TOOLS } = await import('../src/llm/tools.js');
const realFetch = globalThis.fetch;
const realRandom = Math.random;
const show = { id: 's_targeted', name: 'Targeted hour', topic: 'Explore Portishead tracks', personaId: '', genres: ['Rock'], filtersStrict: true };
const songs = Array.from({ length: 6 }, (_, i) => ({ id: `targeted-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, genre: 'Rock', duration: 240 }));
const prohibited = [
  { id: 'wrong-genre', title: 'Outside', artist: 'Outside', genre: 'Jazz', duration: 240 },
  { id: 'too-short', title: 'Short', artist: 'Short', genre: 'Rock', duration: 10 },
  { id: 'recent', title: 'Recent', artist: 'Recent', genre: 'Rock', duration: 240 },
];
let preparations = 0;
let preparedAnswer = '{"searches":[{"kind":"library","query":"Portishead","evidence":"Explore Portishead tracks"}]}';
const preparationInputs: any[] = [];
const selectionInputs: any[] = [];
const linkInputs: any[] = [];
const queries: string[] = [];
before(async () => {
  await settings.load();
  show.personaId = settings.get().personas[0].id;
  const at = Date.now();
  await settings.update({ shows: [show], scheduleOverride: { showId: show.id, startedAt: at - 60_000, expiresAt: at + 3600_000 },
    tts: { enabled: true }, llm: { provider: 'openai-compatible', model: 'targeted-test',
      baseUrl: 'http://targeted-model.invalid/v1', apiKey: 'test', fallback: { enabled: false },
      noRepeatWindow: 0, artistVarietyWindow: 0, trackSelection: 'shortlist', shortlistPasses: 2 } });
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'targeted-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      if (endpoint === 'search3') queries.push(url.searchParams.get('query') || '');
      const data = endpoint === 'getGenres' ? { genres: { genre: [{ value: 'Rock', songCount: 6, albumCount: 1 }] } }
        : endpoint === 'search3' ? { searchResult3: { song: [...songs, ...prohibited] } }
        : endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
          : endpoint === 'getStarred2' ? { starred2: { song: songs } }
            : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
              : endpoint === 'getAlbum' ? { album: { song: songs } }
                : endpoint === 'getSong' ? { song: songs.find(song => song.id === url.searchParams.get('id')) } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'targeted-model.invalid', 'no live network requests');
    const body = JSON.parse(String(init?.body));
    const user = body.messages.find((message: any) => message.role === 'user')?.content;
    if (!body.tools?.length && String(user).startsWith('{"topic"')) {
      preparations++; preparationInputs.push(body);
      return completion(preparedAnswer);
    }
    if (body.tools?.length) {
      selectionInputs.push(body);
      return Response.json({ id: 'pick', object: 'chat.completion', created: 0, model: 'targeted-test',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: 'emit', type: 'function', function: { name: body.tools[0].function.name,
            arguments: JSON.stringify({ id: songs[0].id, musicalReason: 'its patient guitar carries a warm groove into a gentler space', transition: null }) } }],
        } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    linkInputs.push(body);
    return completion('A patient guitar carries this groove.');
  };
});
function completion(content: string) {
  return Response.json({ id: 'text', object: 'chat.completion', created: 0, model: 'targeted-test',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
}
after(() => { globalThis.fetch = realFetch; Math.random = realRandom; library.shutdown(); rmSync(root, { recursive: true, force: true }); });

async function pick() {
  const ctx = { at: new Date().toISOString(), activeShow: show, dominantMood: null, time: { period: 'day' } };
  session.start(ctx as any);
  session.appendTurn({ role: 'event', kind: 'request', text: 'RAW_PRIVATE_LISTENER' });
  session.appendTurn({ role: 'dj', kind: 'pick', text: 'PRIVATE_PICKING_REASON' });
  const q = Object.create(queue);
  q.current = { track: { id: 'anchor', title: 'Anchor', artist: 'Anchor', duration: 240 } };
  q.upcoming = []; q.history = []; q._recentPlays = []; q.senderBusy = true;
  q.log = () => {};
  q.getDjRecap = () => 'EXISTING_SPEECH_RECAP'; q.getRecentTracks = () => [];
  q.getRecentOpeners = () => []; q.getLastLinkText = () => null;
  Math.random = () => 0.5;
  try { await runTrackEvent(q, ctx, { wantLink: true }); }
  finally { Math.random = realRandom; if (q._persistTimer) clearTimeout(q._persistTimer); }
  assert.equal(q.upcoming.length, 1);
}

test('one tool-free preparation supplies controller searches across picks without altering speech input', async () => {
  await pick(); await pick();
  assert.equal(preparations, 1);
  assert.equal(preparationInputs[0].tools, undefined, 'preparation sends no tools to the LLM');
  assert.equal(selectionInputs.length, 2);
  assert.ok(queries.length >= 2 && queries.every(query => query === 'Portishead'), 'controller actually executes the prepared query');
  const discoveryNames = new Set(PICKER_TOOLS.map(tool => tool.name));
  for (const body of selectionInputs) {
    assert.ok(body.tools.every((tool: any) => !discoveryNames.has(tool.function.name)), 'structured response formatting must not expose discovery tools');
    const user = body.messages.find((message: any) => message.role === 'user').content;
    const offered = JSON.parse(user.split('\n')[0]).shortlist;
    assert.ok(offered.some((track: any) => track.source === 'searchLibrary'));
    assert.ok(!offered.some((track: any) => track.id === 'wrong-genre'));
  }
  assert.doesNotMatch(JSON.stringify(preparationInputs), /RAW_PRIVATE_LISTENER|PRIVATE_PICKING_REASON/);
  assert.equal(linkInputs.length, 2);
  for (const body of linkInputs) {
    assert.match(JSON.stringify(body), /EXISTING_SPEECH_RECAP/);
    assert.doesNotMatch(JSON.stringify(body), /Extract explicit music search requests|"searches"|PRIVATE_PICKING_REASON|RAW_PRIVATE_LISTENER/);
  }
});

test('real targeted discovery preserves strict locks, recency, exclusions and duration floor', async () => {
  const result = await buildShortlist({
    scope: pickerScope({ genreLock: ['Rock'], minTrackSec: 60, hardRecentIds: new Set(['recent']), excludedIds: new Set([songs[0].id]) }),
    currentTrackId: null, discoveryPasses: 2, rotationSeed: 0,
    searches: [{ kind: 'library', query: 'Portishead' }],
  }, new CandidateOffers());
  assert.ok(result.sourceRuns.some(run => run.source === 'searchLibrary'));
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every(track => !['wrong-genre', 'too-short', 'recent', songs[0].id].includes(track.id)));
});

test('a generic presenter biography keeps ordinary discovery even if preparation invents searches', async () => {
  show.topic = readFileSync(new URL('./fixtures/shortlist-search/chris-show-brief.md', import.meta.url), 'utf8');
  await settings.update({ shows: [show] });
  preparedAnswer = JSON.stringify({ searches: [
    { kind: 'theme', query: 'songs about everyday life', evidence: "The working day has settled in, the kettle's probably been on once already" },
    { kind: 'artist', query: 'Chris Sittins', evidence: 'Chris Sittins is here to keep you company with two hours of great music and good conversation.' },
    { kind: 'library', query: 'overlooked album track', evidence: "the next he'll quietly champion an overlooked album track" },
  ] });
  const before = preparations;
  const queryStart = queries.length;
  const pickStart = selectionInputs.length;
  await pick(); await pick();
  assert.equal(preparations, before + 1, 'empty grounded results are reused for the airing');
  assert.ok(queries.slice(queryStart).every(query => !/Chris|everyday life|overlooked/i.test(query)));
  for (const body of selectionInputs.slice(pickStart)) {
    const user = body.messages.find((message: any) => message.role === 'user').content;
    const offered = JSON.parse(user.split('\n')[0]).shortlist;
    assert.ok(offered.length > 0, 'ordinary discovery still supplies selectable tracks');
    assert.ok(offered.every((track: any) => track.source !== 'searchLibrary'));
  }
  assert.doesNotMatch(JSON.stringify(linkInputs.slice(-2)), /Extract explicit music search requests|"evidence"|PRIVATE_PICKING_REASON|RAW_PRIVATE_LISTENER/);
});
