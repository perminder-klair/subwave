import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import {migrate, SCHEMA_VERSION} from '../src/sleeve-notes/db.js';

test('initial schema survives idempotent initialisation and cold reopen with decisions and pending work intact', async () => {
  const root = createTempDir(join(tmpdir(), 'subwave-sleeve-schema-'));
  try {
    const path = join(root, 'notes.db');
    let db = new Database(path); migrate(db);
    db.prepare("INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('artist','Band','now','now')").run();
    db.prepare("INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at) VALUES ('job','researcher','artist','artist','extract-wikipedia','queued','now','now')").run();
    const before = db.prepare('SELECT * FROM sleeve_research_jobs').all();
    migrate(db); db.close();
    db = new Database(path); migrate(db);
    assert.equal(db.pragma('user_version', {simple:true}), SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT * FROM sleeve_research_jobs').all(), before);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
  } finally { await removeTempDir(root); }
});


for (const version of [1, 2]) {
  test(`public schema ${version} upgrades the derived source match without losing saved data`, () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec('DROP INDEX idx_sleeve_connection_source_local; ALTER TABLE sleeve_connection_edges DROP COLUMN source_local_track_id');
      db.pragma(`user_version=${version}`);
      db.prepare("INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('kept','Band','now','now')").run();
      migrate(db);
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('sleeve_connection_edges') WHERE name='source_local_track_id'").get());
      assert.ok(db.prepare("SELECT 1 FROM sleeve_artists WHERE id='kept'").get());
      assert.ok((db.pragma('foreign_key_list(sleeve_connection_edges)') as Array<{from:string;on_delete:string}>).some(
        key => key.from === 'source_local_track_id' && key.on_delete === 'SET NULL'));
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      migrate(db);
    } finally { db.close(); }
  });
}
