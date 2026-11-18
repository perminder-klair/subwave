// Configurable on-disk fat-row comparison; structural gates live in library-lookups.
// The last case times a strict show's pool over unmeasured rows (#2235).
// Reopened means a new connection, not flushed OS caches. Timers measure query +
// mapping (serialization is outside the timing). Bytes are internal DB records;
// outward payload compatibility is separately pinned. maxRSS is cumulative for
// this process, not an isolated per-query allocation measurement.
// LOOKUP_SCALE_N=76289 LOOKUP_SCALE_TMP=/var/tmp npm run bench:lookups
import { createTempDir } from './test-utils/temp-dir.js';
import type { TrackRow } from '../src/music/library-db.js';
import assert from 'node:assert/strict';
import { rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { envInt, envStr } from '../src/util/env.js';
const n = envInt('LOOKUP_SCALE_N', 2000, { min: 1 });
const dir = createTempDir(join(envStr('LOOKUP_SCALE_TMP', tmpdir()), 'subwave-lookup-scale-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 3 });
const d = db.getDb()!;
const fat = JSON.stringify(Array.from({ length: 180 }, (_, i) => i * 400));
const pace = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, value: 0.4 })));
// songsByEnergy parses this column for the tail's half of the instrumental verdict.
const outro = JSON.stringify({ startMs: 180000, ending: 'fade', beats: Array.from({ length: 40 }, (_, i) => 180000 + i * 500), bars: [180000], vocalRanges: [] });
// Seed a genuine v26 schema, then measure the one-time upgrade.
db.runDdl(d, `DROP TRIGGER IF EXISTS tracks_moods_insert; DROP TRIGGER IF EXISTS tracks_moods_update;
 DROP TRIGGER IF EXISTS tracks_moods_delete; DROP TABLE IF EXISTS track_moods;
 DROP INDEX IF EXISTS idx_tracks_energy; PRAGMA user_version=26;`);
const insert = d.prepare(`INSERT INTO tracks(id,moods,audio_moods,energy,beats_json,bars_json,
 pace_json,key_ranges_json,audio_mood_scores_json,structure_json,vocal_ranges_json,outro_json)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
d.transaction(() => {
  for (let i = 0; i < n; i++) insert.run(`t${i}`, JSON.stringify([i % 3 ? 'other' : 'reflective', i % 97 ? 'common' : 'rare']),
    i % 2 ? '["reflective"]' : '[]', i % 3 ? 'high' : 'low', fat, fat, pace, fat, fat,
    '[{"startMs":0,"endMs":30000,"kind":"intro"}]', '[]', outro);
})();
const size = () => Object.fromEntries(['library.db', 'library.db-wal'].map(f => [f, (() => { try { return statSync(join(dir, f)).size; } catch { return 0; } })()]));
db.checkpointWal();
console.log(JSON.stringify({ n, node: process.version, before: size() }));
const start = performance.now();
await db.migrate(3);
console.log(JSON.stringify({ migrationMs: performance.now() - start, after: size() }));
db.checkpointWal();
console.log(JSON.stringify({ checkpointed: size() }));
async function measure(label: string, fn: () => unknown[]) {
  await delay(0);
  const start = performance.now();
  const timer = delay(0).then(() => performance.now() - start);
  const rows = fn();
  const ms = performance.now() - start;
  const queryTimerDelayMs = await timer;
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  console.log(JSON.stringify({ label, rows: rows.length, ms, bytes, timerDelayMs: queryTimerDelayMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
  return rows.length;
}
try {
  for (const mode of ['reopened', 'warm']) {
    if (mode === 'reopened') { db.close(); await db.open({ embeddingDim: 3 }); }
    for (const mood of ['reflective', 'rare']) {
      const old = await measure(`${mode} old mood ${mood}`, () => (db.getDb()!.prepare(`SELECT * FROM tracks WHERE
        EXISTS (SELECT 1 FROM json_each(tracks.moods) WHERE value=?) OR
        EXISTS (SELECT 1 FROM json_each(tracks.audio_moods) WHERE value=?)`).all(mood, mood) as TrackRow[]).map(db.rowToTrack));
      const current = await measure(`${mode} current mood ${mood}`, () => db.songsByMood(mood));
      assert.equal(current, old);
    }
    const old = await measure(`${mode} old energy`, () => (db.getDb()!.prepare('SELECT * FROM tracks NOT INDEXED WHERE energy=?').all('low') as TrackRow[]).map(db.rowToTrack));
    assert.equal(await measure(`${mode} current energy`, () => db.songsByEnergy('low')), old);
  }
  // #2235: a strict show's per-pick pool over what a lean install leaves unknown
  // (no vocal ranges, energy or genres). A show filter that looked each such row
  // up again (library.get, the whole fat row) cost 2-3 s at 50k for the same
  // answer. The library module is loaded so a lookup would really read.
  db.getDb()!.prepare('UPDATE tracks SET vocal_ranges_json = NULL, energy = NULL, genres = NULL').run();
  const library = await import('../src/music/library.js');
  const { strictShowLibraryPool } = await import('../src/music/show-recency.js');
  await library.load();
  const shows: Array<[string, { vocals?: string; energies?: string[]; genres?: string[] }]> = [
    ['vocals', { vocals: 'instrumental' }],
    ['energy', { energies: ['low'] }],
    ['genre', { genres: ['Ambient'] }],
  ];
  for (const [lock, show] of shows) {
    await measure(`strict pool ${lock}`, () => strictShowLibraryPool(library.candidateFilterTracks(), {
      show: { filtersStrict: true, ...show }, excludedIds: null, resolvedGenres: show.genres ?? [],
    }) ?? []);
  }
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
