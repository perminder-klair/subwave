// A clean show across the pick paths, through the real code with only HTTP
// stubbed: the Agentic discovery tools, Track Shortlist, the stateless pool and
// its guard rescue, a playlist anchor and the in-order walk. The show is a real
// takeover, so what reaches each path is what settings.resolveActiveShow says.
//
// Two rules are the point. Off is unchanged. And when a pool runs dry, the
// show's OTHER filters give way before this one: a pick path never airs a track
// tagged explicit, it leaves the slot to the coast (explicit-coast.test.ts).
// Run: `npm test -- explicit-pick-paths`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { chatCompletionResponse } from './test-utils/llm.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-explicit-picks-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://explicit-picks.invalid';

const settings = await import('../src/settings.js');
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');
const { resolveInOrderNext } = await import('../src/music/playlist-order-next.js');
const { livePickerScope } = await import('../src/broadcast/dj-agent.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { buildShortlist } = await import('../src/music/shortlist.js');
const { runArtistGuard } = await import('../src/broadcast/dj-agent/artist-guard.js');
const { showPreparation } = await import('../src/broadcast/show-preparation.js');

type Song = { id: string; title: string; artist: string; duration: number; genre?: string; genres?: Array<{ name: string }>; explicitStatus?: string };
let seq = 0;
const song = (id: string, explicitStatus: string | undefined, genre = 'Soul'): Song => ({
  id, title: id, artist: `Act ${++seq}`, duration: 240, genre, genres: [{ name: genre }],
  ...(explicitStatus === undefined ? {} : { explicitStatus }),
});

const TAGGED = song('tagged', 'explicit');
const MARKED_CLEAN = song('marked-clean', 'clean');
const UNTAGGED = song('untagged', '');
const UNREPORTED = song('unreported', undefined);

let random: Song[] = [];
// The thin-pool top-up, told apart from the exploration slot by its size.
let randomTopUp: Song[] | null = null;
let randomInGenre: Song[] = [];
let byGenre: Song[] = [];
let playlist: Song[] = [];
let genres: string[] = ['Soul'];
let modelCalls = 0;
let offered: Array<Array<{ id: string }>> = [];

const realFetch = globalThis.fetch;
before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: {
      provider: 'openai-compatible', model: 'explicit-test', baseUrl: 'http://explicit-model.invalid/v1',
      apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0, artistVarietyWindow: 0,
    },
  } as never);
  await blocklist.load();
  await library.load();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'explicit-picks.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const unfiltered = url.searchParams.get('size') === '10' && randomTopUp ? randomTopUp : random;
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: url.searchParams.has('genre') ? randomInGenre : unfiltered } }
        : endpoint === 'getSongsByGenre' ? { songsByGenre: { song: byGenre } }
          : endpoint === 'getGenres' ? { genres: { genre: genres.map(value => ({ value, songCount: 10 })) } }
            : endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'pin', name: 'Pinned' }] } }
              : endpoint === 'getPlaylist' ? { playlist: { entry: playlist } }
                : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'explicit-model.invalid', 'unexpected network request');
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]);
    offered.push(payload.candidates);
    return chatCompletionResponse({
      id: 'c', created: 0, model: 'explicit-test',
      message: {
        role: 'assistant', content: null, tool_calls: [{
          id: 't', type: 'function', function: {
            name: body.tools[0].function.name,
            arguments: JSON.stringify({ id: payload.candidates[0].id, reason: 'Fixture' }),
          },
        }],
      },
    });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  library.shutdown();
  await removeTempDir(stateRoot);
});

beforeEach(() => {
  random = []; randomTopUp = null; randomInGenre = []; byGenre = []; playlist = []; genres = ['Soul'];
  modelCalls = 0; offered = [];
  clearPoolCache();
  clearPlaylistCache();
});

async function onAir(show: Record<string, unknown>) {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_clean', name: 'Clean Hour', personaId: settings.get().personas[0].id, ...show }],
    scheduleOverride: { showId: 's_clean', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  return settings.resolveActiveShow();
}

function stubQueue() {
  const q = Object.create(queue);
  q.current = { track: { id: 'on-air', title: 'On Air', artist: 'On Air Act' } };
  q.upcoming = [];
  q.history = [];
  q._recentPlays = [];
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => { logs.push(line); };
  return { q, logs };
}

const pool = (q: any, activeShow: unknown, opts = {}) =>
  pickViaPool(q, { dominantMood: null, activeShow, time: { period: 'day' } }, null, null, opts);
const offeredIds = () => offered[0].map(c => c.id).sort();

// ─── Agentic discovery tools ────────────────────────────────────────────────

test('agentic: the live scope follows the show, and every discovery tool honours it', async () => {
  await onAir({ excludeExplicit: true });
  random = [TAGGED, MARKED_CLEAN, UNTAGGED, UNREPORTED];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  assert.equal(scope.excludeExplicit, true);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  assert.deepEqual([...seen.keys()].sort(), ['marked-clean', 'unreported', 'untagged']);
});

test('agentic: a show that is not clean sees every track, and fetches what it always did', async () => {
  await onAir({});
  random = [TAGGED, MARKED_CLEAN];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  assert.equal(scope.excludeExplicit, false);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  assert.deepEqual([...seen.keys()].sort(), ['marked-clean', 'tagged']);
  assert.equal(buildPickerContext(scope).candidateLimit(10), 10);
});

test('agentic: a hard filter widens the bounded fetches behind it, as the strict locks do', () => {
  assert.equal(buildPickerContext(pickerScope({ excludeExplicit: true })).candidateLimit(10), 50);
});

test('agentic: a tool left with nothing says so, rather than handing back a bare []', async () => {
  await onAir({ excludeExplicit: true, playlistIds: ['pin'] });
  playlist = [TAGGED];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  const { tools } = buildPickerTools(scope) as any;
  const answer = await tools.showPlaylistTracks.execute({}, {});
  assert.deepEqual(answer.tracks, []);
  assert.match(answer.note, /strict filters/);
});

test('guard re-pick: the alternatives a guard offers come from the same clean candidates', async () => {
  await onAir({ excludeExplicit: true });
  const anchor = { id: 'anchor', title: 'Anchor', artist: 'Anchor Act' };
  random = [{ ...TAGGED, artist: 'Other Act' }, { ...MARKED_CLEAN, artist: 'Third Act' }];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.randomSongs.execute({}, {});
  let alternatives: string[] = [];
  await runArtistGuard<any>({
    song: { id: 'dup', title: 'Dup', artist: anchor.artist }, object: { id: 'dup' }, pickAnchor: anchor, seen,
    recentRoots: new Set<string>(), window: 0,
    repick: async (alt: Map<string, any>) => { alternatives = [...alt.keys()]; return null; },
    poolRescue: async () => 'empty', log: () => {}, logEvent: () => {},
  });
  assert.deepEqual(alternatives, ['marked-clean']);
});

// ─── Track Shortlist ────────────────────────────────────────────────────────

test('shortlist: the plan runs through the same scope, so its candidates are clean too', async () => {
  await onAir({ excludeExplicit: true });
  random = [TAGGED, MARKED_CLEAN, UNTAGGED];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  const shortlist = await buildShortlist({ scope, currentTrackId: null, discoveryPasses: 3 });
  assert.deepEqual(shortlist.candidates.map(c => c.id).sort(), ['marked-clean', 'untagged']);
});

// ─── The stateless pool ─────────────────────────────────────────────────────

test('pool: tagged tracks never reach the model; clean, no tag and unknown all do', async () => {
  const show = await onAir({ excludeExplicit: true });
  random = [TAGGED, MARKED_CLEAN, UNTAGGED, UNREPORTED];
  const { q } = stubQueue();
  const picked = await pool(q, show);
  assert.ok(picked);
  assert.deepEqual(offeredIds(), ['marked-clean', 'unreported', 'untagged']);
});

test('pool: a raw child with no field is judged on its library row', async () => {
  db.upsertTrackMeta('walked-explicit', { title: 'walked-explicit', artist: 'Row Act', explicitStatus: 'explicit' });
  const show = await onAir({ excludeExplicit: true });
  random = [song('walked-explicit', undefined), MARKED_CLEAN];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean']);
});

test('pool: a show that is not clean offers exactly what it did', async () => {
  const show = await onAir({});
  random = [TAGGED, MARKED_CLEAN, UNTAGGED];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean', 'tagged', 'untagged']);
});

test('pool: a strict genre gives way before the explicit filter', async () => {
  // The only in-genre track is tagged. Never-starve per dimension skips the
  // genre step, so an off-genre clean track airs rather than the tagged one.
  genres = ['Soul', 'Rock'];
  const inGenre = song('in-genre-tagged', 'explicit', 'Soul');
  const offGenre = song('off-genre-clean', 'clean', 'Rock');
  const show = await onAir({ excludeExplicit: true, filtersStrict: true, genres: ['Soul'] });
  random = [inGenre, offGenre];
  byGenre = [inGenre];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['off-genre-clean']);
});

test('pool: a source\'s own strict lean gives way too, without waiting for the thin-pool top-up', async () => {
  genres = ['Soul', 'Rock'];
  const inGenre = song('source-tagged', 'explicit', 'Soul');
  const offGenre = song('source-clean', 'clean', 'Rock');
  const show = await onAir({ excludeExplicit: true, filtersStrict: true, genres: ['Soul'] });
  random = [inGenre, offGenre];
  randomTopUp = [inGenre];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['source-clean']);
});

test('pool: a strict era with a clean twin keeps the era, so nothing relaxes that need not', async () => {
  genres = ['Soul'];
  const inEra = { ...song('in-era-clean', 'clean'), year: 1975 };
  const inEraTagged = { ...song('in-era-tagged', 'explicit'), year: 1975 };
  const offEra = { ...song('off-era-clean', 'clean'), year: 2015 };
  const show = await onAir({ excludeExplicit: true, filtersStrict: true, eras: [{ fromYear: 1970, toYear: 1979 }] });
  random = [inEra, inEraTagged, offEra];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['in-era-clean']);
});

test('pool: tagged tracks do not use up a source\'s slots', async () => {
  // A strict playlist skips the exploration slot, so the thin-pool random
  // top-up is the only source here, and it samples four.
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true });
  playlist = [TAGGED];
  random = [...Array.from({ length: 6 }, (_, i) => song(`crowd-${i}`, 'explicit')), MARKED_CLEAN];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean']);
});

test('pool: a big anchor of tagged tracks cannot crowd out its clean one', async () => {
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'] });
  playlist = [...Array.from({ length: 200 }, (_, i) => song(`crowd-${i}`, 'explicit')), MARKED_CLEAN];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean']);
});

test('pool: an era only tagged tracks meet gives way, in either show-genre fetch', async () => {
  const inEra = { ...song('era-tagged', 'explicit'), year: 1975 };
  const offEra = { ...song('era-clean', 'clean'), year: 2015 };
  const show = await onAir({ excludeExplicit: true, genres: ['Soul'], eras: [{ fromYear: 1970, toYear: 1979 }] });
  const { q } = stubQueue();
  byGenre = [inEra, offEra];
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['era-clean'], 'the sampled genre page');
  byGenre = [];
  randomInGenre = [inEra, offEra];
  clearPoolCache();
  offered = [];
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['era-clean'], 'the random genre draw');
});

test('pool: an energy lean gives way, so a mood\'s only low-energy track being tagged airs another', async () => {
  const mood = settings.moodVocab()[0];
  for (const [id, energy, explicitStatus] of [['mood-tagged', 'low', 'explicit'], ['mood-clean', 'high', 'clean']] as const) {
    db.upsertTrackMeta(id, { title: id, artist: `Mood ${id}`, explicitStatus });
    db.upsertTrackTags(id, { moods: [mood], energy, source: 'llm' });
  }
  try {
    const show = await onAir({ excludeExplicit: true, moods: [mood], energies: ['low'] });
    const { q } = stubQueue();
    await pool(q, show);
    assert.ok(offered[0]?.some(c => c.id === 'mood-clean'), JSON.stringify(offered[0]));
    assert.ok(!offered[0].some(c => c.id === 'mood-tagged'));
  } finally {
    const remove = db.getDb()!.prepare('DELETE FROM tracks WHERE id = ?');
    remove.run('mood-tagged');
    remove.run('mood-clean');
  }
});

test('pool: with every clean track just played the slot goes to the coast, never to a tagged track', async () => {
  const show = await onAir({ excludeExplicit: true });
  random = [TAGGED, MARKED_CLEAN];
  const { q } = stubQueue();
  q.recentlyPlayed = () => ({ ids: new Set(['marked-clean']), keys: new Set<string>() });
  assert.equal(await pool(q, show), null);
  assert.equal(modelCalls, 0);
});

test('pool: nothing but tagged tracks leaves the slot to the coast, with no model call, and says why', async () => {
  const show = await onAir({ excludeExplicit: true });
  random = [TAGGED, song('tagged-2', 'explicit')];
  const { q, logs } = stubQueue();
  const picked = await pool(q, show);
  assert.equal(picked, null);
  assert.equal(modelCalls, 0);
  assert.ok(logs.some(l => /clean show "Clean Hour".*2 track\(s\) tagged explicit.*auto-playlist/.test(l)), logs.join(' | '));
});

test('pool: a prepared episode holds the line too, and this gate is all that stands in its way', async (t) => {
  // Prepared before the show went clean, or before the walk that tagged its
  // artist. An episode's tracks reach the pool directly, past every source's own
  // sampling, so add() is the only filter on them.
  const show = await onAir({ excludeExplicit: true });
  const tracks = [TAGGED, UNTAGGED];
  t.mock.method(showPreparation, 'read', () => ({
    music: { kind: 'artist', identity: 'episode', artist: { id: 'a', name: 'A' }, tracks, ids: new Set(tracks.map(s => s.id)) },
    status: { kind: 'ready', occurrence: { id: 'o' } },
    editorial: null,
  }) as never);
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offered.flat().map(c => c.id), ['untagged']);
});

test('pool: an empty pool that a clean show did not cause logs nothing about it', async () => {
  const show = await onAir({ excludeExplicit: true });
  const { q, logs } = stubQueue();
  assert.equal(await pool(q, show), null);
  assert.ok(!logs.some(l => /clean show/.test(l)), logs.join(' | '));
});

test('guard rescue: the pool rescue a guard falls back on holds the same line', async () => {
  const show = await onAir({ excludeExplicit: true });
  const rescuer = { ...TAGGED, artist: 'Rescuer' };
  random = [rescuer, { ...MARKED_CLEAN, artist: 'Avoided' }];
  const { q } = stubQueue();
  const picked = await pool(q, show, { avoidArtist: 'Avoided' });
  assert.equal(picked, null, 'the only other artist is tagged, so the rescue finds nothing rather than air it');
  clearPoolCache();
  random = [rescuer, { ...MARKED_CLEAN, artist: 'Avoided' }, { ...UNTAGGED, artist: 'Fresh Act' }];
  assert.equal((await pool(q, show, { avoidArtist: 'Avoided' }))?.song.id, 'untagged');
});

// ─── Show playlists ─────────────────────────────────────────────────────────

test('pool: a soft playlist anchor drops its tagged tracks', async () => {
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'] });
  playlist = [TAGGED, MARKED_CLEAN, UNTAGGED];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean', 'untagged']);
});

test('pool: a strict playlist of nothing but tagged tracks gives way, not the filter', async () => {
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true });
  playlist = [TAGGED];
  random = [TAGGED, MARKED_CLEAN];
  byGenre = [];
  const { q } = stubQueue();
  await pool(q, show);
  assert.deepEqual(offeredIds(), ['marked-clean']);
});

test('agentic: a strict playlist anchor is cut to what can air', async () => {
  await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true });
  playlist = [TAGGED, MARKED_CLEAN];
  const { q } = stubQueue();
  const { scope } = await livePickerScope(q);
  const { tools, seen } = buildPickerTools(scope) as any;
  await tools.showPlaylistTracks.execute({}, {});
  assert.deepEqual([...seen.keys()], ['marked-clean']);
});

test('in order: the walk steps over a tagged track and keeps its place in the running order', async () => {
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true, playlistInOrder: true });
  playlist = [TAGGED, MARKED_CLEAN, UNTAGGED];
  const next = await resolveInOrderNext(show);
  assert.equal(next.ok && next.track.id, 'marked-clean');
  assert.equal(next.ok && next.index, 1);
});

test('in order: an anchor of nothing but tagged tracks stands aside for the other paths', async () => {
  const show = await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true, playlistInOrder: true });
  playlist = [TAGGED];
  const next = await resolveInOrderNext(show);
  assert.equal(next.ok, false);
});

test('in order: a show that is not clean walks every track', async () => {
  const show = await onAir({ playlistIds: ['pin'], playlistStrict: true, playlistInOrder: true });
  playlist = [TAGGED, MARKED_CLEAN];
  const next = await resolveInOrderNext(show);
  assert.equal(next.ok && next.track.id, 'tagged');
});
