// #2313. The two CLIs' trailing steps, through the real tag-library.ts and
// analyze-library.ts against a fake Navidrome, embedding endpoint and analyzer:
//
// - a forward tag run re-embeds the vectors its phase 5 marked (#2236), so a new
//   track ends the run with its Sound: line;
// - it then votes again for the tracks it propagated, over the vectors they keep,
//   and never for an llm row or one propagated in an earlier run;
// - a standalone Analyse run re-embeds what it marked, only with the index's own
//   model, and a run that marked nothing, or that has no provider, sends nothing.
//
// The fake embedding answers by the text's Sound: words, so a track moves in the
// index when its line lands: no line sits by the calm tracks, "upbeat tempo" by
// the energetic ones. node:test runs these in file order on one station.
//
// Run: npm test -- sound-line-cli-runs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const state = createTempDir(join(tmpdir(), 'subwave-sound-cli-'));
const controller = fileURLToPath(new URL('../', import.meta.url));

const DIM = 8;
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const axis = (i: number, lean = 0) => unit(Array.from({ length: DIM }, (_, j) => (j === i ? 1 : j === 1 - i ? lean : 0)));
const CALM = axis(0);
const UPBEAT = axis(1);
// No Sound: line yet: close to the calm tracks.
const THIN = axis(0, 0.1);
const PROBE = 'subwave embedding probe';
const vectorFor = (text: string) =>
  !text.includes('\nSound:') ? THIN : text.includes('slow tempo') ? CALM : text.includes('upbeat tempo') ? UPBEAT : axis(2);

function seededVector(seed: string): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < 512; i++) {
    const h = crypto.createHash('sha256').update(`${seed}#${i}`).digest();
    for (let b = 0; b + 4 <= h.length && out.length < 512; b += 4) out.push(h.readInt32LE(b) / 2 ** 31);
  }
  return unit(out);
}

const calm = Array.from({ length: 6 }, (_, i) => `calm-${i}`);
const upbeat = Array.from({ length: 6 }, (_, i) => `up-${i}`);
const fresh = ['new-0', 'new-1', 'new-2'];
// Every track Navidrome lists; each on its own album and artist, so no
// same-artist damping and no anthology era verdict.
const songs = [...calm, ...upbeat, 'old-prop', ...fresh];
const headOf = (id: string) => (id.startsWith('calm-') ? { bpm: 70, key: '8B' } : { bpm: 124, key: '8A' });

let embedRequests = 0;
const embedded: string[] = [];
const requestSchema = z.object({ path: z.string().optional(), url: z.string().optional(), embed: z.boolean().optional() });
function trackIdOf(r: z.infer<typeof requestSchema>): string {
  if (r.path) return decodeURIComponent(r.path.split('/').pop()!.replace(/\.(audio|flac)$/, ''));
  return new URL(r.url!).searchParams.get('id') ?? '';
}

function subsonic(res: ServerResponse, url: URL) {
  const endpoint = (url.pathname.split('/').at(-1) ?? '').replace(/\.view$/, '');
  const sub: Record<string, unknown> = { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.58.0', openSubsonic: true };
  const song = (id: string) => ({
    id, title: id, artist: `Artist ${id}`, album: `Album ${id}`, year: 1999, genre: 'House', duration: 240,
    albumId: `al-${id}`, path: `/music/${id}.flac`, suffix: 'flac', size: 100_000, bitRate: 900,
  });
  switch (endpoint) {
    case 'ping': break;
    case 'getScanStatus': sub.scanStatus = { scanning: false }; break;
    case 'getAlbumList2':
      sub.albumList2 = {
        album: Number(url.searchParams.get('offset') ?? 0) > 0
          ? []
          : songs.map(id => ({ id: `al-${id}`, name: `Album ${id}`, artist: `Artist ${id}` })),
      };
      break;
    case 'getAlbum': {
      const id = (url.searchParams.get('id') ?? '').replace(/^al-/, '');
      sub.album = { id: `al-${id}`, name: `Album ${id}`, artist: `Artist ${id}`, year: 1999, song: [song(id)] };
      break;
    }
    case 'stream':
      res.setHeader('content-type', 'audio/flac');
      res.end(Buffer.alloc(1024, 1));
      return;
    default:
      res.statusCode = 404;
      res.end('{}');
      return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'subsonic-response': sub }));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/v1/embeddings')) {
    embedRequests += 1;
    const inputs = z.array(z.string()).parse(JSON.parse(raw).input);
    embedded.push(...inputs);
    return json({
      object: 'list', model: 'fixture',
      data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  if (url.pathname === '/health') {
    return json({ ok: true, engines: ['analyze'], analyze_audio_capable: true, analyze_text_capable: true });
  }
  if (url.pathname === '/embed-text') {
    const { texts } = z.object({ texts: z.array(z.string()) }).parse(JSON.parse(raw));
    return json({ ok: true, embeddings: texts.map(seededVector) });
  }
  if (url.pathname === '/analyze') {
    const r = requestSchema.parse(JSON.parse(raw));
    const id = trackIdOf(r);
    const head = headOf(id);
    return json({
      ok: true, bpm: head.bpm, key: head.key, intro_ms: 1000, confidence: 0.9,
      loudness_lufs: -10, peak_db: -1, tail_silence_ms: 1500, tail_start_ms: 200_000,
      outro: { startMs: 190_000, ending: 'fade' },
      ...(r.embed ? { audio_embedding: seededVector(id) } : {}),
    });
  }
  if (url.pathname === '/auth/login') return json({ token: 'tok' });
  if (url.pathname === '/api/song') return json([]);
  subsonic(res, url);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

process.env.STATE_DIR = state;
process.env.ANALYZE_URL = origin;
process.env.NAVIDROME_URL = origin;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;

const preload = join(state, 'network.mjs');
writeFileSync(preload, `
const request = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== ${JSON.stringify(origin)}) return Promise.reject(new Error('external network disabled'));
  return request(input, init);
};
`);

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const { soundWords, trackAcoustics } = await import('../src/music/embeddings.js');

await settings.load();
await db.open({ embeddingDim: DIM, adoptStoredDim: true });

const EMBEDDING = {
  enabled: true, provider: 'openai-compatible', model: 'fixture',
  providerBaseUrls: { 'openai-compatible': `${origin}/v1` },
  audioFusionWeight: 0,
  enrichment: { lastfmTags: false, lyrics: false, originalYear: false },
};

before(async () => {
  await settings.update({ embedding: EMBEDDING } as never);
});
after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(state);
});

async function cli(script: string, ...flags: string[]): Promise<string> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', preload, script, ...flags],
    { cwd: controller, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, out);
  return out;
}
const tagRun = () => cli('src/music/tag-library.ts', '--skip-enrich', '--seeds', '0', '--max-rounds', '0', '--no-vocal');
const analyseRun = () => cli('src/music/analyze-library.ts');

const addTrack = (id: string) =>
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${id}`, album: `Album ${id}`, year: 1999, genres: ['House'], duration: 240 });
const measure = (id: string) => {
  const { bpm, key } = headOf(id);
  db.upsertTrackAnalysis(id, { bpm, musicalKey: key, source: 'full' });
};
// A vector built from the row as it stands, words recorded, as phaseEmbed writes it.
const embedRow = (id: string, vector: number[]) =>
  db.upsertTrackVector(id, vector, 1999, soundWords(trackAcoustics(db.getTrack(id)!)));
const tag = (id: string, mood: string, source: 'llm' | 'propagated') =>
  db.upsertTrackTags(id, {
    moods: [mood], energy: mood === 'calm' ? 'low' : 'high', source, confidence: 0.9, promptHash: 'seeded', model: 'seeded',
  });
const dirty = () => db.textVectorDirtyIds().sort();
const documents = () => embedded.splice(0).filter(t => t !== PROBE);
const moodsOf = (id: string) => db.getTrack(id)!.moods;

test('a tag run re-embeds what phase 5 marked, then re-votes only this run\'s propagated tracks', async () => {
  // The station before the run: measured, decided and embedded.
  for (const id of calm) { addTrack(id); measure(id); tag(id, 'calm', 'llm'); embedRow(id, CALM); }
  for (const id of upbeat) { addTrack(id); measure(id); tag(id, 'energetic', 'llm'); embedRow(id, UPBEAT); }
  // Propagated by an earlier run over its thin vector, and not measured yet.
  addTrack('old-prop'); tag('old-prop', 'calm', 'propagated'); embedRow('old-prop', THIN);
  embedded.splice(0);

  await tagRun();

  // Phase 1 embedded the new tracks before phase 5 measured them; the trailing
  // re-embed rebuilt them, and old-prop, which this run's phase 5 also marked.
  const texts = documents();
  assert.equal(texts.length, fresh.length * 2 + 1, texts.join('\n---\n'));
  assert.equal(texts.filter(t => !t.includes('\nSound:')).length, fresh.length, 'a thin first vector each');
  assert.equal(texts.filter(t => /\nSound: upbeat tempo, minor key$/m.test(t)).length, fresh.length + 1, 'then the analysed one');
  assert.deepEqual(dirty(), [], 'nothing left marked');

  // Phase 3 voted them calm over their thin vectors; over the vectors they keep
  // they sit by the energetic tracks.
  for (const id of fresh) {
    assert.deepEqual(moodsOf(id), ['energetic'], id);
    assert.equal(db.getTrack(id)!.source, 'propagated');
  }
  assert.deepEqual(moodsOf('old-prop'), ['calm'], 'an earlier run\'s propagated tag is left alone');
  for (const id of calm) assert.deepEqual(moodsOf(id), ['calm'], 'an llm row is never re-voted');

  // A run with nothing new marks nothing, embeds nothing and votes nothing.
  const out = await tagRun();
  assert.deepEqual(documents(), []);
  assert.doesNotMatch(out, /re-voted/);
});

test('an Analyse run re-embeds the vectors it marked', async () => {
  // A track embedded before it was measured (by a tag run that skipped analysis).
  addTrack('late'); tag('late', 'calm', 'llm'); embedRow('late', THIN);
  embedded.splice(0);

  await analyseRun();
  const texts = documents();
  assert.equal(texts.length, 1, texts.join('\n---\n'));
  assert.match(texts[0], /^Artist late — late /);
  assert.match(texts[0], /\nSound: upbeat tempo, minor key$/m);
  assert.deepEqual(dirty(), []);
});

test('an Analyse run that marked nothing sends nothing, and leaves an earlier mark', async () => {
  db.requireDb().prepare('UPDATE tracks SET text_vector_dirty = 1 WHERE id = ?').run('calm-0');
  embedRequests = 0;
  await analyseRun();
  assert.equal(embedRequests, 0, 'not even a probe');
  assert.deepEqual(dirty(), ['calm-0']);
  db.requireDb().prepare('UPDATE tracks SET text_vector_dirty = 0 WHERE id = ?').run('calm-0');
});

test('an Analyse run leaves its marks for the tag run on another model, or with no provider', async () => {
  addTrack('late-2'); tag('late-2', 'calm', 'llm'); embedRow('late-2', THIN);

  await settings.update({ embedding: { ...EMBEDDING, model: 'another-model' } } as never);
  embedded.splice(0);
  embedRequests = 0;
  const other = await analyseRun();
  assert.deepEqual(documents(), [], 'nothing embedded into an index built with another model');
  // Not even the probe: a probe of a missing Ollama model pulls it, for a run
  // that would then refuse it.
  assert.equal(embedRequests, 0, 'no request on another model');
  assert.match(other, /left for the next tag run: the embedding model changed/);
  assert.deepEqual(dirty(), ['late-2'], 'the mark is kept');

  // And with no provider at all: no request of any kind.
  addTrack('late-3'); tag('late-3', 'calm', 'llm'); embedRow('late-3', THIN);
  await settings.update({ embedding: { ...EMBEDDING, enabled: false } } as never);
  embedRequests = 0;
  await analyseRun();
  assert.equal(embedRequests, 0);
  assert.deepEqual(dirty(), ['late-2', 'late-3']);

  // Back on the index's model, the next run that marks something takes them all.
  await settings.update({ embedding: EMBEDDING } as never);
  addTrack('late-4'); tag('late-4', 'calm', 'llm'); embedRow('late-4', THIN);
  embedded.splice(0);
  await analyseRun();
  assert.equal(documents().length, 3);
  assert.deepEqual(dirty(), []);
});
