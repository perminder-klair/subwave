import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-task-3-schema-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { requireDb } = await import('../src/music/library-db/handle.js');

function columns(): string[] {
  return (requireDb().prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(row => row.name);
}

function writeLanguageRows(): void {
  const raw = requireDb();
  raw.prepare(`UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?`).run('Spanish', '["Spanish","English"]', 'spanish');
  raw.prepare(`UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?`).run(null, '["Hindi"]', 'hindi');
}

test.after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

test('fresh library schema creates language query columns and serves both query shapes', async () => {
  await db.open({ embeddingDim: 4 });
  db.upsertTrackMeta('spanish', { title: 'Uno', artist: 'A', album: 'X' });
  db.upsertTrackMeta('hindi', { title: 'Do', artist: 'B', album: 'Y' });
  writeLanguageRows();

  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.deepEqual(db.songsByLanguage('Hindi').map(row => row.id), ['hindi']);
  assert.deepEqual(db.languagesByIds(['spanish', 'hindi']).get('spanish'), {
    language: 'Spanish', languages: ['Spanish', 'English'],
  });
});

test('upgrading a version-29 library adds language columns without losing rows', async () => {
  db.close();
  const raw = requireDb;
  // The fresh test has the current schema; make this file represent the last
  // pre-language release, retaining the rows and their ordinary metadata.
  const connection = (await import('better-sqlite3')).default;
  const Database = connection as any;
  const file = join(stateDir, 'library.db');
  const old = new Database(file);
  // The current schema creates this index outside the user_version chain.
  // Remove it with the language columns when simulating the pre-language
  // schema; SQLite cannot drop a column that the index still references.
  old.exec('DROP INDEX IF EXISTS idx_tracks_language_stats;');
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 29');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((raw().pragma('user_version', { simple: true }) as number), 32);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.equal(db.getTrack('spanish')?.title, 'Uno');
});
