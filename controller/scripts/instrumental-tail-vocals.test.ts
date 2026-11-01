// The instrumental verdict reads both measured windows. A song whose vocals begin
// after the 40s head window read as instrumental, even with singing measured in
// its tail. The rule is max(head, tail) < tolerance, in lyric-vocal.isInstrumental
// only, and the SQL scalar has to agree with it on the same stored inputs.
//
// Run: npm test -- instrumental-tail-vocals

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import { chatCompletion } from './test-utils/llm.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-tail-vocals-'));
const song = (id: string) => ({ id, title: id, artist: `Artist ${id}`, album: `Album ${id}`, genre: 'Ambient', duration: 240 });

let subsonicSongs: ReturnType<typeof song>[] = [];
const embeddingInputs: string[] = [];
const offered: Array<Record<string, unknown>[]> = [];
const vector = (dim: number) => Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));

const app = express();
app.use(express.json());
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/library/') || url.pathname.startsWith('/dj/')) return app(req, res);
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
    if (url.pathname.endsWith('/chat/completions')) {
      const user = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
      let payload: { candidates?: Array<Record<string, unknown>> } | null = null;
      try { payload = JSON.parse(String(user).split('\n\n')[0]); } catch { /* the tagger's prompt */ }
      if (payload?.candidates) offered.push(payload.candidates);
      const args = payload?.candidates
        ? { id: payload.candidates[0].id, reason: 'Test choice' }
        : { results: [{ moods: ['calm'], energy: 'low' }] };
      return json(chatCompletion({
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool', type: 'function',
          function: { name: body.tool_choice?.function?.name ?? body.tools?.[0]?.function?.name ?? 'emit', arguments: JSON.stringify(args) } }] },
      }));
    }
    const inputs = z.array(z.string()).parse(body.input);
    embeddingInputs.push(...inputs);
    return json({
      object: 'list', model: 'fixture',
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: vector(textDim) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: subsonicSongs } }
    : endpoint === 'getStarred2' ? { starred2: { song: [] } }
      : endpoint === 'search3' ? { searchResult3: { song: subsonicSongs } }
        : endpoint === 'getSong' ? { song: subsonicSongs[0] }
          : {};
  json({ 'subsonic-response': { status: 'ok', ...data } });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
const authHeaders = { authorization: `Basic ${Buffer.from('test:test').toString('base64')}` };

process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = baseUrl;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
process.env.ANALYZE_URL = baseUrl;
process.env.LIQUIDSOAP_HOST = 'tail-vocals-mixer.invalid';
writeFileSync(join(root, 'likes.json'), JSON.stringify({
  secret: 'test-secret',
  likes: [{
    songId: 'reported', track: { id: 'reported', title: 'reported' }, airingKey: 'reported|operator',
    listenerKey: 'operator', likedAt: '2026-01-01T00:00:00.000Z', via: 'operator',
  }],
}));

const db = await import('../src/music/library-db.js');
const { requireDb, SQL_TAIL_VOCAL_RANGES } = await import('../src/music/library-db/handle.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const {
  isInstrumental, instrumentalFromJson, parseOutroVocalJson, parseTailVocalRangesJson, parseVocalRangesJson,
  INSTRUMENTAL_VOCAL_TOLERANCE_MS,
} = await import('../src/music/lyric-vocal.js');
const { trackInstrumental, preferVocals, onlyVocals } = await import('../src/music/show-filter.js');
const { soundDescriptors, formatTrackText, EMBED_TEXT_VERSION, resolveIndexTextFormat } = await import('../src/music/embeddings.js');
const { phaseEmbed } = await import('../src/music/tag-library/embed.js');
const { buildCandidatePool } = await import('../src/music/playlist-gen.js');
const { publicSimilarTrack } = await import('../src/util/similar-tracks.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { queue } = await import('../src/broadcast/queue.js');
const { vocalRunwayMs } = await import('../src/broadcast/vocal-runway.js');
const { router: djRoutes } = await import('../src/routes/dj.js');
const { router: browseRoutes } = await import('../src/routes/library/browse.js');
const { router: maintenanceRoutes } = await import('../src/routes/library/maintenance.js');
app.use(djRoutes, browseRoutes, maintenanceRoutes);
await settings.load();
await library.load();
const textDim = db.getEmbeddingDim() ?? 768;

const tail = (startMs: number, ms: number) => ({ startMs, endMs: startMs + ms });
const sung = [tail(200_000, 15_000)];
const bleed = [tail(200_000, 2_961)];
const headBleed = [tail(1_207, 2_961)];
const outro = (vocalRanges?: unknown) => JSON.stringify({
  startMs: 180_000, ending: 'fade', lufs: -14, bpm: 120, beats: [180_000, 180_500], bars: [180_000],
  ...(vocalRanges === undefined ? {} : { vocalRanges }),
});

// One stored row per input, each fed to JS and to SQL unchanged. `head` and
// `outro` are the raw column text, because the readers parse them differently.
const fixtures: Array<{ id: string; head: string | null; outro: string | null; expected: boolean | null }> = [
  // The reported bug, and its siblings.
  { id: 'reported', head: '[]', outro: outro(sung), expected: false },
  { id: 'bleed-then-sung', head: JSON.stringify(headBleed), outro: outro(sung), expected: false },
  { id: 'tail-only-sung', head: null, outro: outro(sung), expected: false },
  // A max, not a sum: 2.9s of bleed in each window is 5.9s together.
  { id: 'bleed-in-both', head: JSON.stringify(headBleed), outro: outro(bleed), expected: true },
  // Equality stays vocal in the tail exactly as in the head.
  { id: 'tail-at-tolerance', head: '[]', outro: outro([tail(200_000, INSTRUMENTAL_VOCAL_TOLERANCE_MS)]), expected: false },
  { id: 'tail-under-tolerance', head: '[]', outro: outro([tail(200_000, INSTRUMENTAL_VOCAL_TOLERANCE_MS - 1)]), expected: true },
  { id: 'split-tail', head: '[]', outro: outro([tail(200_000, 2_500), tail(210_000, 2_500)]), expected: false },
  // Unknown stays unknown.
  { id: 'nothing-measured', head: null, outro: null, expected: null },
  { id: 'unknown-no-tail-key', head: null, outro: outro(), expected: null },
  { id: 'unknown-tail-null', head: null, outro: outro(null), expected: null },
  { id: 'unknown-tail-empty', head: null, outro: outro([]), expected: null },
  { id: 'unknown-tail-bleed', head: null, outro: outro(bleed), expected: null },
  // Head measured, tail absent: today's answer.
  { id: 'head-empty-no-outro', head: '[]', outro: null, expected: true },
  { id: 'head-empty-no-tail-key', head: '[]', outro: outro(), expected: true },
  { id: 'head-empty-tail-null', head: '[]', outro: outro(null), expected: true },
  { id: 'head-empty-tail-empty', head: '[]', outro: outro([]), expected: true },
  { id: 'head-sung-no-tail', head: JSON.stringify([tail(1_000, 20_000)]), outro: null, expected: false },
  { id: 'head-sung-tail-empty', head: JSON.stringify([tail(1_000, 20_000)]), outro: outro([]), expected: false },
  // A bad tail span stays vocal, the head's posture.
  { id: 'tail-bad-span', head: '[]', outro: outro([{}]), expected: false },
  { id: 'tail-mixed-span', head: '[]', outro: outro([...bleed, {}]), expected: false },
  { id: 'tail-string-span', head: '[]', outro: outro([{ startMs: '200000', endMs: '203000' }]), expected: false },
  { id: 'tail-negative-span', head: '[]', outro: outro([{ startMs: -1000, endMs: 2000 }]), expected: false },
  { id: 'unknown-tail-bad-span', head: null, outro: outro([{}]), expected: false },
  { id: 'head-bad-span-tail-empty', head: '[{}]', outro: outro([]), expected: false },
  // Unreadable is no evidence, the head's other posture. None of these may throw
  // a bulk read, and a JSON string holding an array is still not spans.
  { id: 'tail-object', head: '[]', outro: outro({}), expected: true },
  { id: 'tail-string', head: '[]', outro: outro('sung'), expected: true },
  { id: 'tail-array-text', head: '[]', outro: outro(JSON.stringify(sung)), expected: true },
  { id: 'unknown-tail-array-text', head: null, outro: outro(JSON.stringify(sung)), expected: null },
  { id: 'outro-broken', head: '[]', outro: '{"startMs":', expected: true },
  { id: 'unknown-outro-broken', head: null, outro: 'broken json', expected: null },
  { id: 'outro-array', head: '[]', outro: '[1,2]', expected: true },
  // parseOutroJson rejects this outro for its ending, and the spans still count.
  { id: 'outro-bad-ending', head: '[]', outro: JSON.stringify({ startMs: 1, ending: 'odd', vocalRanges: sung }), expected: false },
];

const seed = (id: string, head: string | null, outroJson: string | null) => {
  db.upsertTrackMeta(id, song(id));
  db.upsertTrackTags(id, { moods: ['focus'], energy: 'low', source: 'manual' });
  requireDb().prepare('UPDATE tracks SET vocal_ranges_json = ?, outro_json = ? WHERE id = ?').run(head, outroJson, id);
};
for (const f of fixtures) seed(f.id, f.head, f.outro);
const scalar = (id: string) => (requireDb()
  .prepare(`SELECT is_instrumental(vocal_ranges_json, ${SQL_TAIL_VOCAL_RANGES}) AS v FROM tracks WHERE id = ?`)
  .get(id) as { v: number | null }).v;
const asNumber = (v: boolean | null) => (v == null ? null : Number(v));
const raw = (ids: string[]) => ids.map(song);

before(async () => {
  // A track that plays through every consumer alongside the reported one.
  seed('true-instrumental', JSON.stringify(headBleed), outro(bleed));
  seed('head-sung', JSON.stringify([tail(1_000, 20_000)]), outro([]));
  for (const id of ['reported', 'true-instrumental', 'head-sung']) db.upsertTrackAudioVector(id, vector(512));
  await settings.update({
    likes: { enabled: true, influenceDj: true },
    llm: { provider: 'openai-compatible', model: 'fixture', compatibleMode: 'local', baseUrl: `${baseUrl}/v1`,
      apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0 },
    embedding: { enabled: true, provider: 'openai-compatible', model: 'fixture',
      providerBaseUrls: { 'openai-compatible': `${baseUrl}/v1` },
      enrichment: { lastfmTags: false, lyrics: false, originalYear: false } },
  } as never);
});
after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(root);
});

test('the verdict is max(head, tail) < tolerance, with unknown kept distinct', () => {
  const head = (ms: number) => [tail(1_000, ms)];
  const verdict = (vocalRanges: unknown[] | null | undefined, tailVocalRanges: unknown[] | null | undefined) =>
    isInstrumental({ vocalRanges, tailVocalRanges });
  assert.equal(verdict([], sung), false, 'singing past the head window is vocal');
  assert.equal(verdict(null, sung), false, 'an unmeasured head with a sung tail is measured vocal');
  assert.equal(verdict(undefined, sung), false);
  assert.equal(verdict(null, bleed), null, 'tail bleed alone says nothing about the head');
  assert.equal(verdict(null, []), null);
  assert.equal(verdict(null, null), null);
  assert.equal(verdict(undefined, undefined), null);
  assert.equal(verdict(head(4_999), [tail(200_000, 4_999)]), true, 'each window is judged alone, never summed');
  assert.equal(verdict(head(5_000), []), false, 'equality stays vocal in the head');
  assert.equal(verdict([], [tail(200_000, 5_000)]), false, 'equality stays vocal in the tail');
  assert.equal(verdict([], [tail(200_000, 4_999)]), true);
  assert.equal(isInstrumental(null), null);
  assert.equal(isInstrumental(undefined), null);
  assert.equal(isInstrumental({}), null);
  assert.equal(isInstrumental({ vocalRanges: [], tailVocalRangesInvalid: true }), false, 'a bad tail span never grants eligibility');
  assert.equal(isInstrumental({ tailVocalRangesInvalid: true }), false);
  assert.equal(isInstrumental({ vocalRanges: [], tailVocalRanges: [{}] }), false);
  assert.equal(isInstrumental({ vocalRanges: [], vocalRangesInvalid: true, tailVocalRanges: [] }), false);
});

test('only one direction can change: a tail moves a verdict toward vocal, never away from it', () => {
  const heads: unknown[][] = [[], headBleed, [tail(0, 4_999)], [tail(0, 5_000)], [tail(1_000, 20_000)], [{}]];
  const tails: Array<unknown[] | null | undefined> = [undefined, null, [], bleed, [tail(0, 4_999)], [tail(0, 5_000)], sung, [{}]];
  for (const vocalRanges of [null, undefined, ...heads]) {
    for (const invalid of [false, true]) {
      const today = isInstrumental({ vocalRanges, vocalRangesInvalid: invalid });
      for (const tailVocalRanges of tails) {
        for (const tailVocalRangesInvalid of [false, true]) {
          const next = isInstrumental({ vocalRanges, vocalRangesInvalid: invalid, tailVocalRanges, tailVocalRangesInvalid });
          const context = JSON.stringify({ vocalRanges, invalid, tailVocalRanges, tailVocalRangesInvalid });
          assert.ok(next === today || next === false, `${today} moved to ${next}: ${context}`);
          assert.ok(today !== false || next === false, `a vocal verdict moved: ${context}`);
        }
      }
      // No tail evidence at all leaves today's answer byte for byte.
      for (const tailVocalRanges of [undefined, null, [], bleed]) {
        assert.equal(isInstrumental({ vocalRanges, vocalRangesInvalid: invalid, tailVocalRanges }), today);
      }
    }
  }
});

test('JS and SQL give the same answer on the same stored inputs', () => {
  for (const f of fixtures) {
    const want = asNumber(f.expected);
    assert.equal(scalar(f.id), want, `${f.id}: SQL scalar`);
    assert.equal(asNumber(isInstrumental(db.getTrack(f.id))), want, `${f.id}: JS over the record`);
    assert.equal(asNumber(isInstrumental({ ...parseVocalRangesJson(f.head), ...parseOutroVocalJson(f.outro) })), want, `${f.id}: JS over the columns`);
    const spans = requireDb().prepare(`SELECT ${SQL_TAIL_VOCAL_RANGES} AS tail FROM tracks WHERE id = ?`).get(f.id) as { tail: string | null };
    assert.equal(instrumentalFromJson(f.head, spans.tail), want, `${f.id}: the scalar's JS body`);
    assert.deepEqual(parseTailVocalRangesJson(spans.tail), parseOutroVocalJson(f.outro), `${f.id}: both tail readers`);
  }
});

test('a one-argument SQL call fails instead of quietly dropping the tail', () => {
  assert.throws(() => requireDb().prepare('SELECT is_instrumental(vocal_ranges_json) FROM tracks').all(), /wrong number of arguments/);
});

test('every row reader carries the tail evidence, and no bulk read throws on a bad outro', () => {
  const sampled = new Map(db.allTaggedSampled(10_000, 10_000).map(row => [row.id, row.vocal]));
  const tagged = new Map(db.allTagged().map(row => [row.id, row.vocal]));
  const energyRows = new Map(db.songsByEnergy('low').map(row => [row.id, row]));
  const slimRows = new Map(library.songsByEnergy('low').map((row: { id: string }) => [row.id, row]));
  const candidates = new Map(db.candidateFilterTracks().map(row => [row.id, row]));
  const mode = (v: boolean | null) => (v == null ? null : v ? 'instrumental' : 'vocal');
  for (const f of fixtures) {
    assert.equal(tagged.get(f.id), mode(f.expected), `${f.id}: Observatory`);
    assert.equal(sampled.get(f.id), mode(f.expected), `${f.id}: sampled Observatory`);
    for (const [reader, row] of [
      ['getTrack', db.getTrack(f.id)],
      ['library.get', library.get(f.id)],
      ['slimById', library.slimById(f.id)],
      ['energy pool', energyRows.get(f.id)],
      ['library energy pool', slimRows.get(f.id)],
      ['browse row', db.filter({ q: f.id, limit: 200 }).rows.find(row => row.id === f.id)],
      ['diagnostic', candidates.get(f.id)],
    ] as const) {
      assert.ok(row, `${f.id}: ${reader}`);
      assert.equal(isInstrumental(row), f.expected, `${f.id}: ${reader}`);
    }
    assert.equal(library.filter({ q: f.id, limit: 200 }).rows.find(row => row.id === f.id)?.instrumental, f.expected, `${f.id}: library.filter`);
    for (const vocal of ['instrumental', 'vocal'] as const) {
      const want = f.expected === (vocal === 'instrumental');
      assert.equal(db.filter({ q: f.id, vocal, limit: 200 }).rows.some(row => row.id === f.id), want, `${f.id}: SQL ${vocal} filter`);
    }
  }
});

test('the tail evidence arrives late: a backfill write moves the verdict everywhere', () => {
  const id = 'backfilled';
  seed(id, '[]', outro());
  assert.equal(trackInstrumental({ id }), true);
  db.writeFacetResults(id, { vocal: { vocalRanges: [], tailVocalRanges: sung }, source: 'full' });
  assert.equal(trackInstrumental({ id }), false);
  assert.equal(scalar(id), 0);
  assert.equal(db.filter({ q: id, vocal: 'instrumental' }).total, 0);
  assert.equal(db.allTagged().find(row => row.id === id)?.vocal, 'vocal');
});

test('show filters: trackInstrumental, preferVocals and onlyVocals read the tail', () => {
  const rows = db.candidateFilterTracks().filter(row => ['reported', 'true-instrumental', 'tail-only-sung'].includes(row.id));
  for (const t of [...rows, ...library.songsByEnergy('low').filter((row: { id: string }) => row.id === 'reported')]) {
    assert.equal(trackInstrumental(t), t.id === 'true-instrumental', t.id);
  }
  assert.equal(trackInstrumental(song('reported')), false, 'a raw Subsonic child falls back to the library row');
  assert.equal(trackInstrumental(song('tail-only-sung')), false, 'an unmeasured head falls back too');
  assert.equal(trackInstrumental(song('unknown-tail-bleed')), null);
  const ids = (list: Array<{ id?: string }>) => list.map(row => row.id).sort();
  assert.deepEqual(ids(onlyVocals(rows, 'instrumental')), ['true-instrumental']);
  assert.deepEqual(ids(onlyVocals(rows, 'vocal')), ['reported', 'tail-only-sung']);
  assert.deepEqual(ids(preferVocals(rows, 'instrumental')), ['true-instrumental']);
  assert.deepEqual(ids(preferVocals(raw(['reported', 'unknown-tail-bleed']), 'instrumental')), ['unknown-tail-bleed'],
    'an unknown stays eligible, a tail-sung raw child does not');
});

test('playlist generation: the library filter, slim rows and Subsonic rows all see the tail', async () => {
  subsonicSongs = raw(['reported', 'tail-only-sung', 'true-instrumental', 'unknown-tail-bleed', 'head-sung']);
  const { pool } = await buildCandidatePool({ knobs: { instrumentalOnly: true } });
  const ids = pool.map(t => t.id);
  assert.ok(!ids.includes('reported'), 'head-instrumental tail-sung track must not reach an instrumental playlist');
  assert.ok(!ids.includes('tail-only-sung'));
  assert.equal(pool.find(t => t.id === 'true-instrumental')?.instrumental, true);
  assert.equal(pool.find(t => t.id === 'unknown-tail-bleed')?.instrumental, null, 'unknown stays unknown and stays in');
  assert.equal(pool.find(t => t.id === 'head-sung')?.instrumental, null,
    'a head-sung Subsonic row keeps its pre-existing unknown: the fill is tail evidence only');

  subsonicSongs = [];
  const fromVector = await buildCandidatePool({ prompt: 'ambient' });
  assert.equal(fromVector.pool.find(t => t.id === 'reported')?.instrumental, false, 'norm() reads a slim row');
  assert.equal(fromVector.pool.find(t => t.id === 'true-instrumental')?.instrumental, true);

  const byMood = await buildCandidatePool({ knobs: { moods: ['focus'], instrumentalOnly: true } });
  assert.ok(!byMood.pool.some(t => t.id === 'reported'), 'a mood row carries no vocal evidence, so it is filled');
  assert.ok(byMood.pool.some(t => t.id === 'true-instrumental'));
});

test('embed text: the Sound line drops the word for a tail-sung track, through both writers', async () => {
  const text = (id: string) => {
    const t = db.getTrack(id)!;
    return formatTrackText({ title: t.title, artist: t.artist }, null, t);
  };
  assert.doesNotMatch(text('reported'), /instrumental/);
  assert.match(text('true-instrumental'), /Sound: instrumental/);
  assert.deepEqual(soundDescriptors({ vocalRanges: [], tailVocalRanges: sung }), []);
  assert.deepEqual(soundDescriptors({ vocalRanges: [], tailVocalRanges: [] }), ['instrumental']);
  assert.deepEqual(soundDescriptors({ vocalRanges: [], tailVocalRangesInvalid: true }), []);
  assert.deepEqual(soundDescriptors({ vocalRanges: [] }), ['instrumental'], 'no tail evidence: unchanged text');

  embeddingInputs.length = 0;
  await phaseEmbed(['reported', 'true-instrumental'], 8, 'plain');
  const bulk = (name: string) => embeddingInputs.find(input => input.includes(`Artist ${name}`));
  assert.doesNotMatch(String(bulk('reported')), /Sound: .*instrumental/, 'phaseEmbed passes the tail evidence');
  assert.match(String(bulk('true-instrumental')), /Sound: .*instrumental/);

  embeddingInputs.length = 0;
  const response = await fetch(`${baseUrl}/library/retag`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify(song('reported')), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(embeddingInputs.length, 1, 'the retag route must submit an embedding');
  assert.doesNotMatch(embeddingInputs[0], /Sound: .*instrumental/, 'retag passes the same evidence as the bulk path');
});

test('a changed Sound line bumps the text format, so old vectors read as stale', () => {
  assert.equal(EMBED_TEXT_VERSION, 4);
  assert.equal(resolveIndexTextFormat(3, 20_000), 3, 'a v3 index keeps its format until it is re-embedded');
  assert.equal(resolveIndexTextFormat(3, 20_000, true), EMBED_TEXT_VERSION);
});

test('payloads and routes carry the verdict and never the evidence', async () => {
  subsonicSongs = raw(['reported']);
  const similar = publicSimilarTrack(library.slimById('reported'));
  assert.equal(similar.instrumental, false, 'public similar-tracks row');
  assert.ok(!Object.keys(similar).some(key => /vocal/i.test(key)));

  const [agent] = buildPickerContext(pickerScope()).collect([song('reported')]);
  assert.equal(agent.instrumental, false, 'agent picker, raw child');
  assert.ok(!Object.keys(agent).some(key => /vocal/i.test(key)), 'the model sees the verdict, not the spans');
  const [slimRow] = buildPickerContext(pickerScope()).collect([library.slimById('reported')]);
  assert.equal(slimRow.instrumental, false, 'agent picker, library row');

  const q = Object.create(queue);
  Object.assign(q, { current: null, upcoming: [], history: [], _recentPlays: [], log: () => {} });
  clearPoolCache();
  offered.length = 0;
  await pickViaPool(q, { dominantMood: null, activeShow: null });
  const candidate = offered.flat().find(row => row.id === 'reported');
  assert.ok(candidate, 'the pool picker offered the track');
  assert.equal(candidate.instrumental, false, 'pool picker payload');
  assert.ok(!Object.keys(candidate).some(key => /vocal/i.test(key)));

  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  };
  const search = await get('/dj/search?q=reported');
  assert.equal(search.songs?.[0]?.instrumental ?? search.results?.[0]?.instrumental, false, '/dj/search');
  const browse = await get('/library/browse?q=reported');
  assert.equal(browse.rows?.find((row: { id: string }) => row.id === 'reported')?.instrumental, false, '/library/browse');
  const liked = await get('/library/liked');
  assert.equal(liked.rows?.find((row: { id: string }) => row.id === 'reported')?.instrumental, false, '/library/liked');
  const sound = await get('/library/search-sound?q=ambient');
  assert.equal(sound.results?.find((row: { id: string }) => row.id === 'reported')?.instrumental, false, '/library/search-sound');
});

test('timing rules keep reading their own spans', () => {
  const stored = db.getTrack('reported')!;
  assert.deepEqual(stored.vocalRanges, [], 'the head spans are not rewritten');
  assert.deepEqual(stored.outro?.vocalRanges, sung, 'the timing tail spans are unchanged');
  assert.equal(vocalRunwayMs({ id: 'reported' }), Infinity, 'an instrumental head keeps its full talk-over runway');
  assert.equal(vocalRunwayMs({ id: 'tail-only-sung' }), null, 'an unmeasured head stays unmeasured for timing');
  const rejected = db.getTrack('outro-bad-ending')!;
  assert.equal(rejected.outro, null, 'parseOutroJson still rejects a bad ending for timing');
  assert.deepEqual(rejected.tailVocalRanges, sung, 'the verdict reads the raw key');
});

// Last in the file: it swaps a built-in on the shared connection. outro_json sits
// past the beat grids, so reading it for every row is a full scan of the wide rows
// (#1937), and the tail can never change a verdict the head already made vocal.
test('a filter scan never reads the outro of a row the head already calls vocal', () => {
  const headVocal = outro([tail(200_000, 1_234)]);
  seed('settled-by-head', JSON.stringify([tail(1_000, 20_000)]), headVocal);
  const read: string[] = [];
  requireDb().function('json_valid', (text: string | null) => {
    if (text != null) read.push(text);
    try { JSON.parse(String(text)); return 1; } catch { return 0; }
  });
  for (const vocal of ['instrumental', 'vocal'] as const) {
    read.length = 0;
    db.filter({ vocal, limit: 200 });
    assert.ok(read.includes(outro(sung)), `${vocal}: a row the head left open is read`);
    assert.ok(!read.includes(headVocal), `${vocal}: a row the head settled is not`);
  }
  assert.equal(db.filter({ q: 'settled-by-head', vocal: 'vocal' }).total, 1);
});
