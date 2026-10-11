import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { PickerScope } from '../src/llm/internal/tools/picker/scope.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-instrumental-lock-'));
const song = (id: string) => ({ id, title: id, artist: `Artist ${id}`, genre: 'Ambient', duration: 180 });
let headCount = 80;
let includeInstrumentals = true;
let textDim = 768;
const calls: URL[] = [];
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  calls.push(url);
  const vector = (dim: number) => Array.from({ length: dim }, (_, i) => i === 0 ? 1 : 0);
  const json = (body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return json({ ok: true, engines: ['analyze'], analyze_text_capable: true });
  if (url.pathname === '/embed-text') return json({ ok: true, embeddings: [vector(512)] });
  if (url.pathname === '/v1/embeddings') return json({
    object: 'list', model: 'fixture',
    data: [{ object: 'embedding', index: 0, embedding: vector(textDim) }],
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
  const rows = [
    ...Array.from({ length: headCount }, (_, i) => song(`v${i}`)),
    ...(includeInstrumentals ? Array.from({ length: 12 }, (_, i) => song(`i${i}`)) : []),
  ];
  const count = Number(url.searchParams.get('size') || url.searchParams.get('count') || url.searchParams.get('songCount') || rows.length);
  let body: Record<string, unknown> = {};
  if (url.pathname.endsWith('/getRandomSongs')) body = { randomSongs: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getSimilarSongs2')) body = { similarSongs2: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getTopSongs')) body = { topSongs: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getSongsByGenre')) body = { songsByGenre: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getGenres')) body = { genres: { genre: [{ value: 'Ambient', songCount: 0 }] } };
  if (url.pathname.endsWith('/search3')) body = { searchResult3: { song: rows.slice(0, count), artist: [{ id: 'artist', name: 'Test Artist' }] } };
  if (url.pathname.endsWith('/getArtist')) body = { artist: { album: [{ id: 'album', year: 2026 }] } };
  if (url.pathname.endsWith('/getAlbumList2')) body = { albumList2: { album: [{ id: 'album' }] } };
  if (url.pathname.endsWith('/getAlbum')) body = { album: { song: rows } };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const { isInstrumental, instrumentalFromJson, deriveVocalFromLyrics } = await import('../src/music/lyric-vocal.js');
const { trackInstrumental, applyStrictLocks } = await import('../src/music/show-filter.js');
const { soundDescriptors } = await import('../src/music/embeddings.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
await settings.load();
await library.load();
textDim = db.getEmbeddingDim() ?? 768;
after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const bleed = [{ startMs: 1207, endMs: 4168 }];
const cases = [
  { id: 'empty', ranges: [], expected: true },
  { id: 'bleed', ranges: bleed, expected: true },
  { id: 'split-bleed', ranges: [{ startMs: 0, endMs: 2000 }, { startMs: 10000, endMs: 12999 }], expected: true },
  { id: 'boundary', ranges: [{ startMs: 0, endMs: 2000 }, { startMs: 10000, endMs: 13000 }], expected: false },
  { id: 'sung', ranges: [{ startMs: 2000, endMs: 22000 }], expected: false },
  { id: 'unknown', ranges: null, expected: null },
];
for (const c of cases) {
  db.upsertTrackMeta(c.id, song(c.id));
  db.upsertTrackTags(c.id, { moods: ['focus'], energy: 'low', source: 'manual' });
  if (c.ranges) db.upsertTrackAnalysis(c.id, { vocalRanges: c.ranges });
}
for (const prefix of ['v', 'i']) {
  const n = prefix === 'v' ? 80 : 12;
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    db.upsertTrackMeta(id, song(id));
    db.upsertTrackTags(id, { moods: ['focus'], energy: 'low', source: 'manual' });
    db.upsertTrackAnalysis(id, { vocalRanges: prefix === 'v' ? [{ startMs: 0, endMs: 60000 }] : bleed });
    // All 80 vocal neighbours precede the instrumentals in both real indexes.
    const vector = (dim: number) => Array.from({ length: dim }, (_, j) => j === 0 ? 1 : j === 1 ? (prefix === 'v' ? 0.01 : 1) : 0);
    db.upsertTrackVector(id, vector(db.getEmbeddingDim() ?? 768), null);
    db.upsertTrackAudioVector(id, vector(512));
  }
}
db.upsertTrackMeta('seed', song('seed'));
db.upsertTrackVector('seed', Array.from({ length: db.getEmbeddingDim() ?? 768 }, (_, i) => i === 0 ? 1 : 0), null);
db.upsertTrackAudioVector('seed', Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0));

const strict = { vocalLock: 'instrumental', energyLock: ['low'] } satisfies Partial<PickerScope>;
const tracksSchema = z.array(z.object({ id: z.string(), instrumental: z.boolean().optional() }));
async function execute(name: string, input: unknown, scope: Partial<PickerScope>) {
  const { tools, seen } = buildPickerTools(scope);
  const executeTool = tools[name]?.execute;
  assert.ok(executeTool, `${name} must be available`);
  const result = await executeTool(input, { toolCallId: 'test', messages: [], context: undefined });
  return { result, seen };
}

test('instrumental tolerance sums all sung ranges and keeps unknown distinct', () => {
  for (const c of cases) {
    assert.equal(isInstrumental(c.ranges), c.expected, c.id);
    assert.equal(instrumentalFromJson(c.ranges == null ? null : JSON.stringify(c.ranges)), c.expected == null ? null : Number(c.expected), c.id);
  }
  assert.equal(isInstrumental(undefined), null);
  assert.equal(instrumentalFromJson(' [ ] '), 1);
  assert.equal(instrumentalFromJson('broken json'), null);
  assert.equal(instrumentalFromJson('{}'), null);
  assert.equal(isInstrumental([{}]), false, 'malformed spans cannot grant instrumental eligibility');
});

test('lyric-derived classification agrees without erasing short measured phrases', () => {
  const derived = deriveVocalFromLyrics({ synced: true, lines: [{ startMs: 1200, text: 'a short sung phrase' }] });
  assert.ok(derived);
  assert.equal(derived.instrumental, isInstrumental(derived.vocalRanges));
  assert.equal(derived.instrumental, true);
  assert.deepEqual(derived.vocalRanges, [{ startMs: 1200, endMs: 5200 }]);
  assert.equal(derived.introMs, 1200, 'timing retains the measured onset');
});

test('SQL browse, Observatory, diagnostic rows, show locks and picker payloads agree', () => {
  const observatory = new Map(db.allTagged().map(row => [row.id, row.vocal]));
  const diagnostic = new Map(db.candidateFilterTracks().map(row => [row.id, row]));
  for (const c of cases) {
    assert.equal(trackInstrumental({ id: c.id }), c.expected, c.id);
    assert.equal(trackInstrumental(diagnostic.get(c.id)), c.expected, `diagnostic ${c.id}`);
    assert.equal(observatory.get(c.id), c.expected == null ? null : c.expected ? 'instrumental' : 'vocal');
    for (const mode of ['instrumental', 'vocal'] as const) {
      const want = c.expected === (mode === 'instrumental');
      assert.equal(db.filter({ q: c.id, vocal: mode }).rows.some(row => row.id === c.id), want, `SQL ${mode} ${c.id}`);
      assert.equal(applyStrictLocks([diagnostic.get(c.id) ?? {}], { vocals: mode }, { starve: true }).length, Number(want));
    }
    const [payload] = buildPickerContext(pickerScope()).collect([song(c.id)]);
    assert.equal(payload.instrumental ?? null, c.expected, `picker ${c.id}`);
    assert.equal(soundDescriptors({ vocalRanges: c.ranges }).includes('instrumental'), c.expected === true);
  }
});

test('text/audio seed and journey tools find eligible tracks beyond the old top 60', async () => {
  assert.equal(applyStrictLocks(library.tracksLikeThis('seed', 60), { vocals: 'instrumental' }, { starve: true }).length, 0);
  for (const name of ['tracksLikeThis', 'tracksThatSoundLikeThis', 'tracksTowardJourney']) {
    const { result, seen } = await execute(name, { songId: 'seed' }, {
      ...strict, audioWaypoint: Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0),
    });
    assert.ok(Array.isArray(result), `${name}: ${JSON.stringify(result)}`);
    const tracks = tracksSchema.parse(result);
    assert.equal(tracks.length, 8, name);
    assert.ok(tracks.every(row => row.id.startsWith('i') && row.instrumental), name);
    assert.equal(seen.size, 8, 'the over-fetch must not grow the model candidate cap');
  }
});

test('semantic lyric and sound queries also widen before their KNN cut', async () => {
  await settings.update({ embedding: {
    enabled: true, provider: 'openai-compatible', model: 'fixture',
    providerBaseUrls: { 'openai-compatible': `http://127.0.0.1:${address.port}/v1` },
  } });
  for (const name of ['searchByLyrics', 'searchBySound']) {
    const { result } = await execute(name, { query: 'ambient instrumental' }, strict);
    assert.ok(Array.isArray(result), `${name}: ${JSON.stringify(result)}`);
    const tracks = tracksSchema.parse(result);
    assert.equal(tracks.length, 8, name);
    assert.ok(tracks.every(row => row.id.startsWith('i') && row.instrumental), name);
  }
  await settings.update({ embedding: { enabled: false } });
});

for (const [name, input, oldLimit, endpoint, key] of [
  ['randomSongs', {}, 18, 'getRandomSongs', 'size'],
  ['similarSongs', { songId: 'seed' }, 20, 'getSimilarSongs2', 'count'],
  ['topSongsByArtist', { artist: 'Test Artist' }, 15, 'getTopSongs', 'count'],
  ['songsByGenre', { genre: 'Ambient' }, 50, 'getSongsByGenre', 'count'],
  ['searchLibrary', { query: 'Ambient' }, 25, 'search3', 'songCount'],
  ['recentByArtist', { artist: 'Test Artist' }, 6, 'getAlbum', null],
  ['recentlyAdded', {}, 3, 'getAlbum', null],
] as const) {
  test(`${name} widens before strict filtering and keeps unlocked fetches unchanged`, async () => {
    headCount = oldLimit;
    includeInstrumentals = true;
    calls.length = 0;
    const widened = await execute(name, input, strict);
    const tracks = tracksSchema.parse(widened.result);
    assert.ok(tracks.length > 0 && tracks.length <= 8);
    assert.ok(tracks.every(row => row.id.startsWith('i') && row.instrumental));
    if (key) assert.ok(calls.some(url => url.pathname.endsWith(`/${endpoint}`) && Number(url.searchParams.get(key)) === oldLimit * 5));
    calls.length = 0;
    const unlocked = await execute(name, input, {});
    assert.ok(tracksSchema.parse(unlocked.result).every(row => row.id.startsWith('v')));
    if (key) assert.ok(calls.some(url => url.pathname.endsWith(`/${endpoint}`) && Number(url.searchParams.get(key)) === oldLimit));
  });
}

test('wider discovery never relaxes strict locks or other hard exclusions', async () => {
  headCount = 20;
  includeInstrumentals = false;
  const empty = await execute('similarSongs', { songId: 'seed' }, strict);
  assert.equal(empty.seen.size, 0);
  assert.ok(!Array.isArray(empty.result), 'empty discovery still carries a note');
  assert.deepEqual(buildPickerContext(pickerScope({ ...strict, energyLock: ['high'] })).collect([song('i0')]), []);
  for (const constraints of [
    { minTrackSec: 200 }, { maxTrackSec: 100 },
    { excludedIds: new Set(['i0']) }, { playlistLock: new Set(['i1']) },
    { hardRecentIds: new Set(['i0']) },
  ]) {
    const context = buildPickerContext(pickerScope({ ...strict, ...constraints }));
    assert.deepEqual(context.collect([song('i0')]), []);
    assert.equal(context.seen.size, 0);
  }
  assert.equal(buildPickerContext(pickerScope()).candidateLimit(60), 60);
  assert.equal(buildPickerContext(pickerScope({ vocalLock: '', energyLock: [] })).candidateLimit(60), 60);
});
