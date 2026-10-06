// Regression coverage for the library tag-state invariant.
//
// A track is tagged only when moods is a non-empty JSON array. An empty array
// is valid uncertainty data from the tagger, but it must remain in the
// untagged pool and out of tagged browse, picker, and stats views.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-library-db-tags-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 4 });

for (const id of ['null-moods', 'empty-moods', 'tagged']) {
  db.upsertTrackMeta(id, {
    title: id,
    artist: 'Test Artist',
    album: 'Test Album',
    genres: id === 'tagged' ? ['Tagged Genre'] : ['Pending Genre'],
  });
}

db.upsertTrackTags('empty-moods', {
  moods: [],
  energy: 'medium',
  source: 'uncertain-llm',
  model: 'test-model',
});
db.upsertTrackTags('tagged', {
  moods: ['calm'],
  energy: 'medium',
  source: 'llm',
  model: 'test-model',
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test('tag state is based on non-empty editorial moods', () => {
  assert.equal(db.hasTags('null-moods'), false, 'NULL moods are untagged');
  assert.equal(db.hasTags('empty-moods'), false, 'empty moods are untagged');
  assert.equal(db.hasTags('tagged'), true, 'non-empty moods are tagged');
  assert.equal(db.countTagged(), 1, 'coverage counts only genuinely tagged rows');
  assert.deepEqual(db.allTaggedIds(), ['tagged'], 'tagged IDs use the strict predicate');
});

test('all untagged scopes include empty mood arrays', () => {
  assert.deepEqual(
    db.untaggedIds().sort(),
    ['empty-moods', 'null-moods'],
    'both NULL and empty moods remain in the untagged pool',
  );
  const seedIds = [...db.trackIdsByGenreDecade().values()].flat().sort();
  assert.deepEqual(
    seedIds,
    ['empty-moods', 'null-moods'],
    'untagged seed selection includes empty mood arrays',
  );
});

test('tagged browse and picker scopes exclude uncertain rows', () => {
  assert.deepEqual(
    db.songsByMood('calm').map(track => track.id),
    ['tagged'],
    'mood browse excludes empty mood arrays',
  );
  assert.deepEqual(
    db.songsByEnergy('medium').map(track => track.id),
    ['tagged'],
    'energy picker excludes uncertain rows without moods',
  );
});

test('tagged statistics exclude uncertain rows', () => {
  const stats = db.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.mirrorTotal, 3);
  assert.deepEqual(stats.byMood, { calm: 1 });
  assert.deepEqual(stats.byEnergy, { medium: 1 });
  assert.deepEqual(stats.byGenre, { 'Tagged Genre': 1 });
  assert.deepEqual(stats.bySource, { llm: 1 });
});

test('aggregate statistics retain null, blank and multi-tag counting semantics', async () => {
  const { requireDb } = await import('../src/music/library-db/handle.js');
  const raw = requireDb();
  raw.prepare("UPDATE tracks SET tagged_at = '2026-01-01' WHERE id = 'tagged'").run();
  const insert = raw.prepare(`INSERT INTO tracks (id, artist, moods, genres, energy, source, tagged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('same-artist', ' TEST ARTIST ', '["calm","focused"]', '["Rock","Jazz"]', 'high', 'manual', '2026-02-01');
  insert.run('other-artist', 'Other', '["calm","focused"]', '["Jazz"]', 'high', null, '2026-03-01');
  insert.run('blank-artist', ' ', '["calm","calm"]', null, null, 'manual', '2026-04-01');
  insert.run('null-artist', null, '["calm"]', '[]', 'low', '', '2026-03-01');
  insert.run('untagged-newest', 'Excluded', null, '["Excluded"]', 'low', 'excluded', '2099-01-01');
  insert.run('reserved-source', 'Other', '["focused"]', null, 'medium', 'constructor', null);
  db.invalidateStats();

  const stats = db.stats();
  assert.deepEqual(stats, {
    total: 6, mirrorTotal: 9, distinctArtists: 2,
    byMood: { calm: 6, focused: 3 },
    byEnergy: { medium: 2, high: 2, low: 1 },
    byGenre: { 'Tagged Genre': 1, Rock: 1, Jazz: 2 },
    bySource: { llm: 1, manual: 2, '': 1, constructor: 1 },
    withEmbedding: 0, withAudioEmbedding: 0, updatedAt: '2026-04-01',
  });
  assert.equal(db.stats(), stats, 'the existing warm-cache behavior is retained');
});
