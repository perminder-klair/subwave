// Admin-console reads against a large on-disk library (#1937). Not a test:
// numbers only, run by hand. Seeds a realistic fat-row DB once (analysis
// blobs, text + CLAP vectors, facet rows, mood index) and times each
// synchronous library.db read an admin page load or poll reaches. Every one of
// them runs on the controller's event loop, so its time IS the stall every
// other request (health, now-playing, listener polls) waits out.
//
//   ADMIN_SCALE_N=150000 ADMIN_SCALE_TMP=/var/tmp npm run bench:admin
//
// ADMIN_SCALE_SEED=<dir> keeps the seeded DB between runs (150k rows is ~2 GB
// and ~30 s to seed); each run works on a fresh copy so a schema change in the
// code under test cannot leak into the next comparison. One process start to
// finish: the seed runs in-process and a cached seed is only ever copied.
import { createTempDir } from './test-utils/temp-dir.js';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mock } from 'node:test';
import { envInt, envStr } from '../src/util/env.js';

const N = envInt('ADMIN_SCALE_N', 20000, { min: 1000 });
const TEXT_DIM = 768;
const AUDIO_DIM = 512;
const base = envStr('ADMIN_SCALE_TMP', tmpdir());
const seedDir = envStr('ADMIN_SCALE_SEED', '');
const workDir = createTempDir(join(base, 'subwave-admin-scale-'));
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOODS = ['hazy', 'reflective', 'calm', 'night', 'rainy', 'romantic', 'energetic', 'driving', 'celebratory', 'melancholy', 'warm', 'cold', 'dusty', 'cosmic', 'urban', 'pastoral', 'tense', 'playful', 'solemn', 'glassy'];
const GENRES = Array.from({ length: 150 }, (_, i) => `Genre ${i}`);

// Seed through the real schema (open() runs every migration), then write with
// a raw connection in big transactions: the public upserts autocommit per row.
async function seed(dir: string) {
  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: TEXT_DIM });
  db.close();
  const raw = new Database(join(dir, 'library.db'));
  sqliteVec.load(raw);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = OFF');
  const rng = rng32(0x1937);
  const ins = raw.prepare(`INSERT INTO tracks (id, title, artist, album, year, genres, duration_sec,
    lastfm_tags, lyric_excerpt, enriched_at, moods, energy, source, confidence, tagger_version, prompt_hash,
    model, tagged_at, bpm, musical_key, intro_ms, analysis_confidence, analysis_version, loudness_lufs, peak_db,
    structure_json, vocal_ranges_json, pace_json, beats_json, bars_json, key_ranges_json, audio_moods,
    audio_mood_scores_json, outro_json, map_x, map_y, stems_at, analyze_error, analyze_failed_at,
    analyze_fail_count, album_id, artist_id, lead_silence_ms, tail_silence_ms, tail_start_ms)
    VALUES (${Array(45).fill('?').join(',')})`);
  const vec = raw.prepare('INSERT INTO track_vectors (id, embedding) VALUES (?, ?)');
  const avec = raw.prepare('INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)');
  const tv = new Float32Array(TEXT_DIM);
  const av = new Float32Array(AUDIO_DIM);
  const chunk = raw.transaction((from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const id = `tr-${String(i).padStart(7, '0')}`;
      const analysed = rng() < 0.92;
      const failed = !analysed && rng() < 0.3;
      const dur = 150 + Math.floor(rng() * 240);
      const bpm = 70 + rng() * 100;
      const beatMs = 60000 / bpm;
      const beats = Array.from({ length: Math.floor((dur * 1000) / beatMs) }, (_, k) => Math.round(k * beatMs));
      const spans = (n: number) => Array.from({ length: n }, (_, k) => ({ startMs: Math.round(dur * 1000 * k / n), endMs: Math.round(dur * 1000 * (k + 1) / n) }));
      const moods = Array.from({ length: 2 + Math.floor(rng() * 3) }, () => MOODS[Math.floor(rng() * MOODS.length)]);
      const scores = Object.fromEntries(MOODS.map(m => [m, Math.round(rng() * 1000) / 1000]));
      ins.run(
        id, `Track ${i} title`, `Artist ${i % 30000}`, `Album ${i % 14000}`, 1960 + (i % 64),
        JSON.stringify([GENRES[Math.floor(rng() * rng() * GENRES.length)], GENRES[i % GENRES.length]]), dur,
        JSON.stringify(Array.from({ length: 10 }, (_, k) => `tag-${(i + k) % 900}`)),
        'Some lyric excerpt that runs a couple of lines long, about night drives and city lights. '.repeat(3),
        '2026-01-01T00:00:00Z', JSON.stringify([...new Set(moods)]), ['low', 'medium', 'high'][i % 3],
        i % 5 ? 'llm' : 'propagated', 0.8, 3, 'hash', 'model', '2026-01-02T00:00:00Z',
        analysed ? bpm : null, analysed ? '8A' : null, analysed ? 1200 : null, analysed ? 0.9 : null,
        analysed ? 7 : null, analysed ? -11.5 : null, analysed ? -0.4 : null,
        analysed ? JSON.stringify(spans(8).map(s => ({ ...s, kind: 'verse' }))) : null,
        analysed ? JSON.stringify(rng() < 0.8 ? spans(5) : []) : null,
        analysed ? JSON.stringify(spans(16).map(s => ({ ...s, value: 0.5 }))) : null,
        analysed ? JSON.stringify(beats) : null,
        analysed ? JSON.stringify(beats.filter((_, k) => k % 4 === 0)) : null,
        analysed ? JSON.stringify([{ startMs: 0, endMs: dur * 1000, tonic: 'A', mode: 'minor' }]) : null,
        analysed ? JSON.stringify(moods.slice(0, 2)) : null,
        analysed ? JSON.stringify(scores) : null,
        analysed ? JSON.stringify({ startMs: dur * 1000 - 20000, ending: 'fade', beats: beats.slice(-40), bars: beats.slice(-40).filter((_, k) => k % 4 === 0), vocalRanges: [] }) : null,
        analysed ? rng() : null, analysed ? rng() : null,
        analysed && rng() < 0.05 ? '2026-01-03T00:00:00Z' : null,
        failed ? 'decode failed' : null, failed ? '2026-01-03T00:00:00Z' : null, failed ? 1 + Math.floor(rng() * 3) : null,
        `al-${i % 14000}`, `ar-${i % 30000}`, analysed ? 40 : null, analysed ? 900 : null, analysed ? dur * 1000 - 900 : null,
      );
      for (let k = 0; k < TEXT_DIM; k++) tv[k] = rng() - 0.5;
      vec.run(id, Buffer.from(tv.buffer.slice(0)));
      if (analysed) {
        for (let k = 0; k < AUDIO_DIM; k++) av[k] = rng() - 0.5;
        avec.run(id, Buffer.from(av.buffer.slice(0)));
      }
    }
  });
  const t0 = performance.now();
  for (let at = 0; at < N; at += 5000) chunk(at, Math.min(N, at + 5000));
  // Facet rows: drop the table so the next open() seeds it in bulk from the
  // columns, exactly as an upgraded station's first open does.
  raw.exec('DROP TABLE track_facet_status; DELETE FROM track_facet_meta;');
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
  await db.open({ embeddingDim: TEXT_DIM });
  db.close();
  console.log(`seeded ${N} tracks in ${((performance.now() - t0) / 1000).toFixed(0)} s (${mb(statSync(join(dir, 'library.db')).size)})`);
}

// One process, no children: the seed lands in workDir directly, and a cached
// seed is only ever a file copy in either direction.
process.env.STATE_DIR = workDir;
// The coverage route's backend probe has nowhere to go here; fail it fast.
process.env.ANALYZE_URL ||= 'http://127.0.0.1:9';
const cached = seedDir ? join(seedDir, 'library.db') : '';
if (cached && existsSync(cached)) {
  copyFileSync(cached, join(workDir, 'library.db'));
} else {
  await seed(workDir);
  if (cached) {
    mkdirSync(seedDir, { recursive: true });
    copyFileSync(join(workDir, 'library.db'), cached);
  }
}
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const coverage = await import('../src/music/library-coverage.js');

const t0 = performance.now();
await db.open({ embeddingDim: TEXT_DIM, adoptStoredDim: true });
console.log(JSON.stringify({ label: 'open (migrations + open-time indexes)', ms: Math.round(performance.now() - t0) }));
await library.load();
const d = db.getDb()!;
const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
console.log(JSON.stringify({
  n: N, db: mb(statSync(join(workDir, 'library.db')).size),
  facetRows: count('SELECT COUNT(*) AS n FROM track_facet_status'),
  moodRows: count('SELECT COUNT(*) AS n FROM track_moods'),
}));

// One committed no-op write: moves changeToken(), as every tagger batch does,
// so a cache keyed on it cannot flatter a measurement.
const touch = () => d.prepare("UPDATE tracks SET title = title WHERE id = 'tr-0000000'").run();
// Genre suggestions are cached on genreInputsToken() (#1991), which a no-op
// write does not move: flip one track's genres instead.
let genreFlip = false;
const touchGenres = () => d.prepare("UPDATE tracks SET genres = ? WHERE id = 'tr-0000000'")
  .run(JSON.stringify([(genreFlip = !genreFlip) ? 'Bench A' : 'Bench B']));

function time(label: string, fn: () => unknown, runs = 3, opts: { warm?: boolean } = {}) {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    if (!opts.warm) { touch(); db.invalidateStats(); }
    const s = performance.now();
    fn();
    ms.push(Math.round(performance.now() - s));
  }
  console.log(JSON.stringify({ label, ms }));
}

// 'write' moves the token only; 'cold' also drops the in-process count caches.
async function timeAsync(label: string, fn: () => Promise<unknown>, mode: 'cold' | 'write' | 'warm', write = touch) {
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (mode !== 'warm') write();
    if (mode === 'cold') db.invalidateStats();
    const s = performance.now();
    await fn();
    ms.push(Math.round(performance.now() - s));
  }
  console.log(JSON.stringify({ label, ms }));
}

// What GET /library/coverage reads, one by one, then the route's whole call.
time('coverage: countTagged', () => library.countTagged());
time('coverage: analysedCount', () => db.analysedCount());
time('coverage: audioVectorCount', () => db.audioVectorCount());
time('coverage: vocalAnalyzedCount', () => db.vocalAnalyzedCount());
time('coverage: vectorCount', () => db.vectorCount());
time('coverage: labelOnlyVectorCount (cold)', () => db.labelOnlyVectorCount());
time('coverage: analysisFailedCount', () => db.analysisFailedCount());
await coverage.get(); // first call awaits the backend probe; time the steady state
await timeAsync('GET /library/coverage after a write, every cache cold', () => coverage.get(), 'cold');
// The poll a tagging run makes every 3 s: the library changed since the last
// one, while the label-only share sits inside its own 5-minute TTL.
await timeAsync('GET /library/coverage after a write (the tagging-run poll)', () => coverage.get(), 'write');
// The idle Library page: nothing committed since the last read.
await coverage.get();
await timeAsync('GET /library/coverage, library unchanged', () => coverage.get(), 'warm');
// GET /settings (every 30 s on the Library page), /library/browse, /library/genres,
// /library/observatory and /debug all read stats(); 5 s TTL, so each poll is cold.
time('stats() after a write — /settings, /library/browse, /library/genres, observatory', () => library.stats());
// The idle Library page's 30 s /settings poll: past the TTL, nothing committed.
library.stats();
await delay(5_200);
time('stats() past its TTL, library unchanged (idle /settings poll)', () => library.stats(), 1, { warm: true });
time('pickStats() cold — pick path', () => db.pickStats());
time('library.vocalAnalyzedCount — strict vocal show lock', () => library.vocalAnalyzedCount());
time('observatory: allTaggedSampled(25k)', () => db.allTaggedSampled(25_000, N), 1);
time('browse: filter default page', () => library.filter({ sort: 'artist', limit: 50, offset: 0 }));
time('browse: filter page at offset 50%', () => library.filter({ sort: 'artist', limit: 50, offset: Math.floor(N / 2) }));
time('browse: filter by mood, sorted by bpm', () => library.filter({ moods: ['night'], sort: 'bpm', limit: 50, offset: 0 }));
time('scenes: sceneVocabulary', () => db.sceneVocabulary());
time('analysis-failures: list 200', () => db.analysisFailures(200));
// Show-editor genre suggestions (#1976). The one-call walk is what every
// request on a changed library used to block for. The route now answers from
// the last result and walks in slices, so what to watch is the request time and
// the longest event-loop block while a walk runs, not the walk's total.
time('genre suggest: genreCentroids, the whole walk in one call', () => db.genreCentroids(), 1);
const suggest = await import('../src/music/genre-suggest.js');
async function timeWalk(label: string, fn: () => Promise<unknown>) {
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  const s = performance.now();
  await fn();
  const ms = Math.round(performance.now() - s);
  // A block just before fn() settled is only recorded once the loop turns.
  await delay(20);
  lag.disable();
  console.log(JSON.stringify({ label, ms, longestBlockMs: Math.round(lag.max / 1e6) }));
}
touchGenres();
await timeWalk('genre suggest: first request, waits for the sliced walk', () => suggest.genreSuggest());
await timeAsync('genre suggest: request, library unchanged', () => suggest.genreSuggest(), 'warm');
await timeAsync('genre suggest: request after a write, inside the refresh floor', () => suggest.genreSuggest(), 'write', touchGenres);
mock.timers.enable({ apis: ['Date'], now: Date.now() });
mock.timers.tick(suggest.GENRE_SUGGEST_REFRESH_FLOOR_MS);
touchGenres();
await timeWalk('genre suggest: request after a write past the floor, then its background walk', async () => {
  const s = performance.now();
  await suggest.genreSuggest();
  console.log(JSON.stringify({ label: 'genre suggest: that request (answered from the last walk)', ms: Math.round(performance.now() - s) }));
  await suggest.genreSuggestIdle();
});
// Past the max age a changed library is no longer answered from the last walk
// (#1991): the request waits for the re-read, which still yields between slices.
// A play is not a change to it, so an open after hours on air does not wait.
mock.timers.tick(suggest.GENRE_SUGGEST_MAX_AGE_MS);
db.recordPlay({
  trackId: 'tr-0000000', title: 'bench', artist: null, album: null, playedAt: new Date().toISOString(),
  source: 'auto', requestedBy: null, showId: null, showName: null,
});
await timeWalk('genre suggest: request after plays only, past the max age (no walk)', () => suggest.genreSuggest());
touchGenres();
await timeWalk('genre suggest: request after a genre write past the max age, waits for the re-read', () => suggest.genreSuggest());
mock.timers.reset();
db.close();
// Imported modules may hold timers; a bench must never linger.
process.exit(0);
