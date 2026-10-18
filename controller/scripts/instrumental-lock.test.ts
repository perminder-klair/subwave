import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import express from 'express';
import { chatCompletion } from './test-utils/llm.js';
import type { PickerScope } from '../src/llm/internal/tools/picker/scope.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-instrumental-lock-'));
const song = (id: string) => ({ id, title: id, artist: `Artist ${id}`, genre: 'Ambient', duration: 180 });
let headCount = 80;
let includeInstrumentals = true;
let textDim = 768;
let releases: Array<{ id: string; year: number; songs: ReturnType<typeof song>[] }> | null = null;
const calls: URL[] = [];
const embeddingInputs: string[] = [];
const app = express();
app.use(express.json());
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  calls.push(url);
  if (url.pathname.startsWith('/library/')) return app(req, res);
  const vector = (dim: number) => Array.from({ length: dim }, (_, i) => i === 0 ? 1 : 0);
  const json = (body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return json({ ok: true, engines: ['analyze'], analyze_text_capable: true });
  if (url.pathname === '/embed-text') return json({ ok: true, embeddings: [vector(512)] });
  if (url.pathname === '/v1/embeddings' || url.pathname === '/v1/chat/completions') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith('/chat/completions')) return json(chatCompletion({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'tag', type: 'function',
        function: { name: body.tool_choice?.function?.name ?? body.tools?.[0]?.function?.name ?? 'emit', arguments: JSON.stringify({ results: [{ moods: ['calm'], energy: 'low' }] }) } }] },
    }));
    embeddingInputs.push(...z.array(z.string()).parse(body.input));
    return json({
      object: 'list', model: 'fixture',
      data: [{ object: 'embedding', index: 0, embedding: vector(textDim) }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  const rows = [
    ...Array.from({ length: headCount }, (_, i) => song(`v${i}`)),
    ...(includeInstrumentals ? Array.from({ length: 12 }, (_, i) => song(`i${i}`)) : []),
  ];
  const count = Number(url.searchParams.get('size') || url.searchParams.get('count') || url.searchParams.get('songCount') || rows.length);
  let body: Record<string, unknown> = {};
  if (url.pathname.endsWith('/getRandomSongs')) body = { randomSongs: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getSimilarSongs2')) body = { similarSongs2: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getSonicSimilarTracks')) body = { sonicSimilarTracks: { sonicMatch: rows.slice(0, count).map(entry => ({ entry })) } };
  if (url.pathname.endsWith('/getArtistInfo2')) body = { artistInfo2: { similarArtist: [{ name: 'Neighbour' }] } };
  if (url.pathname.endsWith('/getTopSongs')) body = { topSongs: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getSongsByGenre')) body = { songsByGenre: { song: rows.slice(0, count) } };
  if (url.pathname.endsWith('/getGenres')) body = { genres: { genre: [{ value: 'Ambient', songCount: 0 }] } };
  if (url.pathname.endsWith('/search3')) body = { searchResult3: { song: rows.slice(0, count), artist: [{ id: 'artist', name: 'Test Artist' }] } };
  if (url.pathname.endsWith('/getArtist')) body = { artist: { album: releases?.map(({ id, year }) => ({ id, year })) ?? [{ id: 'album', year: 2026 }] } };
  if (url.pathname.endsWith('/getAlbumList2')) body = { albumList2: { album: [{ id: 'album' }] } };
  if (url.pathname.endsWith('/getAlbum')) body = { album: { song: releases?.find(release => release.id === url.searchParams.get('id'))?.songs ?? rows } };
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
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
const db = await import('../src/music/library-db.js');
const { requireDb } = await import('../src/music/library-db/handle.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const { isInstrumental, instrumentalFromJson, deriveVocalFromLyrics } = await import('../src/music/lyric-vocal.js');
const { trackInstrumental, applyStrictLocks } = await import('../src/music/show-filter.js');
const { soundDescriptors } = await import('../src/music/embeddings.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');
const { router: maintenanceRoutes } = await import('../src/routes/library/maintenance.js');
app.use(maintenanceRoutes);
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

test('persisted malformed vocal spans never earn instrumental eligibility through any reader', () => {
  const valid = [{ startMs: 0, endMs: 3000 }];
  for (const fixture of [
    { id: 'mixed', json: JSON.stringify([...valid, {}]), ranges: valid, expected: false },
    { id: 'invalid', json: '[{}]', ranges: [], expected: false },
    { id: 'strings', json: '[{"startMs":"0","endMs":"3000"}]', ranges: [], expected: false },
    { id: 'negative', json: '[{"startMs":-1000,"endMs":2000}]', ranges: [], expected: false },
    { id: 'broken', json: 'broken json', ranges: null, expected: null },
    { id: 'object', json: '{}', ranges: null, expected: null },
  ]) {
    const id = `malformed-${fixture.id}`;
    db.upsertTrackMeta(id, song(id));
    db.upsertTrackTags(id, { moods: ['focus'], energy: 'low', source: 'manual' });
    requireDb().prepare('UPDATE tracks SET vocal_ranges_json = ? WHERE id = ?').run(fixture.json, id);
    assert.equal(instrumentalFromJson(fixture.json), fixture.expected == null ? null : 0, id);
    for (const [reader, row] of [
      ['getTrack', db.getTrack(id)],
      ['library.get', library.get(id)],
      ['energy pool', db.songsByEnergy('low').find(row => row.id === id)],
      ['library energy pool', library.songsByEnergy('low').find(row => row.id === id)],
      ['browse row', db.filter({ q: id }).rows[0]],
      ['diagnostic', db.candidateFilterTracks().find(row => row.id === id)],
    ] as const) {
      assert.ok(row, `${id}: ${reader}`);
      assert.equal(row.vocalRangesInvalid, fixture.expected === false, `${id}: ${reader} retains invalid-span evidence`);
      assert.deepEqual(row.vocalRanges, fixture.ranges, `${id}: ${reader} retains usable timing spans`);
      assert.equal(trackInstrumental(row), fixture.expected, `${id}: ${reader} classification`);
      assert.deepEqual(soundDescriptors(row), [], `${id}: ${reader} embedding descriptor`);
    }
    assert.equal(db.filter({ q: id, vocal: 'instrumental' }).total, 0, id);
    assert.equal(db.filter({ q: id, vocal: 'vocal' }).total, fixture.expected == null ? 0 : 1, id);
    assert.equal(db.allTagged().find(row => row.id === id)?.vocal, fixture.expected == null ? null : 'vocal', id);
    assert.equal(library.filter({ q: id }).rows[0].instrumental, fixture.expected, id);
    assert.deepEqual(buildPickerContext(pickerScope(strict)).collect([song(id)]), [], id);
    const [payload] = buildPickerContext(pickerScope()).collect([song(id)]);
    assert.equal(payload.instrumental ?? null, fixture.expected, `${id}: picker payload`);
  }
});

test('recentByArtist keeps the newest eligible releases through recency and the cap', async (t) => {
  const newest = Array.from({ length: 6 }, (_, i) => ({ ...song(`latest-new-${i}`), artist: 'Test Artist', album: 'New', year: 2026 }));
  const older = Array.from({ length: 24 }, (_, i) => ({ ...song(`latest-old-${i}`), artist: 'Test Artist', album: 'Old', year: 2020 }));
  releases = [{ id: 'new', year: 2026, songs: newest }, { id: 'old', year: 2020, songs: older }];
  t.after(() => { releases = null; });
  for (const row of [...newest, ...older]) {
    db.upsertTrackMeta(row.id, row);
    db.upsertTrackTags(row.id, { moods: ['focus'], energy: 'low', source: 'manual' });
    db.upsertTrackAnalysis(row.id, { vocalRanges: [] });
  }
  let draw = 0;
  t.mock.method(Math, 'random', () => ++draw / 100);
  const { tools } = buildPickerTools({ ...strict, hardRecentIds: new Set([newest[0].id]) });
  const run = tools.recentByArtist.execute;
  assert.ok(run);
  const eligible = [...newest.slice(1), ...older];
  for (const offset of [0, 8]) {
    const rows = tracksSchema.parse(await run({ artist: 'Test Artist' }, { toolCallId: 'latest', messages: [], context: undefined }));
    assert.deepEqual(rows.map(row => row.id), eligible.slice(offset, offset + 8).map(row => row.id));
  }
  const shuffled = buildPickerContext(pickerScope(strict)).collect([...newest, ...older], 8, { maxPerArtist: Infinity });
  assert.ok(shuffled.every(row => row.id.startsWith('latest-old-')), 'other tools keep the freshness shuffle');
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
    const unlockedTracks = tracksSchema.parse(unlocked.result);
    if (name === 'recentlyAdded') {
      assert.equal(unlockedTracks.length, 3, 'the cached album source keeps its unlocked three-track sample');
    } else {
      assert.ok(unlockedTracks.every(row => row.id.startsWith('v')));
    }
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

test('server sonic neighbours widen before the strict vocal filter', async () => {
  headCount = 20;
  includeInstrumentals = true;
  for (const scope of [{ sonicSimilarity: true }, { ...strict, sonicSimilarity: true }]) {
    calls.length = 0;
    const rows = tracksSchema.parse((await execute('sonicSimilarTracks', { songId: 'seed' }, scope)).result);
    assert.equal(rows.length, 8);
    assert.ok(rows.every(row => row.id.startsWith('vocalLock' in scope ? 'i' : 'v')));
    assert.ok(calls.some(url => url.pathname.endsWith('/getSonicSimilarTracks')
      && Number(url.searchParams.get('count')) === ('vocalLock' in scope ? 100 : 20)));
  }
});

for (const [name, input, vocalHead] of [
  ['frequentAlbums', {}, 3],
  ['similarArtistTracks', { artist: 'Test Artist' }, 5],
] as const) {
  test(`${name} separates locked and unlocked cached pools`, async (t) => {
    headCount = vocalHead;
    includeInstrumentals = true;
    t.mock.method(Math, 'random', () => 0.999999);
    for (const scopes of [[{}, strict], [strict, {}]]) {
      clearPickerSourceCache();
      for (const scope of scopes) {
        const rows = tracksSchema.parse((await execute(name, input, scope)).result);
        assert.ok(rows.length > 0 && rows.length <= 8);
        assert.ok(rows.every(row => row.id.startsWith('vocalLock' in scope ? 'i' : 'v')));
      }
    }
  });
}

test('era discovery widens across browse pages without changing unlocked samples', async (t) => {
  for (let i = 0; i < 320; i++) {
    const id = `era-${String(i).padStart(3, '0')}`;
    db.upsertTrackMeta(id, { ...song(id), artist: id, year: 1985 });
    db.upsertTrackTags(id, { moods: ['focus'], energy: 'low', source: 'manual' });
    db.upsertTrackAnalysis(id, { vocalRanges: i < 280 ? [{ startMs: 0, endMs: 60000 }] : bleed });
  }
  t.mock.method(Math, 'random', () => 0);
  const input = { fromYear: 1980, toYear: 1989 };
  const unlocked = tracksSchema.parse((await execute('songsByEra', input, {})).result);
  assert.ok(unlocked.every(row => Number(row.id.slice(4)) < 60));
  const locked = tracksSchema.parse((await execute('songsByEra', input, strict)).result);
  assert.equal(locked.length, 8, 'eligible rows past browse\'s 200-row page must be reached');
  assert.ok(locked.every(row => row.instrumental && Number(row.id.slice(4)) >= 280));
});

test('retag embeds the same malformed-span classification as the bulk path', async () => {
  const id = 'retag-malformed';
  db.upsertTrackMeta(id, song(id));
  requireDb().prepare('UPDATE tracks SET vocal_ranges_json = ? WHERE id = ?')
    .run('[{}, {"startMs":0,"endMs":3000}]', id);
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await settings.update({
    llm: { provider: 'openai-compatible', model: 'fixture', compatibleMode: 'local', baseUrl },
    embedding: { enabled: true, provider: 'openai-compatible', model: 'fixture',
      providerBaseUrls: { 'openai-compatible': baseUrl }, enrichment: { lastfmTags: false, lyrics: false, originalYear: false } },
  });
  embeddingInputs.length = 0;
  const response = await fetch(`http://127.0.0.1:${address.port}/library/retag`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('test:test').toString('base64')}` },
    body: JSON.stringify(song(id)), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(embeddingInputs.length, 1, 'the real retag route must submit an embedding');
  assert.doesNotMatch(embeddingInputs[0], /instrumental/, 'clean timing spans must retain their invalid-span evidence');
});
