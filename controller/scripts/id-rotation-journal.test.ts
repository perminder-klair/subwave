import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'id-rotation-journal-'));
process.env.STATE_DIR = state;
const db = await import('../src/music/library-db.js');
after(() => { db.close(); rmSync(state, { recursive: true, force: true }); });
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const sql = db.requireDb();
const OLD = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW = '6VHl3uR4kss6sUPKA8Cwnk';

test('a journal write failure rolls back adoption, including tags and vectors', () => {
  db.upsertTrackMeta(OLD, { title: 'Song', artist: 'Artist' });
  db.upsertTrackTags(OLD, { moods: ['warm'], energy: 'medium', source: 'llm', confidence: 1 });
  db.upsertTrackVector(OLD, [1, 2, 3, 4, 5, 6, 7, 8]);
  db.upsertTrackMeta(NEW, { title: 'Song', artist: 'Artist' });
  // SQLite aborts after the copy operations, at the journal write itself.
  db.runDdl(sql, `CREATE TRIGGER fail_rotation BEFORE INSERT ON id_rotation_journal
    BEGIN SELECT RAISE(ABORT, 'injected journal write failure'); END`);
  try {
    assert.throws(() => db.adoptRotatedIds(new Set([NEW])), /injected journal write failure/);
    assert.deepEqual(sql.prepare('SELECT moods FROM tracks WHERE id = ?').get(OLD), { moods: '["warm"]' });
    assert.deepEqual(sql.prepare('SELECT moods FROM tracks WHERE id = ?').get(NEW), { moods: null });
    assert.ok(sql.prepare('SELECT id FROM track_vectors WHERE id = ?').get(OLD));
    assert.equal(sql.prepare('SELECT id FROM track_vectors WHERE id = ?').get(NEW), undefined);
    assert.equal(db.pendingIdRotations().size, 0);
  } finally {
    db.runDdl(sql, 'DROP TRIGGER fail_rotation');
  }
});

test('acknowledgement consumes only its snapshot and preserves a later adoption', () => {
  db.adoptRotatedIds(new Set([NEW]));
  const snapshot = db.pendingIdRotations();
  const old2 = 'zzzzzzzzzzzzzzzzzzzzzz', new2 = '3LyqmwQBm5IRqlVjNYASwb';
  db.upsertTrackMeta(old2, { title: 'Second', artist: 'Artist' });
  db.upsertTrackMeta(new2, { title: 'Second', artist: 'Artist' });
  db.adoptRotatedIds(new Set([NEW, new2]));
  db.acknowledgeIdRotations(snapshot);
  assert.deepEqual(db.pendingIdRotations(), new Map([[old2, new2]]));
  db.acknowledgeIdRotations(db.pendingIdRotations());
  assert.equal(db.pendingIdRotations().size, 0);
});
