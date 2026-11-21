import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import { researchProgress, researchStorage } from '../src/sleeve-notes/research-diagnostics.js';

test('progress and storage inspection neither creates work nor changes retained evidence', () => {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES ('source','artist','artist','wikipedia','https://example.test','hash','bounded-text','Musique é','Wikipedia','now')`,
  ).run();
  db.prepare(
    `INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at,completed_at)
 VALUES ('done','researcher','artist','artist','extract-wikipedia','complete','2026-01-01','2026-01-02','2026-01-02')`,
  ).run();
  const changes = (db.prepare('SELECT total_changes() n').get() as { n: number }).n;
  const progress = researchProgress(db),
    storage = researchStorage(db);
  assert.equal(progress.lastCompletedAt, '2026-01-02');
  assert.equal(progress.lastSourceAt, null);
  assert.equal(storage.sources[0]!.textBytes, Buffer.byteLength('Musique é'));
  assert.equal(storage.sources[0]!.documents, 1);
  assert.ok(storage.databaseBytes > 0);
  assert.equal(storage.walBytes, 0);
  assert.equal((db.prepare('SELECT total_changes() n').get() as { n: number }).n, changes);
  assert.equal(
    (db.prepare('SELECT COUNT(*) n FROM sleeve_research_jobs').get() as { n: number }).n,
    1,
  );
  db.close();
});
