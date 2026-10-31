import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate, SCHEMA_VERSION } from '../src/sleeve-notes/db.js';

test('Sleeve Notes migration creates its isolated durable model', () => {
  const db = new Database(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((row: { name: string }) => row.name);
  const originalTables = [
    'claims', 'discoveries', 'entities', 'evidence', 'jobs', 'provider_coverage',
    'provider_identities', 'provider_local_matches', 'relationships',
    'sleeve_artists', 'sleeve_claims', 'sleeve_encounters', 'sleeve_local_attachments',
    'sleeve_provider_requests', 'sleeve_recording_releases', 'sleeve_recordings',
    'sleeve_releases', 'sleeve_research_jobs', 'sleeve_source_documents', 'uses',
  ];
  for (const table of originalTables) assert.ok(tables.includes(table), `missing table ${table}`);
  assert.ok(!tables.includes('tracks'), 'station library tables must stay outside the Sleeve Notes store');
  assert.equal(db.pragma('user_version', { simple: true }),SCHEMA_VERSION);
  db.close();
});

test('experimental and future schemas are refused without altering existing records', () => {
  for (const version of [0, 1, 2, 4, 42, 55, 56, 61, 999]) {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserve me')");
    db.pragma(`user_version = ${version}`);
    assert.throws(() => migrate(db), /Back up and reset only sleeve-notes.db/);
    assert.equal(db.pragma('user_version', { simple: true }), version);
    assert.deepEqual(db.prepare('SELECT * FROM sentinel').all(), [{value: 'preserve me'}]);
    db.close();
  }
});
