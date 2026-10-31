import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import {
  rebuildWikipediaClaimsInDatabase,
  rebuildWikipediaClaimsForArtistInDatabase,
  recoverInterruptedResearchJobsInDatabase,
} from '../src/sleeve-notes/research-repository.js';

function seededDatabase(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  const now = '2026-09-16T10:00:00.000Z';
  db.prepare(`INSERT INTO sleeve_artists (id, name, musicbrainz_id, created_at, updated_at)
    VALUES ('artist', 'Example Band', 'mb-artist', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    revision_id, content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('wiki-source', 'artist', 'artist', 'wikipedia', 'https://example.test/wiki', '1', 'wiki-hash',
      'bounded-text', 'Example Band formed in Liverpool.', 'Wikipedia contributors', ?),
      ('other-source', 'artist', 'artist', 'other', 'https://example.test/other', '1', 'other-hash',
      'bounded-text', 'Example Band formed in Liverpool.', 'Another source', ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES ('wiki-claim', 'artist', 'artist', 'artist-stories', 'origin', 'Example Band formed in Liverpool.',
      'wiki-source', 'Example Band formed in Liverpool.', ?, ?),
      ('other-claim', 'artist', 'artist', 'artist-stories', 'other-origin', 'Example Band formed in Liverpool.',
      'other-source', 'Example Band formed in Liverpool.', ?, ?)`)
    .run(now, now, now, now);
  return db;
}

test('interrupted Sleeve Notes jobs become eligible again on boot', () => {
  const db = seededDatabase();
  db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability,
    state, priority, attempts, run_after, created_at, updated_at)
    VALUES ('stuck', 'researcher', 'artist', 'artist', 'extract-wikipedia', 'running', 300, 1, NULL, ?, ?),
      ('queued', 'wikipedia', 'artist', 'artist', 'biography', 'queued', 300, 0, NULL, ?, ?)`)
    .run('2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z');

  assert.equal(recoverInterruptedResearchJobsInDatabase(db, new Date('2026-09-16T10:00:00.000Z')), 1);
  assert.deepEqual(db.prepare(`SELECT id, state, run_after AS runAfter FROM sleeve_research_jobs ORDER BY id`).all(), [
    { id: 'queued', state: 'queued', runAfter: null },
    { id: 'stuck', state: 'queued', runAfter: null },
  ]);
  db.close();
});

test('Wikipedia claim rebuild retains cached sources and non-Wikipedia claims', () => {
  const db = seededDatabase();
  db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability,
    state, priority, attempts, run_after, created_at, updated_at)
    VALUES ('wiki-job', 'researcher', 'artist', 'artist', 'extract-wikipedia', 'complete', 300, 2, NULL, ?, ?)`)
    .run('2026-09-16T09:00:00.000Z', '2026-09-16T09:00:00.000Z');

  assert.deepEqual(rebuildWikipediaClaimsInDatabase(db, new Date('2026-09-16T10:00:00.000Z')), {
    claimsRemoved: 1, jobsQueued: 1,
  });
  assert.deepEqual(db.prepare(`SELECT id FROM sleeve_claims WHERE enabled=1 ORDER BY id`).all(), [{ id: 'other-claim' }]);
  assert.deepEqual(db.prepare(`SELECT state, attempts, run_after AS runAfter FROM sleeve_research_jobs WHERE id='wiki-job'`).all(), [
    { state: 'queued', attempts: 0, runAfter: null },
  ]);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM sleeve_source_documents WHERE provider='wikipedia'`).get() as { count: number }).count, 1);
  db.close();
});

test('artist-scoped Wikipedia claim rebuild leaves other artists untouched', () => {
  const db = seededDatabase();
  db.prepare(`INSERT INTO sleeve_artists (id, name, musicbrainz_id, created_at, updated_at)
    VALUES ('other-artist', 'Other Band', 'mb-other', 'old', 'old')`).run();
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    revision_id, content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('other-wiki-source', 'artist', 'other-artist', 'wikipedia', 'https://example.test/other-wiki', '1', 'other-wiki-hash',
      'bounded-text', 'Other Band story.', 'Wikipedia contributors', 'old')`).run();
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES ('other-wiki-claim', 'artist', 'other-artist', 'artist-stories', 'story', 'Other Band story.',
      'other-wiki-source', 'Other Band story.', 'old', 'old')`).run();

  assert.deepEqual(rebuildWikipediaClaimsForArtistInDatabase(db, 'artist', new Date('2026-09-17T16:30:00.000Z')), {
    claimsRemoved: 1, jobsQueued: 1,
  });
  assert.deepEqual(db.prepare(`SELECT id FROM sleeve_claims WHERE enabled=1 ORDER BY id`).all(), [
    { id: 'other-claim' }, { id: 'other-wiki-claim' },
  ]);
  assert.deepEqual(rebuildWikipediaClaimsForArtistInDatabase(db, 'missing'),
    { claimsRemoved: 0, jobsQueued: 0 });
  db.close();
});

for (const rebuild of [rebuildWikipediaClaimsInDatabase, (db:Database.Database)=>rebuildWikipediaClaimsForArtistInDatabase(db,'artist')]) {
 test('Wikipedia rebuild retains referenced claims, feedback and operator corrections',()=>{
  const db=seededDatabase();const at='2026-10-16T10:00:00Z';
  db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,supplied_at,aired_at,offered_wording,claim_wording_at_offer)
   VALUES ('aired','wiki-claim','artist','artist','artist-stories','origin',?,?,'Original story','Original story')`).run(at,at);
  db.prepare(`INSERT INTO sleeve_spark_feedback(use_id,story,delivery,note,actor,created_at,updated_at) VALUES ('aired','good','worked','Keep it','operator',?,?)`).run(at,at);
  db.prepare(`UPDATE sleeve_claims SET operator_state='approved',wording='Operator wording' WHERE id='other-claim'`).run();
  assert.doesNotThrow(()=>rebuild(db));
  assert.deepEqual(db.prepare("SELECT id,enabled FROM sleeve_claims WHERE id='wiki-claim'").get(),{id:'wiki-claim',enabled:0});
  assert.equal((db.prepare("SELECT offered_wording FROM sleeve_claim_uses WHERE id='aired'").get() as {offered_wording:string}).offered_wording,'Original story');
  assert.equal((db.prepare("SELECT note FROM sleeve_spark_feedback WHERE use_id='aired'").get() as {note:string}).note,'Keep it');
  assert.equal((db.prepare("SELECT wording FROM sleeve_claims WHERE id='other-claim'").get() as {wording:string}).wording,'Operator wording');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
 });
}
