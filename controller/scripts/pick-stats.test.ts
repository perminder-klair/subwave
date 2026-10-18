// pickStats() (#1723): the narrow, long-cached library counts a live pick reads,
// in place of the dashboard's stats() and its ~9 full-table scans.
//
// The contracts pinned here:
//   - every field equals what stats() says for the same library, so switching
//     the pick path to pickStats() changes no decision (recency windows, show
//     locks, tool registration);
//   - a warm call costs nothing, and the cache only expires on its TTL or on
//     invalidateStats() (a handle swap);
//   - the tagged total and distinct-artist counts read only the partial index
//     idx_tracks_tagged_artist, never the wide tracks rows, and the rewritten
//     artist query counts exactly what the original one did;
//   - after the TTL a pick gets the previous numbers at once and the recompute
//     runs later, off the pick path;
//   - idsByEnergy() returns exactly the ids songsByEnergy() would, in order,
//     without mapping rows.
//
// Real better-sqlite3 DB in a temp STATE_DIR. Run: `tsx scripts/pick-stats.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-pick-stats-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const moods = ['calm', 'dark', 'warm'];
const energies = ['low', 'medium', 'high', null] as const;
for (let i = 0; i < 300; i++) {
  const id = `t${String(i).padStart(3, '0')}`;
  db.upsertTrackMeta(id, { title: `Song ${i}`, artist: i % 7 === 0 ? ` Artist ${i % 40} ` : `artist ${i % 40}`, album: 'A', duration: 200 });
  // A third untagged, so total ≠ mirrorTotal and distinctArtists counts tagged only.
  if (i % 3 !== 0) {
    const e = energies[i % 4];
    db.upsertTrackTags(id, { moods: [moods[i % 3]], energy: e ?? undefined, source: 'llm' } as never);
  }
  if (i % 5 === 0) db.upsertTrackAudioVector(id, new Float32Array(512).fill(0.1));
  if (i % 4 === 0) db.upsertTrackVector(id, [1, 2, 3, 4, 5, 6, 7, 8], null);
}
// Blank artists on tagged rows must not count as an artist.
for (const [id, artist] of [['blank1', '   '], ['blank2', '']] as const) {
  db.upsertTrackMeta(id, { title: id, artist, album: 'A', duration: 200 });
  db.upsertTrackTags(id, { moods: ['calm'], source: 'llm' } as never);
}
await library.load();

test('every pickStats field agrees with the dashboard stats()', () => {
  db.invalidateStats();
  const full = db.stats();
  db.invalidateStats();
  const p = db.pickStats();
  assert.deepEqual(p, {
    total: full.total,
    mirrorTotal: full.mirrorTotal,
    distinctArtists: full.distinctArtists,
    withEmbedding: full.withEmbedding,
    withAudioEmbedding: full.withAudioEmbedding,
    hasMoodCoverage: Object.keys(full.byMood).length > 0,
    hasEnergyCoverage: Object.keys(full.byEnergy).length > 0,
    byMood: full.byMood,
  });
  assert.deepEqual(Object.keys(p.byMood).sort(), ['calm', 'dark', 'warm'], 'per-mood counts, for the mood tools');
  assert.equal(p.mirrorTotal, 302);
  assert.ok(p.total > 0 && p.total < 302, 'untagged rows are excluded from total');
});

test('a warm picker context never recomputes expired dashboard stats', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  db.invalidateStats();
  const stats = library.pickStats();
  const labelShare = db.labelOnlyVectorCount() / stats.withEmbedding;
  db.stats();
  t.mock.timers.tick(6000);
  const prepare = t.mock.method(db.requireDb(), 'prepare');

  const ctx = buildPickerContext(pickerScope());
  assert.equal(ctx.hasTextEmbeddings, true);
  assert.equal(ctx.textIndexDegraded, labelShare > 0.5);
  assert.equal(library.labelOnlyShare(), labelShare);
  assert.equal(prepare.mock.callCount(), 0, 'warm pick preparation must not query the database');
});

test('an empty library reports no coverage', () => {
  // Empty the tracks inside a savepoint and roll back, so later tests keep the fixture.
  const d = db.requireDb();
  d.exec('SAVEPOINT empty');
  d.exec('DELETE FROM tracks');
  db.invalidateStats();
  const p = db.pickStats();
  assert.equal(p.mirrorTotal, 0);
  assert.equal(p.hasMoodCoverage, false);
  assert.equal(p.hasEnergyCoverage, false);
  d.exec('ROLLBACK TO empty');
  d.exec('RELEASE empty');
  db.invalidateStats();
});

test('the tagged counts come from the partial index alone', () => {
  const d = db.requireDb();
  const H = 'moods IS NOT NULL AND json_array_length(moods) > 0';
  const plans = [
    `SELECT COUNT(*) AS n FROM tracks WHERE ${H}`,
    `SELECT COUNT(DISTINCT k) AS n FROM (SELECT LOWER(TRIM(artist)) AS k FROM tracks WHERE ${H}) WHERE k != ''`,
  ].map((sql) => (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' ; '));
  for (const plan of plans) assert.match(plan, /USING COVERING INDEX idx_tracks_tagged_artist/, plan);
  // The original artist query, kept here as the reference for the rewrite.
  const original = (d.prepare(
    `SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS n FROM tracks
      WHERE ${H} AND artist IS NOT NULL AND TRIM(artist) != ''`,
  ).get() as { n: number }).n;
  db.invalidateStats();
  assert.equal(db.pickStats().distinctArtists, original);
  assert.equal(db.stats().distinctArtists, original);
});

test('the index never refuses a write with malformed moods JSON', () => {
  const d = db.requireDb();
  d.exec('SAVEPOINT bad');
  assert.doesNotThrow(() => d.prepare(`UPDATE tracks SET moods = '{not json' WHERE id = 't001'`).run());
  d.exec('ROLLBACK TO bad');
  d.exec('RELEASE bad');
});

test('after the TTL the old numbers are served and refreshed off the pick path', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  db.invalidateStats();
  const first = db.pickStats();
  db.upsertTrackMeta('later', { title: 'Later', artist: 'New', album: 'B', duration: 200 });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.deepEqual(db.pickStats(), first, 'expired: the previous numbers, no inline recompute');
  t.mock.timers.tick(15_000);
  assert.equal(db.pickStats().mirrorTotal, first.mirrorTotal + 1, 'the deferred refresh landed');
  t.mock.timers.reset();
  db.invalidateStats();
});

test('a warm call is free and stays cached until invalidated', () => {
  db.invalidateStats();
  const first = db.pickStats();
  db.upsertTrackMeta('late', { title: 'Late', artist: 'New', album: 'B', duration: 200 });
  const t0 = performance.now();
  const second = db.pickStats();
  const warmMs = performance.now() - t0;
  assert.deepEqual(second, first, 'within the TTL the cached counts are served');
  assert.ok(warmMs < 5, `warm call took ${warmMs.toFixed(2)} ms`);
  db.invalidateStats();
  assert.equal(db.pickStats().mirrorTotal, first.mirrorTotal + 1);
});

test('idsByEnergy matches songsByEnergy, in order', () => {
  for (const e of ['low', 'medium', 'high'] as const) {
    assert.deepEqual(library.idsByEnergy(e), library.songsByEnergy(e).map((s: any) => s.id), e);
  }
  assert.deepEqual(library.idsByEnergy('loud'), []);
  assert.equal(library.isBlockedId('t001'), false);
});

test('an energy on an untagged row counts nowhere, as in stats() (#1732)', async () => {
  // A row with an energy but no moods is outside the tagged population:
  // songsByEnergy and stats().byEnergy skip it, so idsByEnergy and
  // hasEnergyCoverage must skip it too.
  const d = db.requireDb();
  d.exec('SAVEPOINT untagged');
  d.prepare(`UPDATE tracks SET energy = NULL`).run();
  d.prepare(`UPDATE tracks SET energy = 'high', moods = NULL WHERE id = 't000'`).run();
  db.invalidateStats();
  await library.load();
  assert.deepEqual(library.idsByEnergy('high'), []);
  assert.deepEqual(library.songsByEnergy('high').map((s: any) => s.id), []);
  const full = db.stats();
  db.invalidateStats();
  assert.equal(db.pickStats().hasEnergyCoverage, Object.keys(full.byEnergy).length > 0);
  assert.equal(db.pickStats().hasEnergyCoverage, false);
  d.exec('ROLLBACK TO untagged');
  d.exec('RELEASE untagged');
  db.invalidateStats();
  await library.load();
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
