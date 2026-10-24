import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-genius-identity-'));
process.env.STATE_DIR = root;
const { open, close } = await import('../src/sleeve-notes/db.js');
const { recordingForGenius, retainSourceDocument } = await import('../src/sleeve-notes/research-repository.js');
after(async () => { close(); await removeTempDir(root); });

test('Genius lookup reuses the latest retained song ID and tolerates malformed cache identities', () => {
  const db = open();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('artist','The Band',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at)
    VALUES ('recording','The Song','artist','matched',?,?)`).run(now, now);
  assert.equal(recordingForGenius('recording')?.geniusSongId, null);
  const save = (content: string) => {
    const id = retainSourceDocument({ entityType: 'recording', entityId: 'recording', provider: 'genius',
      sourceUrl: 'https://genius.com/test', revisionId: null, contentKind: 'structured-json',
      content, attribution: 'Genius' });
    return id;
  };
  const first = save(JSON.stringify({ identity: { providerId: '10' } }));
  assert.equal(recordingForGenius('recording')?.geniusSongId, '10');
  db.prepare('UPDATE sleeve_source_documents SET retrieved_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', first);
  const second = save(JSON.stringify({ identity: { providerId: 11 } }));
  assert.equal(recordingForGenius('recording')?.geniusSongId, '11');
  db.prepare('UPDATE sleeve_source_documents SET content = ? WHERE id = ?').run('not JSON', second);
  assert.equal(recordingForGenius('recording')?.geniusSongId, null);
  db.prepare('UPDATE sleeve_source_documents SET content = ? WHERE id = ?')
    .run(JSON.stringify({ identity: { providerId: '../search' } }), second);
  assert.equal(recordingForGenius('recording')?.geniusSongId, null);
  assert.equal(recordingForGenius('missing'), null);
});

test('an encountered track starts Genius independently and canonical enrichment preserves its evidence', async () => {
  const { admitLocalEncounter, localRecordingForGenius, retainGeniusResult, retainCanonicalMusicBrainzMatch } =
    await import('../src/sleeve-notes/research-repository.js');
  const db = open();
  admitLocalEncounter({ localTrackId: 'independent', title: 'Independent Song', artist: 'New Band',
    releaseTitle: null, musicbrainzRecordingId: null, source: 'played', priority: 1 });
  assert.ok(db.prepare(`SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND subject_type='local-track'
    AND subject_id='independent' AND state='queued'`).get());
  const recording = localRecordingForGenius('independent');
  assert.ok(recording);
  assert.equal(localRecordingForGenius('independent')?.id, recording.id);
  assert.deepEqual(db.prepare(`SELECT musicbrainz_id AS mbid,match_state AS state FROM sleeve_recordings WHERE id=?`)
    .get(recording.id), { mbid: null, state: 'unmatched' });
  retainGeniusResult(recording, { identity: { providerId: '99', title: recording.title, artist: recording.artist!,
    canonicalUrl: 'https://genius.com/independent' }, credits: [], relationships: [{ type: 'samples', target: {
      providerId: '100', title: 'Original', artist: 'Other Band', canonicalUrl: 'https://genius.com/original' } }],
    attribution: 'Genius', retrievedAt: new Date().toISOString() });
  const claim = db.prepare('SELECT id,wording FROM sleeve_claims WHERE entity_id=?').get(recording.id) as { id: string; wording: string };
  assert.ok(claim);
  const { cacheConnectionLibraryTracks, reconcileLibraryConnections } = await import('../src/sleeve-notes/library-connections.js');
  const { loadExtendedSleeveNoteCandidatesInDatabase } = await import('../src/sleeve-notes/link-selection.js');
  cacheConnectionLibraryTracks(db, [
    { id: 'independent', title: 'Independent Song', artist: 'New Band' },
    { id: 'original', title: 'Original', artist: 'Other Band' },
  ], 'test-scan');
  reconcileLibraryConnections(db);
  assert.ok(loadExtendedSleeveNoteCandidatesInDatabase(db, 'independent', 'New Band')
    .some(candidate => candidate.claimId === claim.id));
  db.prepare(`UPDATE sleeve_claims SET operator_state='approved',enabled=0 WHERE id=?`).run(claim.id);
  retainCanonicalMusicBrainzMatch('independent', { id: 'mb-recording', title: 'Independent Song',
    artist: { id: 'mb-artist', name: 'New Band' }, releases: [] });
  assert.deepEqual(db.prepare('SELECT wording,enabled FROM sleeve_claims WHERE id=?').get(claim.id),
    { wording: claim.wording, enabled: 0 });
  assert.ok(db.prepare('SELECT 1 FROM sleeve_genius_local_tracks WHERE local_track_id=? AND recording_id=?')
    .get('independent', recording.id));
  assert.ok(db.prepare(`SELECT 1 FROM sleeve_local_attachments WHERE local_track_id='independent' AND match_state='matched'`).get());
  assert.equal(db.prepare(`SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND subject_type='recording'
    AND subject_id=(SELECT recording_id FROM sleeve_local_attachments WHERE local_track_id='independent')`).get(), undefined);
});
