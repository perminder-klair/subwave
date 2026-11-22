// #2313, two relabel-all cases sound-line-relabel.test.ts does not reach: a
// vocabulary edit (a full re-score) on a station that also has a new track, and
// the pass that crosses the 200-track calibration floor. In both, only the new
// tracks' first moods mark their vectors, the labelled rows forget rather than
// mark, and a vector from before migration 36 or a row with no vector never marks.
//
// Run: npm test -- sound-line-relabel-edges

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-sound-relabel-edges-'));

const DIM = 8;
const textVector = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

// The same vector every time a seed is asked for, so a re-analyze is identical.
function seededVector(seed: string): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < 512; i++) {
    const h = crypto.createHash('sha256').update(`${seed}#${i}`).digest();
    for (let b = 0; b + 4 <= h.length && out.length < 512; b += 4) out.push(h.readInt32LE(b) / 2 ** 31);
  }
  const n = Math.hypot(...out);
  return out.map((x) => x / n);
}

const embedded: string[] = [];
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
    const r = requestSchema.parse(JSON.parse(raw));
    return json({
      ok: true, bpm: 124, key: '8A', intro_ms: 1000, confidence: 0.9,
      loudness_lufs: -10, peak_db: -1, tail_silence_ms: 1500, tail_start_ms: 200_000,
      outro: { startMs: 190_000, ending: 'fade' },
      ...(r.embed ? { audio_embedding: seededVector(trackIdOf(r)) } : {}),
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
const { phaseEmbed } = await import('../src/music/tag-library/embed.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const { MIN_BASELINE_TRACKS } = await import('../src/music/audio-calibration.js');

await settings.load();
await db.open({ embeddingDim: DIM, adoptStoredDim: true });

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
const dirty = () => db.textVectorDirtyIds().sort();
const drain = () => embedded.splice(0);
const analyse = (opts: { reAnalyze?: boolean } = {}) =>
  runAnalysisPass({ audioBackfill: true, vocalBackfill: false, ...opts });
const reembedMarked = () => phaseEmbed([], 8, 'plain');
const setLegacy = (id: string) => db.requireDb().prepare('UPDATE tracks SET text_vector_sound = NULL WHERE id = ?').run(id);

test('a vocabulary edit marks only the new track whose vector has no moods', async () => {
  const lib = Array.from({ length: 20 }, (_, i) => `p-${String(i).padStart(3, '0')}`);
  for (const id of lib) addTrack(id);
  await analyse();
  await phaseEmbed(lib, 8, 'plain');
  drain();
  assert.deepEqual(dirty(), []);
  // a legacy vector (pre-36) with no moods yet: never marks
  addTrack('legacy-new');
  await phaseEmbed(['legacy-new'], 8, 'plain'); setLegacy('legacy-new');
  addTrack('new-v');
  db.upsertTrackAnalysis('new-v', { bpm: 124, musicalKey: '8A', source: 'full' });
  await phaseEmbed(['new-v'], 8, 'plain');
  addTrack('no-vector');
  drain();
  const vocab = settings.get().moods;
  await settings.update({ moods: vocab.map(m => ({ ...m, clapPrompt: `${m.clapPrompt || m.name} at night` })) } as never);
  await analyse();
  assert.deepEqual(dirty(), ['new-v'], 'not the legacy vector, not the labelled rows');
  assert.ok(db.getTrack('no-vector')!.audioMoods.length > 0);
  await settings.update({ moods: vocab } as never);
  await reembedMarked(); drain();
});

test('the pass that crosses the floor marks the new tracks and no labelled row', async () => {
  const before = db.analysedIds().length;
  const need = MIN_BASELINE_TRACKS - before + 5;
  const grow = Array.from({ length: need }, (_, i) => `g-${String(i).padStart(3, '0')}`);
  for (const id of grow) { addTrack(id); db.upsertTrackAnalysis(id, { bpm: 124, musicalKey: '8A', source: 'full' }); }
  await phaseEmbed(grow, 8, 'plain');
  drain();
  const d0 = dirty();
  await analyse();
  const d = dirty();
  const newly = d.filter(x => !d0.includes(x));
  assert.equal(newly.filter(x => !x.startsWith('g-')).length, 0, 'no old row marked');
  assert.equal(newly.length, grow.length, 'every new track marked');
  await reembedMarked(); drain();
  // a second pass past the floor: incremental, nothing
  await analyse();
  assert.deepEqual(dirty(), []);
});
