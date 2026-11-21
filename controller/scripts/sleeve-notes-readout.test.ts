import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import { researchStoreReadoutInDatabase } from '../src/sleeve-notes/research-repository.js';

test('the research readout exposes claims with their evidence rather than raw provider payloads', () => {
  const db = new Database(':memory:');
  migrate(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sleeve_artists (id, name, musicbrainz_id, created_at, updated_at)
    VALUES ('artist', 'Example Band', 'mb-artist', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    revision_id, content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('source', 'artist', 'artist', 'wikipedia', 'https://example.test/wiki', '1', 'hash',
      'bounded-text', 'Example Band formed in Liverpool.', 'Wikipedia contributors', ?)`).run(now);
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES ('claim', 'artist', 'artist', 'artist-stories', 'origin', 'Example Band formed in Liverpool.',
      'source', 'Example Band formed in Liverpool.', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability,
    state, priority, attempts, run_after, created_at, updated_at)
    VALUES ('job', 'wikipedia', 'artist', 'artist', 'biography', 'retry-at', 300, 2, ?, ?, ?)`)
    .run('2026-09-14T15:30:00.000Z', now, now);

  const readout = researchStoreReadoutInDatabase(db);
  assert.deepEqual(readout.artists, [{ name: 'Example Band', musicbrainzId: 'mb-artist', sources: 1, claims: 1 }]);
  assert.deepEqual(readout.claims, [{ id: 'claim', enabled: 1, operatorState: 'auto', entityType: 'artist', entityId: 'artist', recording: null, provider: 'wikipedia', shortWording: '', artist: 'Example Band', category: 'artist-stories', topic: 'origin',
    wording: 'Example Band formed in Liverpool.', evidence: 'Example Band formed in Liverpool.', sourceUrl: 'https://example.test/wiki' }]);
  assert.deepEqual(readout.jobs, [{ provider: 'wikipedia', subjectType: 'artist', capability: 'biography',
    state: 'retry-at', priority: 300, attempts: 2, runAfter: '2026-09-14T15:30:00.000Z', updatedAt: now }]);
  assert.deepEqual(readout.jobSummary, [{ provider: 'wikipedia', capability: 'biography', state: 'retry-at',
    jobs: 1, attempts: 2, nextDue: '2026-09-14T15:30:00.000Z', updatedAt: now }]);
  assert.deepEqual(readout.providerSummary, []);
  assert.deepEqual({ localAttachments: readout.localAttachments, encounters: readout.encounters,
    pendingMatches: readout.pendingMatches, retainedClaims: readout.retainedClaims, researchJobs: readout.researchJobs }, {
    localAttachments: 0, encounters: 0, pendingMatches: 0, retainedClaims: 1, researchJobs: 1,
  });
  db.close();
});
