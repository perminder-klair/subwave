// A library reset must leave the live handle on the NEW, empty library.db.
//
// library.reset() closes the handle and deletes library.db and its -wal/-shm
// sidecars, then reopens. Anything that lazily calls library.load() meanwhile —
// a track start's recordPlay, a listener request, a picker tool — finds no
// handle and reopens DB_PATH itself. With the deletes awaited one by one, that
// reopen could land on the OLD file just before it was unlinked, and the
// controller then kept serving the wiped tags from a deleted inode while every
// later write was lost. The deletes are synchronous now, so no reopen can land
// between close and unlink.
//
// Real library.db in a temp state dir.
//
// Run: `npm test -- library-reset-race`.

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-library-reset-'));
process.env.STATE_DIR = stateRoot;

const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const DB_PATH = path.join(stateRoot, 'library.db');

function seed(n: number) {
  for (let i = 0; i < n; i++) {
    db.upsertTrackMeta(`old-${i}`, { title: `Old ${i}`, artist: 'Before' });
    db.upsertTrackTags(`old-${i}`, { moods: ['warm'], energy: 'medium', source: 'manual', confidence: 1 });
  }
}

test('lazy loads racing a reset end up on the fresh file, not the deleted one', async () => {
  for (let round = 0; round < 10; round++) {
    await library.load();
    seed(200);
    assert.ok(db.countTagged() >= 200);

    // Keep calling load() on every event-loop turn until the reset resolves.
    let done = false;
    const reset = library.reset().then(() => { done = true; });
    const racers: Promise<void>[] = [];
    while (!done) {
      racers.push(library.load());
      await new Promise((r) => setImmediate(r));
    }
    await reset;
    await Promise.all(racers);

    assert.equal(db.countTagged(), 0, `round ${round}: the handle still serves wiped data`);

    // A write after the reset must land in the file on disk.
    db.upsertTrackMeta(`new-${round}`, { title: 'New', artist: 'After' });
    db.upsertTrackTags(`new-${round}`, { moods: ['warm'], energy: 'medium', source: 'manual', confidence: 1 });
    const disk = new Database(DB_PATH, { readonly: true });
    try {
      const row = disk.prepare('SELECT COUNT(*) AS n FROM tracks WHERE id = ?').get(`new-${round}`) as { n: number };
      assert.equal(row.n, 1, `round ${round}: a post-reset write did not reach library.db`);
    } finally {
      disk.close();
    }
  }
  library.shutdown();
});
