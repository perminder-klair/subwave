// #2313, the relabel-all half of #2236. A relabel-all (a first mood pass, a
// vocabulary or calibration edit, crossing the floor, and every pass below it)
// forgets the mood words it moves rather than marking the whole library. A new
// track's first moods are not a move, though: its vector was built before it had
// any, so they mark it, as the incremental branch does. A row whose vector does
// carry moods still forgets, and the forgotten ones are counted for the operator's
// stale-vector notice, whose action marks just those.
//
// A station under the 200-track calibration floor, where every mood pass is a
// relabel-all. A real SQLite database and the real analysis pass, mood pass and
// phaseEmbed, with only the HTTP edges faked. node:test runs these in file order,
// and the station grows through them.
//
// Run: npm test -- sound-line-relabel

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-sound-relabel-'));

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
// requireAdmin reads these at import time.
process.env.ADMIN_USER = 'relabel-admin';
process.env.ADMIN_PASS = 'relabel-pass';

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const coverage = await import('../src/music/library-coverage.js');
const { phaseEmbed } = await import('../src/music/tag-library/embed.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const { MIN_BASELINE_TRACKS } = await import('../src/music/audio-calibration.js');

await settings.load();
await db.open({ embeddingDim: DIM, adoptStoredDim: true });

const express = (await import('express')).default;
const { listen: listenHttp } = await import('./test-utils/http.js');
const { router: maintenance } = await import('../src/routes/library/maintenance.js');
const app = express();
app.use(express.json());
app.use(maintenance);
const { server: routes, url: routesUrl } = await listenHttp(app);
routes.unref();
const auth = `Basic ${Buffer.from('relabel-admin:relabel-pass').toString('base64')}`;
const markStale = (headers: Record<string, string> = { authorization: auth }) =>
  fetch(`${routesUrl}/library/vectors/mark-stale-sound`, { method: 'POST', headers });

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
const builtMoods = (id: string) => {
  const row = db.requireDb().prepare('SELECT text_vector_sound AS s FROM tracks WHERE id = ?').get(id) as { s: string | null };
  return row.s == null ? undefined : (JSON.parse(row.s).moods as string[] | null);
};
const labels = () => new Map(db.analysedIds().map(id => [id, db.getTrack(id)!.audioMoods.join(',')]));

const lib = Array.from({ length: 20 }, (_, i) => `lib-${String(i).padStart(2, '0')}`);

test('under the floor, a new track\'s first moods mark the vector built without them', async () => {
  assert.ok(lib.length < MIN_BASELINE_TRACKS, 'every mood pass here is a relabel-all');
  for (const id of lib) addTrack(id);
  await analyse();
  await phaseEmbed(lib, 8, 'plain');
  drain();
  assert.deepEqual(dirty(), []);

  // Measured and embedded before its CLAP vector, so only the moods are late.
  addTrack('new-a');
  db.upsertTrackAnalysis('new-a', { bpm: 124, musicalKey: '8A', source: 'full' });
  await phaseEmbed(['new-a'], 8, 'plain');
  assert.match(drain()[0], /\nSound: upbeat tempo, minor key$/m, 'built with no mood words');
  assert.deepEqual(builtMoods('new-a'), []);

  await analyse();
  assert.ok(db.getTrack('new-a')!.audioMoods.length > 0, 'the relabel-all labelled it');
  assert.deepEqual(dirty(), ['new-a'], 'its vector is marked, and nothing else');
  await reembedMarked();
  const once = drain();
  assert.equal(once.length, 1);
  assert.match(once[0], /\nSound: .+, upbeat tempo, minor key$/m, 'the moods are in');
  await analyse();
  await reembedMarked();
  assert.deepEqual(drain(), [], 'then never again');
});

test('a vocabulary edit followed by a re-analyze still marks nothing', async () => {
  const before = labels();
  // The re-analyze clears every row's moods, so the edit's relabel-all finds the
  // whole library unlabelled: rows whose vectors carry moods forget, not mark.
  const vocab = settings.get().moods;
  await settings.update({
    moods: vocab.map(m => ({ ...m, clapPrompt: `${m.clapPrompt || m.name} at dusk` })),
  } as never);
  await analyse({ reAnalyze: true });
  const moved = [...labels()].filter(([id, l]) => before.get(id) !== l).map(([id]) => id);
  assert.ok(moved.length > 3, `the edit moved labels (${moved.length})`);
  assert.deepEqual(dirty(), [], 'nothing marked');
  assert.ok(moved.every(id => builtMoods(id) === null), 'the moved rows forgot their moods');
  await reembedMarked();
  assert.deepEqual(drain(), [], 'no embed call');
  await settings.update({ moods: vocab } as never);
});

test('the stale-vector notice counts the forgotten vectors only when asked, and its action marks just those', async () => {
  const forgotten = db.analysedIds().filter(id => builtMoods(id) === null).sort();
  assert.ok(forgotten.length > 0);
  // A vector from before migration 36 is unknown, not forgotten: never counted.
  addTrack('legacy');
  db.upsertTrackVector('legacy', textVector, 1999);
  assert.equal(builtMoods('legacy'), undefined);

  assert.equal((await coverage.get()).forgottenSoundVectors, null, 'the read path never counts');
  // The library count recounts them first, so even a walk that fails (this fake
  // is no Navidrome) leaves fresh figures.
  await coverage.refresh();
  const counted = await coverage.get();
  assert.equal(counted.forgottenSoundVectors, forgotten.length);
  assert.equal(counted.forgottenSoundQueued, 0);
  assert.equal(counted.dirtyVectors, 0);
  assert.ok(counted.vectorsCountedAt);

  // An unrelated mark is counted as dirty and left alone by the action.
  db.requireDb().prepare('UPDATE tracks SET text_vector_dirty = 1 WHERE id = ?').run('legacy');
  assert.equal((await markStale({})).status, 401, 'admin only');
  assert.deepEqual(dirty(), ['legacy']);
  const res = await markStale();
  assert.equal(res.status, 200);
  const body = await res.json() as { marked: number; coverage: { forgottenSoundQueued: number; dirtyVectors: number } };
  assert.equal(body.marked, forgotten.length);
  assert.equal(body.coverage.forgottenSoundQueued, forgotten.length, 'the answer carries the recount');
  assert.equal(body.coverage.dirtyVectors, forgotten.length + 1);
  assert.deepEqual(dirty(), [...forgotten, 'legacy'].sort());
  assert.equal(db.markForgottenSoundVectorsDirty(), 0, 'a second press marks nothing');
  assert.deepEqual(db.vectorFreshnessCounts(), {
    forgottenSound: forgotten.length, forgottenSoundQueued: forgotten.length, dirty: forgotten.length + 1,
  });

  await reembedMarked();
  assert.equal(drain().length, forgotten.length + 1);
  coverage.countVectors();
  const after = await coverage.get();
  assert.equal(after.forgottenSoundVectors, 0, 'rebuilt vectors carry their words again');
  assert.equal(after.dirtyVectors, 0);
});
