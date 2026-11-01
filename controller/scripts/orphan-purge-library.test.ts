// The orphan purge against a real library DB: what a release does to the
// catalogue, and what it leaves alone. scripts/orphan-purge.test.ts drives the
// directories with injected ids; these cases need rows, because the point of
// each is what a row says once the dir is back.
//
// Run: `npm test -- orphan-purge-library`.

import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { QUARANTINE_DIR } = await import('../src/music/orphan-purge-pure.js');
const rotation = await import('../src/music/id-rotation.js');
const { resolveOrphanNames } = await import('../src/music/orphan-names.js');
const { canonicalId } = await import('../src/music/id-canonical.js');
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

test('an offline share runs only the aged delete: a release waits until it is back', async () => {
  // Offline here is what an unmounted share looks like: no marker and no dirs,
  // while the catalogue remembers stems ('keep' is stamped). A visible
  // quarantine lets the aged delete through; nothing else may touch the root.
  const back = 'offline-back';
  const aged = 'offline-aged';
  const t0 = T0 + 50 * DAY;
  db.upsertTrackMeta(back, META);
  seedStems(back, ['head', 'tail']);
  seedStems(aged, ['head', 'tail']);
  db.pruneMissingTracks(new Set(['keep']));
  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: t0 });
  assert.ok(existsSync(join(QU, back)) && existsSync(join(QU, aged)));
  db.upsertTrackMeta(back, META);
  for (const e of readdirSync(ROOT)) {
    if (e !== QUARANTINE_DIR) rmSync(join(ROOT, e), { recursive: true, force: true });
  }
  const status = await cache.stemsRootStatus({ readOnly: true });
  assert.equal(status.online, false);
  const now = t0 + 8 * DAY;
  try {
    const dry = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: false, now });
    assert.deepEqual(dry.released, [], 'not offered either');
    const rep = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now });
    assert.deepEqual(rep.released, []);
    assert.ok(existsSync(join(QU, back)), 'still quarantined');
    assert.ok(!existsSync(join(ROOT, back)));
    assert.ok(!existsSync(join(QU, aged)), 'the aged delete still ran');
  } finally {
    writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
  }
  const online = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now });
  assert.deepEqual(online.released, [back], 'released as soon as the share is back');
});

// A legacy 32-hex id, which Navidrome 0.64 rotates to its canonical base62 form.
const legacyId = (n: number) => n.toString(16).padStart(32, 'e');

// adoptRotatedIds commits the rows and the journal first, and only then does
// moveStemDirs rename the dirs, one at a time. stems_at rides to the new row and
// disk absence is not backfill eligibility, so a dir lost in that window is
// never separated again.
function startRotation(old: string, seed = true) {
  const neu = canonicalId(old);
  assert.notEqual(neu, old);
  db.upsertTrackMeta(old, META);
  db.upsertTrackAnalysis(old, { bpm: 120, musicalKey: 'Am', stemsAttempted: true });
  if (seed) seedStems(old, ['head', 'tail']);
  // The walk has already written the row under its new id; adoption merges the
  // old row into it.
  db.upsertTrackMeta(neu, META);
  const live = new Set(db.allTrackIdsOrdered().filter(id => id !== old));
  assert.equal(db.adoptRotatedIds(live).adopted, 1);
  assert.equal(db.pendingIdRotations().get(old), neu);
  return { neu, live };
}

test('a pass inside a rotation leaves the old dir for the rename, so the track keeps its stems', async () => {
  const old = legacyId(1);
  const { neu, live } = startRotation(old);
  const now = T0 + 60 * DAY;
  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now });
  assert.ok(existsSync(join(ROOT, old)), 'left for the rename');
  assert.ok(!existsSync(join(QU, old)), 'not quarantined');

  await rotation.adoptAndPrune(live);
  assert.ok(await cache.hasWindow(neu, 'head') && await cache.hasWindow(neu, 'tail'), 'the rename found it');

  await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now: now + 8 * DAY });
  assert.ok(await cache.hasWindow(neu, 'head') && await cache.hasWindow(neu, 'tail'), 'still there a week on');
  assert.equal(db.needsStemsIds().includes(neu), false, 'stamped, with stems to show for it');
  db.acknowledgeIdRotations(db.pendingIdRotations());
});

test('the track list and a dry run agree: a dir mid-rotation is not an orphan', async () => {
  const old = legacyId(2);
  startRotation(old);
  const now = T0 + 70 * DAY;
  const dry = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: false, now });
  assert.equal(dry.quarantined, 0);
  assert.ok(!(await purge.listOrphanDirNames(new Set(db.allTrackIdsOrdered()), now)).includes(old));
  db.acknowledgeIdRotations(db.pendingIdRotations());
  rmSync(join(ROOT, old), { recursive: true, force: true });
});

test('a pass does not count a rotating dir towards the ceiling either', async () => {
  // A whole library rotates at once on the Navidrome upgrade. Read as orphans,
  // those dirs would trip the ceiling and hold the night's real work.
  const olds = Array.from({ length: 120 }, (_, i) => legacyId(100 + i));
  for (const old of olds) startRotation(old);
  const now = T0 + 80 * DAY;
  const rep = await purge.runScheduledOrphanPurge(db.allTrackIdsOrdered(), now);
  assert.equal(rep.refused, undefined);
  assert.equal(rep.quarantined, 0);
  db.acknowledgeIdRotations(db.pendingIdRotations());
  for (const old of olds) rmSync(join(ROOT, old), { recursive: true, force: true });
});

test('an old id already quarantined comes back for the rename to find', async () => {
  // Quarantined by a build without the journal check, while the journal is
  // still open: it reads as known, so the pass releases it to its old slot.
  const old = legacyId(3);
  const { neu, live } = startRotation(old, false);
  const dir = join(QU, old);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.orphaned-at'), String(T0));
  for (const w of ['head', 'tail']) {
    for (const s of cache.STEM_NAMES) writeFileSync(join(dir, `${w}-${s}.flac`), 'x'.repeat(64));
  }
  writeFileSync(join(dir, 'tail-meta.json'), '{}');
  const now = T0 + 90 * DAY;
  const rep = await purge.runOrphanPurge({ knownIds: db.allTrackIdsOrdered(), confirm: true, now });
  assert.ok(rep.released.includes(old));
  await rotation.adoptAndPrune(live);
  assert.ok(await cache.hasWindow(neu, 'head') && await cache.hasWindow(neu, 'tail'));
  db.acknowledgeIdRotations(db.pendingIdRotations());
});

// The names half of orphan-names.ts against a real library, so its reads can move
// without changing an answer. Run on the raw SQL before the move and after it.
const play = (trackId: string, title: string, playedAt: string, extra: Record<string, unknown> = {}) =>
  db.recordPlay({ trackId, title, artist: 'Air Artist', album: 'Air Album', playedAt, source: 'dj', ...extra } as never);

test('a dir is named from its track row first, and a row wins over a play', async () => {
  db.upsertTrackMeta('named-row', { title: 'Row Title', artist: 'Row Artist', album: 'Row Album', duration: 200 });
  play('named-row', 'Air Title', '2026-10-01T10:00:00.000Z');
  const got = await resolveOrphanNames(['named-row'], { logDir: join(stateDir, 'no-logs'), stateDir });
  assert.deepEqual(got.get('named-row'), { title: 'Row Title', artist: 'Row Artist', album: 'Row Album', source: 'library' });
});

test('with no row, the newest play names it', async () => {
  play('played-only', 'Older Title', '2026-09-01T10:00:00.000Z');
  play('played-only', 'Newer Title', '2026-10-01T10:00:00.000Z');
  const got = await resolveOrphanNames(['played-only'], { logDir: join(stateDir, 'no-logs'), stateDir });
  assert.deepEqual(got.get('played-only'), { title: 'Newer Title', artist: 'Air Artist', album: 'Air Album', source: 'plays' });
});

test('more ids than one IN list holds still all resolve, and an unknown id stays unnamed', async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `bulk-${i}`);
  db.upsertTrackMeta('bulk-1200', { title: 'Last Of The Batch', artist: 'A', album: 'B', duration: 200 });
  play('bulk-0', 'First Of The Batch', '2026-10-01T10:00:00.000Z');
  const got = await resolveOrphanNames(ids, { logDir: join(stateDir, 'no-logs'), stateDir });
  assert.equal(got.get('bulk-1200')?.title, 'Last Of The Batch');
  assert.equal(got.get('bulk-0')?.title, 'First Of The Batch');
  assert.equal(got.get('bulk-7'), undefined);
  assert.equal(got.size, 2);
});

test('a closed library answers with fewer names, never an error', async () => {
  db.upsertTrackMeta('while-closed', { title: 'Unreachable', artist: 'A', album: 'B', duration: 200 });
  db.close();
  try {
    const got = await resolveOrphanNames(['while-closed'], { logDir: join(stateDir, 'no-logs'), stateDir });
    assert.equal(got.size, 0);
  } finally {
    await db.open({ embeddingDim: 768, adoptStoredDim: true });
  }
});
