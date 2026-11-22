// #2236. Phase 1 embeds a new track and phase 5 analyses it, so its first vector has
// no Sound: line. Each writer of that line's words (music/sound-line.ts) now marks
// the vector when it moves them away from the words the vector was built from, and
// a forward tag run's trailing phaseEmbed([]) replaces just those rows. A real
// SQLite database and the real phaseEmbed, analysis pass and mood pass, with only
// the HTTP edges faked (the embedding endpoint, the analyzer sidecar, the Navidrome
// stream), because what matters here is which rows get paid for.
//
// One station grows through the tests, which node:test runs in file order: 200
// analysed tracks calibrate the mood pass first, so a later pass labels new tracks
// through its incremental branch, as on a real library.
//
// Run: npm test -- sound-line-vectors

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-sound-line-'));

const DIM = 8;
const textVector = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

// Deterministic unit vectors: a track's CLAP vector and a prompt's text vector are
// the same every time they are asked for, so a re-analyze is identical.
function seededVector(seed: string): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < 512; i++) {
    const h = crypto.createHash('sha256').update(`${seed}#${i}`).digest();
    for (let b = 0; b + 4 <= h.length && out.length < 512; b += 4) {
      out.push(h.readInt32LE(b) / 2 ** 31);
    }
  }
  const n = Math.hypot(...out);
  return out.map((x) => x / n);
}

const embedded: string[] = [];
// The analyzer's head answer per track; anything unlisted is upbeat and minor.
const heads = new Map<string, { bpm: number; key: string }>();
const DEFAULT_HEAD = { bpm: 124, key: '8A' };
// Runs while an embedding request is in flight, before it is answered.
let duringEmbed: (() => void) | null = null;
// Runs at the first analyze request of a pass: after a --re-analyze's clear,
// before any track is written again.
let duringAnalyze: (() => void) | null = null;

const requestSchema = z.object({ path: z.string().optional(), url: z.string().optional(), embed: z.boolean().optional() });
function trackIdOf(r: z.infer<typeof requestSchema>): string {
  if (r.path) return decodeURIComponent(r.path.split('/').pop()!.replace(/\.audio$/, ''));
  return new URL(r.url!).searchParams.get('id') ?? '';
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const json = (body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.url?.startsWith('/v1/embeddings')) {
    const inputs = z.array(z.string()).parse(JSON.parse(raw).input);
    embedded.push(...inputs);
    const hook = duringEmbed;
    duringEmbed = null;
    hook?.();
    return json({
      object: 'list', model: 'fixture',
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: textVector })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  if (req.url?.startsWith('/health')) {
    return json({ ok: true, engines: ['analyze'], analyze_audio_capable: true, analyze_text_capable: true });
  }
  if (req.url?.startsWith('/embed-text')) {
    const { texts } = z.object({ texts: z.array(z.string()) }).parse(JSON.parse(raw));
    return json({ ok: true, embeddings: texts.map(seededVector) });
  }
  if (req.url?.startsWith('/analyze')) {
    const hook = duringAnalyze;
    duringAnalyze = null;
    hook?.();
    const r = requestSchema.parse(JSON.parse(raw));
    const id = trackIdOf(r);
    const head = heads.get(id) ?? DEFAULT_HEAD;
    return json({
      ok: true, bpm: head.bpm, key: head.key, intro_ms: 1000, confidence: 0.9,
      loudness_lufs: -10, peak_db: -1, tail_silence_ms: 1500, tail_start_ms: 200_000,
      outro: { startMs: 190_000, ending: 'fade' },
      ...(r.embed ? { audio_embedding: seededVector(id) } : {}),
    });
  }
  // Navidrome's stream: a few bytes of "audio".
  res.setHeader('content-type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;

process.env.STATE_DIR = root;
process.env.ANALYZE_URL = baseUrl;
process.env.NAVIDROME_URL = baseUrl;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const { formatTrackText, soundWords, trackAcoustics } = await import('../src/music/embeddings.js');
const { phaseEmbed } = await import('../src/music/tag-library/embed.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const { runAudioMoodPass } = await import('../src/music/audio-moods.js');
const { isInstrumental } = await import('../src/music/lyric-vocal.js');

const open = () => db.open({ embeddingDim: DIM, adoptStoredDim: true });
await settings.load();
await open();

before(async () => {
  await settings.update({
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

const addTrack = (id: string) =>
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${id}`, album: 'Album', year: 1999, genres: ['House'], duration: 240 });
// The text phaseEmbed would build from the row now.
function textOf(id: string): string {
  const t = db.getTrack(id)!;
  return formatTrackText(
    { title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres, eraYear: 1999 },
    { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
    trackAcoustics(t),
  );
}
const builtFrom = (id: string) =>
  (db.requireDb().prepare('SELECT text_vector_sound AS s FROM tracks WHERE id = ?').get(id) as { s: string | null }).s;
const dirty = () => db.textVectorDirtyIds().sort();
const drain = () => embedded.splice(0);
// Phase 5 of a tag run, and the trailing re-embed after it.
const analyse = (opts: { reAnalyze?: boolean } = {}) =>
  runAnalysisPass({ audioBackfill: true, vocalBackfill: false, ...opts });
const reembedMarked = () => phaseEmbed([], 8, 'plain');

const fresh = ['new-a', 'new-b', 'new-c'];

test('a new track embeds once more after its analysis, then never again', async () => {
  // The station as it stands: analysed, with a calibrated mood pass behind it.
  for (let i = 0; i < 200; i++) addTrack(`lib-${String(i).padStart(3, '0')}`);
  const first = await analyse();
  assert.equal(first.analyzed, 200);
  assert.deepEqual(db.idsNeedingAudioMoods(), []);

  // A tag run finds three new tracks: phase 1 embeds them before phase 5 measures them.
  for (const id of fresh) addTrack(id);
  await phaseEmbed(fresh, 8, 'plain');
  const thin = drain();
  assert.equal(thin.length, 3);
  assert.ok(thin.every(t => !t.includes('Sound:')), 'no Sound: line yet');
  assert.deepEqual(JSON.parse(builtFrom('new-a')!), { moods: [], measured: [] }, 'built from no words');

  await analyse();
  assert.ok(fresh.every(id => textOf(id).includes('\nSound: ')), 'phase 5 gave them a Sound: line');
  assert.ok(fresh.every(id => db.getTrack(id)!.audioMoods.length > 0), 'the incremental mood branch labelled them');
  assert.deepEqual(dirty(), fresh, 'each new vector is marked, and nothing else');

  await reembedMarked();
  const full = drain();
  assert.deepEqual(full.sort(), fresh.map(textOf).sort(), 'one more embed each, from the analysed row');
  assert.ok(full.every(t => /\nSound: .+, upbeat tempo, minor key/.test(t)), 'moods and measured words both');
  assert.deepEqual(JSON.parse(builtFrom('new-a')!), soundWords(trackAcoustics(db.getTrack('new-a')!)));
  assert.deepEqual(dirty(), []);

  // Never again: nothing changed, so another tag run pays for nothing.
  await reembedMarked();
  await phaseEmbed(fresh, 8, 'plain');
  await analyse();
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');
});

test('an identical re-analyze embeds nothing, and a real change embeds only its row', async () => {
  const before = fresh.map(textOf);
  // clearAnalysis wipes bpm, key, the tail and the moods; each track's write puts the
  // measured words back, and the mood pass relabels every row after the whole pass.
  const stats = await analyse({ reAnalyze: true });
  assert.equal(stats.analyzed, 203);
  assert.deepEqual(fresh.map(textOf), before, 'the same text');
  assert.deepEqual(dirty(), [], 'nothing marked');
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');

  // A re-analyze whose words really change marks those rows, and only those.
  heads.set('new-b', { bpm: 70, key: '8B' });
  await analyse({ reAnalyze: true });
  assert.deepEqual(dirty(), ['new-b']);
  await reembedMarked();
  const moved = drain();
  assert.equal(moved.length, 1);
  assert.match(moved[0], /\nSound: .+, slow tempo, major key/);
  heads.delete('new-b');
});

test('a relabel-all embeds nothing, though it changes every label', async () => {
  const before = fresh.map(textOf);
  // A prompt edit changes the vocabulary hash: a full re-score, and every track's
  // labels are re-derived. Same names, so nothing that uses a mood is orphaned.
  const vocab = settings.get().moods;
  await settings.update({
    moods: vocab.map(m => ({ ...m, clapPrompt: `${m.clapPrompt || m.name} with strings` })),
  } as never);
  const stats = await runAudioMoodPass();
  assert.equal(stats.scored, 203, 'the whole library re-scored');
  assert.notDeepEqual(fresh.map(textOf), before, 'the rows\' text moved');
  assert.deepEqual(dirty(), [], 'nothing marked');
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');
  await settings.update({ moods: vocab } as never);
  await runAudioMoodPass();
  assert.deepEqual(dirty(), []);
});

test('an identical re-analyze after a relabel-all embeds nothing', async () => {
  // A settled station: every analysed track has a vector built from its row as the
  // analyzer measures it now (new-b's tempo went back after the test above).
  await analyse({ reAnalyze: true });
  await phaseEmbed(db.analysedIds(), 8, 'plain');
  drain();
  assert.deepEqual(dirty(), []);
  const labels = () => new Map(db.analysedIds().map(id => [id, db.getTrack(id)!.audioMoods.join(',')]));
  const before = labels();
  // A vocabulary edit relabels every row and marks none, so the vectors keep the
  // mood words they were built from. A re-analyze then clears the moods, and its
  // mood pass relabels every row through the incremental branch: compared with
  // those words, each row the edit moved would mark, and the next tag run would
  // re-embed the library.
  const vocab = settings.get().moods;
  await settings.update({
    moods: vocab.map(m => ({ ...m, clapPrompt: `${m.clapPrompt || m.name} at dusk` })),
  } as never);
  await runAudioMoodPass();
  const after = labels();
  const moved = [...after].filter(([id, l]) => before.get(id) !== l).length;
  assert.ok(moved > 50, `the edit moved most labels (${moved})`);
  assert.deepEqual(dirty(), [], 'the relabel marks nothing');

  await analyse({ reAnalyze: true });
  assert.deepEqual(labels(), after, 'the same labels');
  assert.deepEqual(dirty(), [], 'nothing marked');
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');

  await settings.update({ moods: vocab } as never);
  await runAudioMoodPass();
  assert.deepEqual(dirty(), []);
});

test('moods that land after their vector mark it once, with no measured change', async () => {
  // Analysed without CLAP and embedded with its measured words; the audio backfill
  // brings the CLAP vector later, so only the mood pass's incremental write moves
  // its words.
  addTrack('late-moods');
  db.upsertTrackAnalysis('late-moods', { bpm: 124, musicalKey: '8A', source: 'full' });
  await phaseEmbed(['late-moods'], 8, 'plain');
  assert.match(drain()[0], /\nSound: upbeat tempo, minor key$/m);

  await analyse();
  assert.ok(db.getTrack('late-moods')!.audioMoods.length > 0, 'the incremental mood branch labelled it');
  assert.deepEqual(dirty(), ['late-moods']);
  await reembedMarked();
  const once = drain();
  assert.equal(once.length, 1);
  assert.match(once[0], /\nSound: .+, upbeat tempo, minor key$/m);
  await reembedMarked();
  assert.deepEqual(drain(), [], 'then never again');
});

test('a late tail measurement that removes "instrumental" embeds once', async () => {
  addTrack('tail');
  db.upsertTrackAnalysis('tail', { bpm: 124, musicalKey: '8A', vocalRanges: [], source: 'full' });
  await phaseEmbed(['tail'], 8, 'plain');
  assert.match(drain()[0], /\nSound: upbeat tempo, minor key, instrumental/);

  // The tail facet arrives later and finds 15 s of singing in the outro.
  db.writeFacetResults('tail', {
    source: 'full',
    tail: {
      outro: { startMs: 180_000, ending: 'fade', vocalRanges: [{ startMs: 200_000, endMs: 215_000 }] } as never,
      tailSilenceMs: null, tailStartMs: null,
    },
  });
  assert.deepEqual(dirty(), ['tail']);
  await reembedMarked();
  const once = drain();
  assert.equal(once.length, 1);
  assert.match(once[0], /\nSound: upbeat tempo, minor key$/m);
  await reembedMarked();
  assert.deepEqual(drain(), [], 'then never again');
});

// #2237: the head's vocal rule changed (vocal facet v2), so `--facets vocal`
// re-measures rows taken at v1. Bleed that v1 read as 26 s of singing comes
// back empty, and the vector gains "instrumental" through the same mark as any
// other measured word; a re-measure that agrees marks nothing.
test('a vocal re-measure under the new head rule marks only a moved verdict', async () => {
  const outro = { startMs: 220_000, ending: 'cold', vocalRanges: [] } as never;
  for (const id of ['bleed', 'singer']) {
    addTrack(id);
    db.upsertTrackAnalysis(id, { bpm: 124, musicalKey: '8A', vocalRanges: [{ startMs: 2_000, endMs: 28_000 }],
      outro, source: 'full' });
    db.requireDb().prepare("UPDATE track_facet_status SET version = ? WHERE track_id = ? AND facet = 'vocal'")
      .run(db.FACET_VERSIONS.vocal - 1, id);
  }
  await phaseEmbed(['bleed', 'singer'], 8, 'plain');
  for (const text of drain()) assert.match(text, /\nSound: upbeat tempo, minor key$/m);
  assert.ok(['bleed', 'singer'].every(id => db.facetNeedsIds('vocal').includes(id)), 'v1 rows are due');

  db.writeFacetResults('bleed', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: [] } });
  db.writeFacetResults('singer', { source: 'full',
    vocal: { vocalRanges: [{ startMs: 3_000, endMs: 27_000 }], tailVocalRanges: [] } });
  assert.deepEqual(dirty(), ['bleed'], 'only the row whose verdict moved');
  assert.ok(!db.facetNeedsIds('vocal').includes('bleed') && !db.facetNeedsIds('vocal').includes('singer'),
    'both settle at the current version');
  await reembedMarked();
  const once = drain();
  assert.equal(once.length, 1);
  assert.match(once[0], /\nSound: upbeat tempo, minor key, instrumental$/m);
});

// #2255: a vocal-off --re-analyze kept the head's vocal ranges but cleared
// outro_json, and with it the tail's. 'tail' has an instrumental head and a sung
// tail, so it read as instrumental from the clear on, was marked for a wrong
// "instrumental" word, and the next vocal-on pass measured it and marked it back.
test('a vocal-off re-analyze keeps a sung tail: no flip, no mark, no re-measure', async () => {
  const sungTail = [{ startMs: 200_000, endMs: 215_000 }];
  // Its CLAP vector and moods first, so their own mark is paid before the re-analyze.
  await analyse();
  await reembedMarked();
  drain();
  assert.deepEqual(dirty(), []);
  const before = textOf('tail');
  assert.equal(isInstrumental(db.getTrack('tail')), false);
  let midPass: boolean | null | undefined;
  duringAnalyze = () => { midPass = isInstrumental(db.getTrack('tail')); };

  // The fake analyzer answers every outro without vocalRanges, as a vocal-off pass does.
  await analyse({ reAnalyze: true });
  assert.equal(midPass, false, 'still vocal straight after the clear');
  const t = db.getTrack('tail')!;
  assert.equal(isInstrumental(t), false, 'still vocal after the re-write');
  assert.deepEqual(t.tailVocalRanges, sungTail, 'the stored tail ranges carried forward');
  assert.equal(t.outro?.startMs, 190_000, 'onto the freshly measured outro');
  assert.equal(textOf('tail'), before);
  assert.deepEqual(dirty(), [], 'nothing marked');

  // So a vocal-on pass has nothing to measure again for it.
  assert.ok(!db.needsVocalIds(undefined, true).includes('tail'));
  assert.ok(!db.facetNeedsIds('vocal').includes('tail'));
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');
});

test('a stems-only or loudness-only write never marks, even after a replaced file', async () => {
  addTrack('replaced');
  db.upsertTrackAnalysis('replaced', { bpm: 124, musicalKey: '8A', source: 'full' });
  await phaseEmbed(['replaced'], 8, 'plain');
  drain();
  // A replaced file clears every measurement, so the row's words no longer match
  // its vector's; pick-time stems (#2197) then write that facet alone.
  db.clearTrackAudio('replaced');
  db.writeFacetResults('replaced', { source: 'full', stems: { attempted: true } });
  db.writeFacetResults('replaced', { source: 'full', loudness: { loudnessLufs: -9, peakDb: -1 } });
  assert.deepEqual(dirty(), [], 'neither facet writes a word');
  const head = (bpm: number) => ({
    bpm, musicalKey: '8A', introMs: null, confidence: null, sections: null, pace: null,
    beats: null, bars: null, keyRanges: null, leadSilenceMs: null,
  });
  // The new file's head measures the same words the vector already has.
  db.writeFacetResults('replaced', { source: 'full', head: head(126) });
  assert.deepEqual(dirty(), [], 'the same words');
  db.writeFacetResults('replaced', { source: 'full', head: head(140) });
  assert.deepEqual(dirty(), ['replaced'], 'a new tempo band');
  await reembedMarked();
  assert.match(drain()[0], /\nSound: fast tempo, minor key$/m);
});

test('a measurement written during the embedding await marks the vector at completion', async () => {
  addTrack('racing');
  // The analyzer writes while phase 1's request is in flight: there is no vector to
  // mark yet, so only upsertTrackVector's own check catches it.
  duringEmbed = () => db.upsertTrackAnalysis('racing', { bpm: 124, musicalKey: '8A', source: 'full' });
  await phaseEmbed(['racing'], 8, 'plain');
  assert.ok(!drain()[0].includes('Sound:'), 'built from the row before the write');
  assert.deepEqual(dirty(), ['racing']);
  await reembedMarked();
  assert.match(drain()[0], /\nSound: upbeat tempo, minor key$/m);
  assert.deepEqual(dirty(), []);
});

test('a vector from before the upgrade is never marked, and the upgrade re-embeds nothing', async () => {
  // A vector written with no words recorded, as every vector before migration 36 was.
  addTrack('legacy');
  db.upsertTrackVector('legacy', textVector, db.resolvedEraYearForTrack('legacy'));
  assert.equal(builtFrom('legacy'), null);
  db.upsertTrackAnalysis('legacy', { bpm: 124, musicalKey: '8A', vocalRanges: [], source: 'full' });
  assert.deepEqual(dirty(), [], 'unknown words never mark');

  // The upgrade itself, from a database at 35 and from one wound back below it.
  const raw = db.requireDb();
  assert.equal(raw.pragma('user_version', { simple: true }), 37);
  raw.exec('ALTER TABLE tracks DROP COLUMN text_vector_sound');
  raw.pragma('user_version = 35');
  db.close();
  await open();
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 37);
  assert.equal(builtFrom('new-a'), null, 'every existing vector reads as unknown');
  db.requireDb().pragma('user_version = 35');
  db.close();
  await open();
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 37);

  // Old vectors keep their old Sound: line until a manual Re-embed.
  heads.set('new-c', { bpm: 70, key: '8B' });
  await analyse({ reAnalyze: true });
  heads.delete('new-c');
  assert.deepEqual(dirty(), [], 'nothing marked');
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');
});

test('dropping the vectors forgets the words they were built from', async () => {
  db.upsertTrackVector('racing', textVector, 1999, soundWords(trackAcoustics(db.getTrack('racing')!)));
  assert.notEqual(builtFrom('racing'), null);
  db.dropVectors();
  const left = db.requireDb()
    .prepare('SELECT COUNT(*) AS n FROM tracks WHERE text_vector_sound IS NOT NULL')
    .get() as { n: number };
  assert.equal(left.n, 0);
});
