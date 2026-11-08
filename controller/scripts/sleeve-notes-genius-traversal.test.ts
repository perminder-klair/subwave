import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SleeveProviderResult, ProviderRelationship } from '../src/sleeve-notes/provider.js';
const root = createTempDir(join(tmpdir(), 'subwave-genius-traversal-'));
process.env.STATE_DIR = root;
globalThis.fetch = async () => { throw new Error('Network forbidden in traversal checks'); };
const { open, close } = await import('../src/sleeve-notes/db.js');
const { retainGeniusResult, admitLocalEncounter } = await import('../src/sleeve-notes/research-repository.js');
const { cachedGeniusSong, knownGeniusSongId, associateCachedGeniusSong, registerGeniusTraversal,
  expandGeniusSamples, traversalRecording, traversalHasSource } = await import('../src/sleeve-notes/genius-traversal.js');
const db = open();
after(async () => { close(); await removeTempDir(root); });
const now = new Date().toISOString();
db.prepare('INSERT INTO sleeve_connection_artist_population VALUES (1,?)').run(now);
db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('known','Known Band','known band')`).run();
function relationship(id: string, artist = 'Known Band', type: ProviderRelationship['type'] = 'samples'): ProviderRelationship {
  return { type, target: { providerId: id, title: `Song ${id}`, artist, canonicalUrl: `https://genius.com/${id}` } };
}
function result(id: string, relationships: ProviderRelationship[]): SleeveProviderResult {
  return { identity: { providerId: id, title: `Song ${id}`, artist: 'Known Band', canonicalUrl: `https://genius.com/${id}` },
    relationships, credits: [], attribution: 'Genius', retrievedAt: now };
}
function save(id: string, relationships: ProviderRelationship[]) {
  let row = db.prepare('SELECT recording_id AS id FROM sleeve_genius_traversal WHERE song_id=?').get(id) as { id: string } | undefined;
  if (!row) {
    db.prepare('INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(`artist-${id}`, 'Known Band', now, now);
    db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at)
      VALUES (?,?,?,'unmatched',?,?)`).run(`recording-${id}`, `Song ${id}`, `artist-${id}`, now, now);
    row = { id: `recording-${id}` };
  }
  const recording = { id: row.id, title: `Song ${id}`, artist: 'Known Band' };
  const data = result(id, relationships);
  retainGeniusResult(recording, data); registerGeniusTraversal(recording, data);
  return recording;
}

test('sample traversal crosses missing songs of library artists, stops at outside artists, and terminates cycles', () => {
  const a = save('1000', [relationship('1001'), relationship('1002', 'Outside Band'), relationship('1003', 'Known Band', 'cover_of')]);
  assert.equal(expandGeniusSamples(a.id), true);
  const target = db.prepare('SELECT recording_id AS id FROM sleeve_genius_traversal WHERE song_id=?').get('1001') as { id: string };
  assert.ok(target);
  assert.equal(traversalRecording(target.id)?.geniusSongId, '1001');
  assert.equal(traversalHasSource(target.id), false);
  assert.equal(knownGeniusSongId({ id: 'other', title: 'Song 1001', artist: 'Known Band' }), '1001');
  assert.equal(db.prepare('SELECT 1 FROM sleeve_genius_traversal WHERE song_id IN (?,?)').get('1002', '1003'), undefined);
  assert.ok(db.prepare(`SELECT 1 FROM sleeve_claims WHERE entity_id=? AND wording LIKE '%Outside Band%'`).get(a.id));
  const b = save('1001', [relationship('1000', 'Known Band', 'sampled_in')]);
  assert.equal(expandGeniusSamples(b.id), true);
  assert.equal(expandGeniusSamples(a.id), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleeve_genius_traversal').get()!.n, 2);
  assert.equal(traversalHasSource(target.id), true);
  assert.equal(cachedGeniusSong({ id: 'another-copy', title: 'Song 1001', artist: 'Known Band' })?.identity.providerId, '1001');
});

test('a durable cursor bounds expansion and repeated targets create one job', () => {
  const relations = Array.from({ length: 45 }, (_, i) => relationship(String(2001 + i)));
  relations.push(relationship('2001'));
  const root = save('2000', relations);
  assert.equal(expandGeniusSamples(root.id), false);
  assert.equal(db.prepare('SELECT next_relationship AS n FROM sleeve_genius_traversal WHERE song_id=?').get('2000')!.n, 20);
  assert.equal(expandGeniusSamples(root.id), false);
  assert.equal(expandGeniusSamples(root.id), true);
  const target = db.prepare('SELECT recording_id AS id FROM sleeve_genius_traversal WHERE song_id=?').get('2001') as { id: string };
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sleeve_research_jobs WHERE subject_id=? AND capability='sample-traversal'`).get(target.id)!.n, 1);
});

test('ambiguous library artists stop traversal and cached associations reuse evidence without changing canonical attachments', () => {
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('ambiguous-a','Ambiguous','ambiguous'),('ambiguous-b','Ambiguous','ambiguous')`).run();
  const root = save('3000', [relationship('3001', 'Ambiguous')]);
  expandGeniusSamples(root.id);
  assert.equal(db.prepare('SELECT 1 FROM sleeve_genius_traversal WHERE song_id=?').get('3001'), undefined);
  admitLocalEncounter({ localTrackId: 'copy', title: 'Song 1001', artist: 'Known Band', releaseTitle: null,
    musicbrainzRecordingId: null, source: 'played', priority: 1 });
  assert.equal(associateCachedGeniusSong('copy', '1001'), true);
  assert.equal(db.prepare('SELECT recording_id AS id FROM sleeve_local_attachments WHERE local_track_id=?').get('copy')!.id, null);
  assert.equal(associateCachedGeniusSong('copy', '999999'), false);
});

test('the real worker yields before expansion and expands without any provider request when quiet', async () => {
  db.prepare(`UPDATE sleeve_research_jobs SET state='complete' WHERE provider='genius'`).run();
  const recording = save('4000', [relationship('4001')]);
  const settings = await import('../src/settings.js');
  settings.get().djBehaviour.extendedSleeveNotes = true;
  settings.get().djBehaviour.sleeveNotesCollectionPaused = false;
  settings.get().sleeveNotes.providers.genius.enabled = true;
  settings.get().sleeveNotes.providers.genius.accessToken = 'test-only';
  const { GeniusResearchWorker } = await import('../src/sleeve-notes/genius-worker.js');
  let quiet = false;
  const worker = new GeniusResearchWorker({ isQuiet: () => quiet });
  assert.equal(await worker.runOnce(), false);
  assert.equal(db.prepare('SELECT 1 FROM sleeve_genius_traversal WHERE song_id=?').get('4001'), undefined);
  quiet = true;
  assert.equal(await worker.runOnce(), true);
  assert.ok(db.prepare('SELECT 1 FROM sleeve_genius_traversal WHERE song_id=?').get('4001'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleeve_provider_requests').get()!.n, 0);
  assert.equal(db.prepare(`SELECT state FROM sleeve_research_jobs WHERE subject_id=? AND capability='expand-samples'`).get(recording.id)!.state, 'complete');
});

test('MB-free traversal uses the library artist name and reuses provider spelling variants',()=>{
 db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('run','Run‐D.M.C.','run‐d.m.c.')").run();
 const parent=save('99001',[relationship('99002','Run-DMC')]);
 assert.equal(expandGeniusSamples(parent.id),true);
 const row=db.prepare("SELECT recording_id AS id FROM sleeve_genius_traversal WHERE song_id='99002'").get() as {id:string};
 assert.equal(traversalRecording(row.id)?.artist,'Run‐D.M.C.');
 assert.equal(knownGeniusSongId({id:'different',title:'Song 99002',artist:'Run-DMC'}),'99002');
 db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('run-other','Run.DMC','run.dmc')").run();
 assert.equal(knownGeniusSongId({id:'different',title:'Song 99002',artist:'Run.DMC'}),null);
});

test('repeated long sample branches reuse one artist rather than one artist per song',()=>{
 db.prepare("DELETE FROM sleeve_connection_library_artists WHERE local_artist_id<>'known'").run();
 const root=save('88000',Array.from({length:45},(_,i)=>relationship(String(88001+i))));
 while(!expandGeniusSamples(root.id)) { /* bounded turns exercise the durable cursor */ }
 const artists=db.prepare(`SELECT COUNT(DISTINCT r.artist_id) n FROM sleeve_genius_traversal t
  JOIN sleeve_recordings r ON r.id=t.recording_id WHERE CAST(t.song_id AS INTEGER) BETWEEN 88000 AND 88045`).get() as {n:number};
 assert.equal(artists.n,1);
});

test('expansion resumes from the durable cursor after database reopen', () => {
  const recording = save('5000', Array.from({ length: 25 }, (_, i) => relationship(String(5001 + i))));
  assert.equal(expandGeniusSamples(recording.id), false);
  close();
  assert.equal(expandGeniusSamples(recording.id), true);
  assert.equal(open().prepare('SELECT next_relationship AS n FROM sleeve_genius_traversal WHERE song_id=?').get('5000')!.n, 25);
});
