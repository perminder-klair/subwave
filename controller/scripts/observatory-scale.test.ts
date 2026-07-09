// Scale / stress test for the Library Observatory data path (#957) at very
// large library sizes — some operators have 200k+ track libraries.
//
// Covers the server side of the galaxy renderer end-to-end EXCEPT the express
// wiring: a REAL better-sqlite3 DB in a temp STATE_DIR seeded with N synthetic
// tagged tracks (60% carrying realistically fat analysis blobs — beats/bars/
// pace/structure JSON — which the lean observatory reads must SKIP; parsing
// them per row is what made the pre-lean bulk path a multi-second stall),
// then measures + budget-asserts the exact calls the
// GET /library/observatory route makes:
//
//   - allTagged() / allTaggedSampled()  (lean ObservatoryTrackRow reads)
//   - stats()                           (the ~7 GROUP-BY scans, TTL-cached)
//   - the route's row→payload projection + JSON.stringify (+ gzip size, since
//     Caddy compresses on the wire) — all of it synchronous on the event loop
//   - setMapCoordsBulk()                (the projection child's final write)
//   - allAudioVectors() at AUDIO_N      (the UMAP child's input load; memory
//     reported and extrapolated to N — the child holds the whole matrix)
//
// And the client's pure layout pipeline, imported straight from the web app so
// it can't drift (data.ts is dependency-free):
//
//   - layoutTracks() in both modes (sound-map coords + genre-cluster fallback)
//   - buildSynapseLinks()               (the spatial-grid nearest-neighbour pass)
//
// Budgets are deliberately loose (≈3–5× a warm dev-box run) — they exist to
// catch an accidental O(n²) or a new per-row JSON.parse, not scheduler jitter.
//
// Row count is env-tunable:   OBS_SCALE_N=200000 tsx scripts/observatory-scale.test.ts
// (default 200000; OBS_SCALE_TMP overrides the temp dir — /tmp is tmpfs on
// some distros and the seeded DB is ~0.5 GB at 200k).
// Run: `tsx scripts/observatory-scale.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  mulberry32,
  layoutTracks,
  buildSynapseLinks,
  type RawTrack,
} from '../../web/components/observatory/data.js';

const N = Math.max(1000, Number(process.env.OBS_SCALE_N) || 200_000);
const AUDIO_N = Math.min(N, 50_000); // audio vectors are 2 KB each — cap the seed, extrapolate
const AUDIO_DIM = 512;

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const timed = <T>(label: string, fn: () => T): { out: T; ms: number } => {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  console.log(`      ${label}: ${ms.toFixed(0)} ms`);
  return { out, ms };
};

// --------------------------------------------------------------------------
// Synthetic library — deterministic, zipf-ish genre spread, realistic blobs.
// --------------------------------------------------------------------------
const GENRES = Array.from({ length: 120 }, (_, i) => `Genre ${String(i).padStart(3, '0')}`);
const MOODS = ['hazy', 'reflective', 'calm', 'night', 'rainy', 'romantic', 'energetic', 'driving', 'celebratory', 'melancholy', 'warm', 'cold', 'dusty', 'cosmic', 'urban', 'pastoral', 'tense', 'playful', 'solemn', 'glassy', 'neon', 'analog', 'blue', 'golden', 'feral'];
const SOURCES = ['llm', 'llm', 'llm', 'propagated', 'propagated', 'manual', 'uncertain-llm', 'legacy-v1'];
const ENERGIES = ['low', 'medium', 'high'] as const;
const KEYS = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

interface SeedRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number;
  genre: string;
  durationSec: number;
  moods: string[];
  energy: (typeof ENERGIES)[number];
  source: string;
  confidence: number;
  analysed: boolean;
  bpm: number | null;
  musicalKey: string | null;
  analysisConfidence: number | null;
  loudnessLufs: number | null;
  paceJson: string | null;
  vocalRangesJson: string | null;
  structureJson: string | null;
  beatsJson: string | null;
  barsJson: string | null;
  keyRangesJson: string | null;
  mapX: number | null;
  mapY: number | null;
}

function makeRow(i: number, rng: () => number): SeedRow {
  // zipf-ish genre pick: squaring the uniform biases toward low indices, so a
  // few genres are huge and the tail is sparse — like a real library.
  const genre = GENRES[Math.floor(rng() * rng() * GENRES.length)]!;
  const analysed = rng() < 0.6;
  const mapped = rng() < 0.7; // > the client's 60% sound-map coverage gate
  const durationSec = 120 + Math.floor(rng() * 300);
  const moodCount = 1 + Math.floor(rng() * 3);
  const moods = Array.from({ length: moodCount }, () => MOODS[Math.floor(rng() * MOODS.length)]!);
  const bpm = analysed ? 60 + rng() * 120 : null;

  let paceJson: string | null = null;
  let vocalRangesJson: string | null = null;
  let structureJson: string | null = null;
  let beatsJson: string | null = null;
  let barsJson: string | null = null;
  let keyRangesJson: string | null = null;
  if (analysed) {
    const totalMs = durationSec * 1000;
    const spans = (n: number) =>
      Array.from({ length: n }, (_, k) => ({
        startMs: Math.round((totalMs * k) / n),
        endMs: Math.round((totalMs * (k + 1)) / n),
      }));
    paceJson = JSON.stringify(spans(14).map((s) => ({ ...s, value: Math.round(rng() * 100) / 100 })));
    vocalRangesJson = JSON.stringify(rng() < 0.7 ? spans(4) : []);
    structureJson = JSON.stringify(spans(7).map((s, k) => ({ ...s, kind: k % 2 ? 'verse' : 'chorus' })));
    // the fat ones — a ~4 min track carries hundreds of beat timestamps
    const beatMs = 60000 / (bpm || 120);
    const beatCount = Math.min(600, Math.floor(totalMs / beatMs));
    beatsJson = JSON.stringify(Array.from({ length: beatCount }, (_, k) => Math.round(k * beatMs)));
    barsJson = JSON.stringify(Array.from({ length: beatCount >> 2 }, (_, k) => Math.round(k * beatMs * 4)));
    keyRangesJson = JSON.stringify([
      { startMs: 0, endMs: totalMs >> 1, tonic: 'C', mode: 'major' },
      { startMs: totalMs >> 1, endMs: totalMs, tonic: 'A', mode: 'minor' },
    ]);
  }

  return {
    id: `trk-${String(i).padStart(7, '0')}`,
    title: `Track ${i} of the Long Tail`,
    artist: `Artist ${i % 40_000}`,
    album: `Album ${i % 60_000}`,
    year: 1970 + (i % 55),
    genre,
    durationSec,
    moods,
    energy: ENERGIES[Math.floor(rng() * 3)]!,
    source: SOURCES[Math.floor(rng() * SOURCES.length)]!,
    confidence: Math.round(rng() * 100) / 100,
    analysed,
    bpm: bpm ? Math.round(bpm * 10) / 10 : null,
    musicalKey: analysed ? KEYS[Math.floor(rng() * KEYS.length)]! : null,
    analysisConfidence: analysed ? Math.round((0.5 + rng() * 0.5) * 100) / 100 : null,
    loudnessLufs: analysed ? Math.round((-24 + rng() * 16) * 10) / 10 : null,
    paceJson,
    vocalRangesJson,
    structureJson,
    beatsJson,
    barsJson,
    keyRangesJson,
    mapX: mapped ? rng() : null,
    mapY: mapped ? rng() : null,
  };
}

// Mirrors the GET /library/observatory row→payload projection in
// routes/library.ts (kept inline: importing the router would drag express,
// subsonic and settings into this test). If the route's shape changes, update
// this copy — the point is the WORK (field picks + stringify), not the shape.
function projectRows(rows: any[]) {
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year,
    genre: t.genre,
    durationSec: t.durationSec,
    moods: t.moods,
    energy: t.energy,
    source: t.source,
    confidence: t.confidence,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    analysisConfidence: t.analysisConfidence,
    loudnessLufs: t.loudnessLufs,
    paceMean: t.paceMean,
    vocal: t.vocal,
    mapX: t.mapX,
    mapY: t.mapY,
  }));
}

async function main() {
  const stateDir = mkdtempSync(join(process.env.OBS_SCALE_TMP || tmpdir(), 'subwave-obs-scale-'));
  process.env.STATE_DIR = stateDir;
  console.log(`observatory scale test — N=${N.toLocaleString()} tracks (state: ${stateDir})`);

  // Imported AFTER STATE_DIR is set so DB_PATH resolves into the temp dir.
  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: 768 });

  // ---- seed (raw second connection: the public upserts autocommit per row,
  // which is 3×N transactions — a raw prepared INSERT in chunked transactions
  // seeds 200k rows in seconds; WAL makes the two connections safe, exactly
  // like the tagger children alongside the live controller) ----
  const raw = new Database(join(stateDir, 'library.db'));
  sqliteVec.load(raw); // track_audio_vectors is a vec0 virtual table
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = OFF'); // seed speed only; the code under test never writes here
  {
    const rng = mulberry32(0x0b5e55);
    const stmt = raw.prepare(`
      INSERT INTO tracks (id, title, artist, album, year, genre, duration_sec,
        moods, energy, source, confidence, tagger_version, tagged_at,
        bpm, musical_key, analysis_confidence, analysis_version, loudness_lufs,
        pace_json, vocal_ranges_json, structure_json, beats_json, bars_json, key_ranges_json,
        map_x, map_y)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = raw.transaction((rows: SeedRow[]) => {
      for (const r of rows) {
        stmt.run(
          r.id, r.title, r.artist, r.album, r.year, r.genre, r.durationSec,
          JSON.stringify(r.moods), r.energy, r.source, r.confidence, '2026-01-01T00:00:00Z',
          r.bpm, r.musicalKey, r.analysisConfidence, r.analysed ? 1 : null, r.loudnessLufs,
          r.paceJson, r.vocalRangesJson, r.structureJson, r.beatsJson, r.barsJson, r.keyRangesJson,
          r.mapX, r.mapY,
        );
      }
    });
    const t0 = performance.now();
    const CHUNK = 20_000;
    for (let at = 0; at < N; at += CHUNK) {
      const rows: SeedRow[] = [];
      for (let i = at; i < Math.min(N, at + CHUNK); i++) rows.push(makeRow(i, rng));
      insertChunk(rows);
    }
    // audio vectors for the UMAP-input measurement
    const vecStmt = raw.prepare('INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)');
    const vecChunk = raw.transaction((ids: string[]) => {
      const v = new Float32Array(AUDIO_DIM);
      for (const id of ids) {
        for (let d = 0; d < AUDIO_DIM; d++) v[d] = rng() - 0.5;
        vecStmt.run(id, Buffer.from(v.buffer.slice(0)));
      }
    });
    for (let at = 0; at < AUDIO_N; at += CHUNK) {
      vecChunk(Array.from({ length: Math.min(CHUNK, AUDIO_N - at) }, (_, k) => `trk-${String(at + k).padStart(7, '0')}`));
    }
    console.log(`  seeded ${N.toLocaleString()} tracks + ${AUDIO_N.toLocaleString()} audio vectors in ${((performance.now() - t0) / 1000).toFixed(1)} s (db: ${mb(statSync(join(stateDir, 'library.db')).size)})`);
  }

  console.log('\nserver: bulk reads the observatory route makes');

  let fullRows: any[] = [];
  await test(`allTagged() reads all ${N.toLocaleString()} rows (lean observatory columns)`, () => {
    const { out, ms } = timed('allTagged lean scan', () => db.allTagged());
    fullRows = out;
    assert.equal(out.length, N);
    const analysed = out.filter((t: any) => t.bpm != null);
    assert.ok(analysed.length > N * 0.5, 'analysed rows present');
    // lean contract: derived scalars are present, the fat blobs are NOT.
    // (The pre-lean full-blob rowToTrack scan measured ~15 s at 200k here.)
    assert.ok(analysed.every((t: any) => t.paceMean != null && t.vocal != null), 'paceMean/vocal derived');
    assert.ok(!('beats' in (analysed[0] as any)), 'fat blobs never leave the db layer');
    assert.ok(ms < 20_000, `lean scan under 20 s (took ${ms.toFixed(0)} ms)`);
  });

  await test('allTaggedSampled(25k) — the default cap a 200k library actually serves', () => {
    const { out, ms } = timed('stratified sample 25k', () => db.allTaggedSampled(25_000, N));
    // +1-min-per-genre drift is allowed; the route slices to max after filtering
    assert.ok(out.length >= Math.min(25_000, N) * 0.95 && out.length <= 25_000 + GENRES.length, `~25k rows (got ${out.length})`);
    // The pre-thin-window form (windowing over t.*) measured ~98 s at 200k.
    assert.ok(ms < 15_000, `sample under 15 s (took ${ms.toFixed(0)} ms)`);
    // proportionality: the biggest genre's share in the sample tracks its share in the library
    const share = (rows: any[], g: string) => rows.filter((t) => t.genre === g).length / rows.length;
    const byGenre = new Map<string, number>();
    for (const t of fullRows) byGenre.set(t.genre, (byGenre.get(t.genre) || 0) + 1);
    const top = [...byGenre.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    assert.ok(Math.abs(share(out, top) - share(fullRows, top)) < 0.02, 'stratified sample preserves genre shares');
    // stability: same inputs → same rows
    const again = db.allTaggedSampled(25_000, N);
    assert.deepEqual(again.map((t: any) => t.id).slice(0, 100), out.map((t: any) => t.id).slice(0, 100));
  });

  await test('allTaggedSampled(100k) — the UI hardMax', () => {
    const { out, ms } = timed('stratified sample 100k', () => db.allTaggedSampled(100_000, N));
    assert.ok(out.length >= Math.min(100_000, N) * 0.95, `~100k rows (got ${out.length})`);
    assert.ok(ms < 20_000, `sample under 20 s (took ${ms.toFixed(0)} ms)`);
  });

  await test('stats() — the 7-scan tally block (TTL-cached 5 s)', () => {
    const { ms } = timed('stats cold', () => db.stats());
    const warm = timed('stats warm (cache)', () => db.stats());
    assert.ok(ms < 30_000, `cold stats under 30 s (took ${ms.toFixed(0)} ms)`);
    // Pins the cache-stamp fix: computeStats() can take longer than the TTL on
    // a huge library, so a start-of-compute stamp made every call a miss.
    assert.ok(warm.ms < 1_000, `warm stats served from cache (took ${warm.ms.toFixed(0)} ms)`);
  });

  console.log('\nserver: payload build (synchronous on the controller event loop)');

  for (const cap of [25_000, 100_000, N]) {
    if (cap > N) continue;
    await test(`project + stringify ${cap.toLocaleString()} rows`, () => {
      const rows = cap === N ? fullRows : fullRows.slice(0, cap);
      const { out: projected, ms: projMs } = timed('row projection', () => projectRows(rows));
      const { out: json, ms: strMs } = timed('JSON.stringify', () => JSON.stringify({ tracks: projected }));
      const { out: gz, ms: gzMs } = timed('gzip (Caddy does this per request)', () => gzipSync(json));
      console.log(`      payload: ${mb(json.length)} raw → ${mb(gz.length)} gzipped`);
      assert.ok(projMs + strMs < 30_000, `projection+stringify under 30 s (took ${(projMs + strMs).toFixed(0)} ms)`);
      assert.ok(gzMs < 60_000, 'gzip sane');
    });
  }

  console.log('\nserver: sound-map projection support');

  await test(`allAudioVectors() at ${AUDIO_N.toLocaleString()} (the UMAP child's input)`, () => {
    const { out, ms } = timed('load Float32 vectors', () => db.allAudioVectors());
    assert.equal(out.length, AUDIO_N);
    // Working-set arithmetic for the projection child (rss deltas are too
    // GC-noisy to trust): Float32 storage is n·dim·4 B; umap-js consumes
    // number[][], which inflates every float to an 8-byte double inside a
    // pointer-holding JS array (~×3 with headers) — all resident at once,
    // BEFORE UMAP's own KNN graph and optimisation state.
    const f32 = N * AUDIO_DIM * 4;
    console.log(`      at ${N.toLocaleString()}: ~${mb(f32)} Float32 + ~${mb(f32 * 3)} as number[][] before UMAP's graph`);
    assert.ok(ms < 30_000 * (AUDIO_N / 50_000 + 0.5), `vector load sane (took ${ms.toFixed(0)} ms)`);
  });

  await test(`setMapCoordsBulk(${N.toLocaleString()}) — the projection child's final transaction`, () => {
    const coords = fullRows.map((t: any, i: number) => ({ id: t.id, x: (i % 1000) / 1000, y: ((i * 7) % 1000) / 1000 }));
    const { ms } = timed('bulk coord write', () => db.setMapCoordsBulk(coords));
    assert.equal(db.mapCoordsCount(), N);
    assert.ok(ms < 180_000, `bulk write under 3 min (took ${ms.toFixed(0)} ms)`);
  });

  console.log('\nclient: pure layout pipeline (imported from web/components/observatory/data.ts)');

  // Rebuild the client's RawTrack view from the projected rows — exactly what
  // useObservatory feeds layoutTracks after JSON.parse.
  const rawTracks: RawTrack[] = projectRows(fullRows) as unknown as RawTrack[];

  let soundLaid: ReturnType<typeof layoutTracks> | null = null;
  await test(`layoutTracks(${N.toLocaleString()}) — sound-map mode (70% mapped)`, () => {
    const { out, ms } = timed('layout (sound map)', () => layoutTracks(rawTracks));
    soundLaid = out;
    assert.equal(out.tracks.length, N);
    assert.ok(out.soundMap, 'sound-map placement engaged at 70% coverage');
    for (const t of out.tracks.slice(0, 5_000)) {
      assert.ok(t.x > -400 && t.x < 1400 && t.y > -400 && t.y < 1400, 'coords near the disc');
    }
    assert.ok(ms < 20_000, `layout under 20 s (took ${ms.toFixed(0)} ms)`);
  });

  await test(`layoutTracks(${N.toLocaleString()}) — genre-cluster fallback (0% mapped)`, () => {
    const stripped = rawTracks.map((t) => ({ ...t, mapX: null, mapY: null }));
    const { out, ms } = timed('layout (genre clusters)', () => layoutTracks(stripped));
    assert.equal(out.tracks.length, N);
    assert.ok(!out.soundMap);
    assert.ok(ms < 20_000, `layout under 20 s (took ${ms.toFixed(0)} ms)`);
  });

  await test(`buildSynapseLinks(${N.toLocaleString()}) — spatial-grid nearest neighbour`, () => {
    const { out, ms } = timed('synapse links', () => buildSynapseLinks(soundLaid!.tracks));
    assert.ok(out.length > 0 && out.length <= N, `sane link count (got ${out.length.toLocaleString()})`);
    for (const [a, b] of out.slice(0, 2_000)) {
      assert.ok(a >= 0 && b < N && a < b, 'ordered in-range index pairs');
    }
    assert.ok(ms < 20_000, `links under 20 s (took ${ms.toFixed(0)} ms)`);
  });

  db.close();
  raw.close();
  rmSync(stateDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall observatory scale tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
