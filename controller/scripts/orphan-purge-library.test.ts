// The orphan purge against a real library DB: what a release does to the
// catalogue, and what it leaves alone. scripts/orphan-purge.test.ts drives the
// directories with injected ids; these cases need rows, because the point of
// each is what a row says once the dir is back.
//
// Run: `npm test -- orphan-purge-library`.

import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const DAY = 86400_000;

const stateDir = createTempDir(join(tmpdir(), 'subwave-orphan-library-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const cache = await import('../src/music/stem-cache.js');
const purge = await import('../src/music/orphan-purge.js');
const { requireDb } = await import('../src/music/library-db/handle.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

const ROOT = cache.stemsRoot();
const QU = join(ROOT, '.orphan-quarantine');
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
const T0 = Date.now();
const META = { title: 'Song', artist: 'A', album: 'B', duration: 200 };

// 'keep' stays in the library throughout, so an id set is never empty.
db.upsertTrackMeta('keep', META);
db.upsertTrackAnalysis('keep', { bpm: 120, musicalKey: 'Am', stemsAttempted: true });

function seedStems(id: string, windows: ReadonlyArray<'head' | 'tail'>) {
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  for (const w of windows) {
    for (const s of cache.STEM_NAMES) writeFileSync(cache.stemPath(id, w, s), 'x'.repeat(64));
  }
  if (windows.includes('tail')) writeFileSync(join(dir, 'tail-meta.json'), '{}');
  const t = new Date(T0 - 2 * DAY);
  utimesSync(dir, t, t);
}

// A track that had stems, left the library, and came back inside the grace:
// its row was pruned, so the row it comes back with is a new one.
async function leaveAndReturn(id: string, windows: ReadonlyArray<'head' | 'tail'>, day: number) {
  db.upsertTrackMeta(id, META);
  db.upsertTrackAnalysis(id, { bpm: 120, musicalKey: 'Am', stemsAttempted: true });
  seedStems(id, windows);
  db.pruneMissingTracks(new Set(['keep']));
  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: T0 + day * DAY });
  assert.ok(existsSync(join(QU, id)), 'quarantined');
  db.upsertTrackMeta(id, META);
  const rep = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: T0 + (day + 1) * DAY });
  assert.deepEqual(rep.released, [id]);
}

test('a released dir with both windows complete is stamped, so the stem backfill leaves it alone', async () => {
  const id = 'back-complete';
  await leaveAndReturn(id, ['head', 'tail'], 10);
  assert.equal(db.needsStemsIds().includes(id), false);
});

test('a released dir missing a window is not stamped: the backfill still owes it stems', async () => {
  const id = 'back-head-only';
  await leaveAndReturn(id, ['head'], 20);
  assert.equal(db.needsStemsIds().includes(id), true);
});

test('a release keeps the track\'s analysis failure history', async () => {
  // The stamp says stems exist, not that an analysis answered: only a real
  // analysis may clear a failure.
  const id = 'back-failed';
  db.upsertTrackMeta(id, META);
  db.upsertTrackAnalysis(id, { bpm: 120, musicalKey: 'Am', stemsAttempted: true });
  seedStems(id, ['head', 'tail']);
  db.pruneMissingTracks(new Set(['keep']));
  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: T0 + 30 * DAY });
  db.upsertTrackMeta(id, META);
  db.recordAnalysisFailure(id, 'decode failed');
  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: T0 + 31 * DAY });
  assert.ok(existsSync(join(ROOT, id)), 'released');
  const row = requireDb().prepare('SELECT analyze_error FROM tracks WHERE id = ?').get(id) as { analyze_error: string | null };
  assert.equal(row.analyze_error, 'decode failed');
});

test('a release does not save the separation: the new row is analysed, and analysis keeps writing an existing dir', async () => {
  // What the claims in orphan-purge-pure.ts and the panel rest on. The stamp
  // answers the backfill scope only. The row came back with no analysis, so a
  // pass takes it (needsAnalysisIds), and stems ride along for an existing dir
  // whatever stems_at says (stemWriteDecision, allocateStems in analyze.ts).
  const id = 'back-analysed';
  await leaveAndReturn(id, ['head', 'tail'], 40);
  assert.equal(db.needsAnalysisIds().includes(id), true);
  assert.equal(cache.stemWriteDecision({ cacheOn: true, slotsLeft: 0, hasExistingDir: true }).want, true);
  rmSync(join(ROOT, id), { recursive: true, force: true });
});
