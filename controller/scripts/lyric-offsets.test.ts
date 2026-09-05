// Integration coverage for the listener-scoped lyric-offset store and its
// migration. Uses a real temporary SQLite database because an upsert that only
// works in a mocked handle is not useful migration coverage.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-lyrics-'));
  process.env.STATE_DIR = stateDir;
  const db = await import('../src/music/library-db.js');

  try {
    await db.open({ embeddingDim: 768, adoptStoredDim: true });
    const raw = db.requireDb();
    assert.equal(raw.pragma('user_version', { simple: true }), 26);

    // Recreate the exact predecessor shape: a deployed v25 database has every
    // prior migration but no lyric_offsets table. Reopen must apply v26.
    raw.prepare('DROP TABLE lyric_offsets').run();
    raw.pragma('user_version = 25');
    db.close();
    await db.open({ embeddingDim: 768, adoptStoredDim: true });

    const migrated = db.requireDb();
    assert.equal(migrated.pragma('user_version', { simple: true }), 26);
    assert.equal(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lyric_offsets'").get()?.name,
      'lyric_offsets',
    );

    db.setLyricOffset('client-alpha', 'song-1', 1200);
    db.setLyricOffset('client-bravo', 'song-1', -400);
    db.setLyricOffset('client-alpha', 'song-2', 900);
    assert.equal(db.getLyricOffset('client-alpha', 'song-1'), 1200);
    assert.equal(db.getLyricOffset('client-bravo', 'song-1'), -400);
    assert.equal(db.getLyricOffset('client-alpha', 'song-2'), 900);

    db.setLyricOffset('client-alpha', 'song-1', 1500);
    assert.equal(db.getLyricOffset('client-alpha', 'song-1'), 1500, 'upsert replaces only that client/track pair');
    assert.equal(db.getLyricOffset('client-bravo', 'song-1'), -400, 'one client cannot overwrite another client');
    console.log('✓ lyric offset migration and isolation checks passed');
  } finally {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
