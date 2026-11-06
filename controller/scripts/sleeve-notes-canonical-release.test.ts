import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import { admitLocalEncounterInDatabase, canonicalReleaseForResearchInDatabase, nextPendingResearchJobInDatabase, retainCanonicalMusicBrainzMatchInDatabase } from '../src/sleeve-notes/research-repository.js';
import { projectCanonicalRecording } from '../src/music/musicbrainz.js';

test('MusicBrainz release appearances distinguish a compilation from canonical first release', () => {
  const db = new Database(':memory:');
  migrate(db);
  admitLocalEncounterInDatabase(db, {
    localTrackId: 'local-pacific', title: 'Pacific State', artist: '808 State',
    releaseTitle: 'Compilation Here', musicbrainzRecordingId: null, source: 'played', priority: 1,
  });
  const result = projectCanonicalRecording({
    id: 'recording-pacific', title: 'Pacific State',
    'artist-credit': [{ name: '808 State', artist: { id: 'artist-808', name: '808 State' } }],
    releases: [
      { id: 'compilation', title: 'Compilation Here', date: '1988-01-01', status: 'Official',
        'release-group': { id: 'group-comp', 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
      { id: 'single', title: 'Pacific State', date: '1989-11-13', status: 'Official',
        'release-group': { id: 'group-single', 'primary-type': 'Single', 'secondary-types': [] } },
    ],
  });
  assert.ok(result);
  retainCanonicalMusicBrainzMatchInDatabase(db, 'local-pacific', result);

  assert.deepEqual(db.prepare(`SELECT r.title, rr.is_compilation AS compilation,
    rr.is_first_official_non_compilation AS firstRelease, rr.is_canonical_home AS canonicalHome,
    rr.selection_reason AS reason FROM sleeve_recording_releases rr
    JOIN sleeve_releases r ON r.id = rr.release_id ORDER BY r.title`).all(), [
    { title: 'Compilation Here', compilation: 1, firstRelease: 0, canonicalHome: 0, reason: null },
    { title: 'Pacific State', compilation: 0, firstRelease: 1, canonicalHome: 1, reason: 'earliest-official-non-compilation' },
  ]);
  assert.deepEqual(db.prepare(`SELECT artist.name, r.title, r.match_state AS matchState
    FROM sleeve_local_attachments a JOIN sleeve_recordings r ON r.id = a.recording_id
    JOIN sleeve_artists artist ON artist.id = r.artist_id`).all(), [
    { name: '808 State', title: 'Pacific State', matchState: 'matched' },
  ]);
  assert.deepEqual(db.prepare(`SELECT provider, subject_type AS subjectType,
    capability, priority FROM sleeve_research_jobs WHERE capability <> 'match'
    ORDER BY priority DESC`).all(), [
    { provider: 'wikipedia', subjectType: 'artist', capability: 'biography', priority: 300 },
    { provider: 'musicbrainz', subjectType: 'release', capability: 'release-context', priority: 200 },
    { provider: 'genius', subjectType: 'local-track', capability: 'connections', priority: 110 },
  ]);
  const releaseJob = nextPendingResearchJobInDatabase(db, 'musicbrainz', {
    subjectType: 'release', capability: 'release-context',
  });
  assert.ok(releaseJob);
  assert.equal(releaseJob.provider, 'musicbrainz');
  assert.equal(releaseJob.subjectType, 'release');
  assert.equal(releaseJob.capability, 'release-context');
  assert.equal(releaseJob.priority, 200);
  assert.deepEqual(canonicalReleaseForResearchInDatabase(db, releaseJob.subjectId), {
    id: releaseJob.subjectId, title: 'Pacific State', musicbrainzReleaseId: 'single',
    releaseGroupId: 'group-single', primaryType: 'Single', status: 'Official',
    date: '1989-11-13', country: null, selectionReason: 'earliest-official-non-compilation',
  });
  db.close();
});
