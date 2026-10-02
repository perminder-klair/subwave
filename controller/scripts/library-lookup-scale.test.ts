// Configurable on-disk fat-row comparison; structural gates live in library-lookups.
// Reopened means a new connection, not flushed OS caches. Timers measure query +
// mapping (serialization is outside the timing). Bytes are internal DB records;
// outward payload compatibility is separately pinned. maxRSS is cumulative for
// this process, not an isolated per-query allocation measurement.
// LOOKUP_SCALE_N=76289 LOOKUP_SCALE_TMP=/var/tmp npm test -- library-lookup-scale
import type { TrackRow } from '../src/music/library-db.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { envInt, envStr } from '../src/util/env.js';
const n = envInt('LOOKUP_SCALE_N', 2000, { min: 1 });
const dir = mkdtempSync(join(envStr('LOOKUP_SCALE_TMP', tmpdir()), 'subwave-lookup-scale-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 3 });
const d = db.getDb()!;
const fat = JSON.stringify(Array.from({ length: 180 }, (_, i) => i * 400));
const pace = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, value: 0.4 })));
// Seed a genuine v26 schema, then measure the one-time upgrade.
db.runDdl(d, `DROP TRIGGER IF EXISTS tracks_moods_insert; DROP TRIGGER IF EXISTS tracks_moods_update;
 DROP TRIGGER IF EXISTS tracks_moods_delete; DROP TABLE IF EXISTS track_moods;
 DROP INDEX IF EXISTS idx_tracks_energy; PRAGMA user_version=26;`);
const insert = d.prepare(`INSERT INTO tracks(id,moods,audio_moods,energy,beats_json,bars_json,
 pace_json,key_ranges_json,audio_mood_scores_json,structure_json,vocal_ranges_json)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
d.transaction(() => {
  for (let i = 0; i < n; i++) insert.run(`t${i}`, JSON.stringify([i % 3 ? 'other' : 'reflective', i % 97 ? 'common' : 'rare']),
    i % 2 ? '["reflective"]' : '[]', i % 3 ? 'high' : 'low', fat, fat, pace, fat, fat,
    '[{"startMs":0,"endMs":30000,"kind":"intro"}]', '[]');
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
const prepare = d.prepare.bind(d);
const statements: string[] = [];
d.prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
try { db.songsByMood('rare'); db.songsByEnergy('low'); }
finally { d.prepare = prepare; }
for (const sql of statements) {
  const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all('low') as Array<{ detail: string }>).map(r => r.detail).join(' | ');
  console.log(JSON.stringify({ plan }));
  assert.doesNotMatch(plan, /SCAN t\b/);
  assert.match(plan, /SEARCH/);
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
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
