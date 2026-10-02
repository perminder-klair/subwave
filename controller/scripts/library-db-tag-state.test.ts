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
