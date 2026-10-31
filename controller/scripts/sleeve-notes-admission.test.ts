import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import { admitLocalEncounterInDatabase, deferMusicBrainzMatchesInDatabase, musicBrainzOutageDelay, musicBrainzRetryDelay, retryResearchJobInDatabase } from '../src/sleeve-notes/research-repository.js';

test('an encounter creates one local attachment and one durable MusicBrainz match task', () => {
  const db = new Database(':memory:');
  migrate(db);

  admitLocalEncounterInDatabase(db, {
    localTrackId: 'navidrome-1', title: 'Pacific State', artist: '808 State',
    releaseTitle: 'The Best of... 808 State', musicbrainzRecordingId: null,
    source: 'queue', priority: 1,
  });
  admitLocalEncounterInDatabase(db, {
    localTrackId: 'navidrome-1', title: 'Pacific State', artist: '808 State',
    releaseTitle: 'The Best of... 808 State', musicbrainzRecordingId: 'recording-id',
    source: 'played', priority: 4,
  });

  assert.deepEqual(db.prepare(`SELECT recording_id AS recordingId, release_title AS releaseTitle,
    musicbrainz_recording_id AS musicbrainzRecordingId, match_state AS matchState
    FROM sleeve_local_attachments`).all(), [{
    recordingId: null, releaseTitle: 'The Best of... 808 State',
    musicbrainzRecordingId: 'recording-id', matchState: 'unmatched',
  }]);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM sleeve_encounters').get() as { count: number }).count, 2);
  assert.deepEqual(db.prepare(`SELECT provider, subject_type AS subjectType, subject_id AS subjectId,
    capability, state, priority FROM sleeve_research_jobs WHERE provider='musicbrainz'`).all(), [{
    provider: 'musicbrainz', subjectType: 'local-track', subjectId: 'navidrome-1',
    capability: 'match', state: 'queued', priority: 4,
  }]);
  assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND capability='connections' AND state='queued'").get());
  db.close();
});

test('a transient provider failure remains a timed retry rather than a no-match', () => {
  const db = new Database(':memory:');
  migrate(db);
  admitLocalEncounterInDatabase(db, {
    localTrackId: 'navidrome-retry', title: 'Communication Breakdown', artist: 'Led Zeppelin',
    releaseTitle: 'Remasters', musicbrainzRecordingId: null, source: 'queue', priority: 0,
  });
  const id = (db.prepare("SELECT id FROM sleeve_research_jobs WHERE provider='musicbrainz' AND capability='match'").get() as { id: string }).id;
  retryResearchJobInDatabase(db, id, 300_000, new Date('2026-09-14T12:00:00.000Z'));
  assert.deepEqual(db.prepare("SELECT state, run_after AS runAfter FROM sleeve_research_jobs WHERE provider='musicbrainz'").all(), [{
    state: 'retry-at', runAfter: '2026-09-14T12:05:00.000Z',
  }]);
  assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND capability='connections' AND state='queued'").get());
  db.close();
});

test('MusicBrainz retries recover quickly from one blip but back off boundedly during an outage', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => musicBrainzRetryDelay(attempt) / 60_000), [1, 5, 15, 30, 60, 60]);
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => musicBrainzOutageDelay(attempt) / 60_000), [5, 15, 30, 60, 60]);
});

test('a MusicBrainz outage defers every pending external match together', () => {
  const db = new Database(':memory:');
  migrate(db);
  for (const id of ['one', 'two']) {
    admitLocalEncounterInDatabase(db, {
      localTrackId: id, title: `Track ${id}`, artist: 'Example Band', releaseTitle: null,
      musicbrainzRecordingId: null, source: 'queue', priority: 0,
    });
  }
  db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability,
    state, priority, attempts, run_after, created_at, updated_at)
    VALUES ('release', 'musicbrainz', 'release', 'release-id', 'release-context', 'queued', 200, 0, NULL, 'old', 'old')`).run();
  assert.equal(deferMusicBrainzMatchesInDatabase(db, 300_000, new Date('2026-09-16T12:00:00.000Z')), 2);
  assert.deepEqual(db.prepare(`SELECT subject_type AS subjectType, capability, state, run_after AS runAfter
    FROM sleeve_research_jobs WHERE provider='musicbrainz' ORDER BY subject_type, capability`).all(), [
    { subjectType: 'local-track', capability: 'match', state: 'retry-at', runAfter: '2026-09-16T12:05:00.000Z' },
    { subjectType: 'local-track', capability: 'match', state: 'retry-at', runAfter: '2026-09-16T12:05:00.000Z' },
    { subjectType: 'release', capability: 'release-context', state: 'queued', runAfter: null },
  ]);
  assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND capability='connections' AND state='queued'").get());
  db.close();
});
