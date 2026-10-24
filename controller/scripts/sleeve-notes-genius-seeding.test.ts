import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-genius-seeding-'));
process.env.STATE_DIR = root;
globalThis.fetch = async () => { throw new Error('Network forbidden during seeding checks'); };
const { open, close } = await import('../src/sleeve-notes/db.js');
const { cacheConnectionLibraryTracks, reconcileLibraryConnections } = await import('../src/sleeve-notes/library-connections.js');
const { enqueueNextGeniusLibrarySeed, librarySeedRecording } = await import('../src/sleeve-notes/genius-seeding.js');
const { retainGeniusResult } = await import('../src/sleeve-notes/research-repository.js');
const { loadExtendedSleeveNoteCandidatesInDatabase } = await import('../src/sleeve-notes/link-selection.js');
after(async () => { close(); await removeTempDir(root); });
const now = new Date().toISOString();
function completeSeed() { open().prepare(`UPDATE sleeve_research_jobs SET state='complete' WHERE capability='library-seed'`).run(); }
function latestSeed() { return open().prepare(`SELECT seed.local_track_id AS trackId,seed.recording_id AS recordingId
  FROM sleeve_genius_library_seeds seed ORDER BY rowid DESC LIMIT 1`).get() as { trackId: string; recordingId: string }; }

test('seeding waits for catalogue population, rotates artists, queues only one seed, and makes no encounters or MusicBrainz jobs', () => {
  const db = open();
  assert.equal(enqueueNextGeniusLibrarySeed(), false);
  db.prepare('INSERT INTO sleeve_connection_artist_population VALUES (1,?)').run(now);
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('a','Alpha','alpha'),('b','Beta','beta')`).run();
  cacheConnectionLibraryTracks(db, [
    { id: 'a-one', title: 'One', artist: 'Alpha' }, { id: 'a-copy', title: 'One', artist: 'Alpha' },
    { id: 'a-two', title: 'Two', artist: 'Alpha' }, { id: 'b-one', title: 'One', artist: 'Beta' },
    { id: 'b-two', title: 'Two', artist: 'Beta' },
  ], 'scan');
  assert.equal(enqueueNextGeniusLibrarySeed(), false);
  db.prepare(`INSERT INTO sleeve_connection_library_scan(id,generation,album_offset,completed_at) VALUES (1,'scan',0,?)`).run(now);
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  assert.match(latestSeed().trackId, /^a-/);
  assert.equal(enqueueNextGeniusLibrarySeed(), false);
  completeSeed();
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  assert.equal(latestSeed().trackId, 'b-one');
  completeSeed();
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  assert.equal(latestSeed().trackId, 'a-two', 'duplicate album copies are not reseeded');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleeve_local_attachments').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleeve_encounters').get()!.n, 0);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sleeve_research_jobs WHERE provider='musicbrainz'`).get()!.n, 0);
});

test('seed evidence is usable for its local track and catalogue removal invalidates the job identity', () => {
  const { recordingId, trackId } = latestSeed();
  const recording = librarySeedRecording(recordingId);
  assert.ok(recording);
  retainGeniusResult(recording, { identity: { providerId: '7000', title: recording.title, artist: recording.artist!,
    canonicalUrl: 'https://genius.com/seed' }, credits: [], relationships: [{ type: 'samples', target: {
      providerId: '7001', title: 'One', artist: 'Beta', canonicalUrl: 'https://genius.com/original' } }],
    attribution: 'Genius', retrievedAt: now });
  reconcileLibraryConnections(open());
  assert.ok(loadExtendedSleeveNoteCandidatesInDatabase(open(), trackId, recording.artist).length);
  open().prepare('DELETE FROM sleeve_connection_library_tracks WHERE local_track_id=?').run(trackId);
  assert.equal(librarySeedRecording(recordingId), null);
});

test('the saved artist cursor survives reopen and exhausted catalogues do not flood the job queue', () => {
  completeSeed(); close();
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  assert.equal(latestSeed().trackId, 'b-two');
  completeSeed();
  const count = open().prepare('SELECT count(*) AS n FROM sleeve_research_jobs').get();
  assert.equal(enqueueNextGeniusLibrarySeed(), false);
  assert.equal(enqueueNextGeniusLibrarySeed(), false);
  assert.deepEqual(open().prepare('SELECT count(*) AS n FROM sleeve_research_jobs').get(), count);
});

test('the worker yields and finishes cached expansion before a library seed, then uses only the shared Genius fetch path', async t => {
  const db = open();
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('g','Gamma','gamma')`).run();
  cacheConnectionLibraryTracks(db, [{ id: 'g-one', title: 'New Song', artist: 'Gamma' }], 'scan');
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  const { registerGeniusTraversal } = await import('../src/sleeve-notes/genius-traversal.js');
  const source = db.prepare(`SELECT entity_id AS id,content FROM sleeve_source_documents WHERE provider='genius' LIMIT 1`)
    .get() as { id: string; content: string };
  const result = JSON.parse(source.content);
  result.relationships = [];
  result.retrievedAt = new Date().toISOString();
  retainGeniusResult({ id: source.id, title: result.identity.title, artist: result.identity.artist }, result);
  registerGeniusTraversal({ id: source.id, title: result.identity.title, artist: result.identity.artist }, result);
  const settings = await import('../src/settings.js');
  settings.get().djBehaviour.extendedSleeveNotes = true;
  settings.get().djBehaviour.sleeveNotesCollectionPaused = false;
  settings.get().sleeveNotes.providers.genius.enabled = true;
  settings.get().sleeveNotes.providers.genius.accessToken = 'test-only';
  const { GeniusResearchWorker } = await import('../src/sleeve-notes/genius-worker.js');
  let quiet = false;
  const worker = new GeniusResearchWorker({ isQuiet: () => quiet });
  const calls: string[] = [];
  const song = { id: 8000, title: 'New Song', primary_artist: { name: 'Gamma' }, url: 'https://genius.com/new-song' };
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input); assert.equal(url.hostname, 'api.genius.com'); calls.push(url.pathname);
    return Response.json(url.pathname === '/search' ? { response: { hits: [{ result: song }] } } : { response: { song } });
  });
  assert.equal(await worker.runOnce(), false);
  quiet = true;
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls, [], 'cached expansion takes priority and spends no requests');
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls, ['/search', '/songs/8000']);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM sleeve_provider_requests WHERE provider='genius'`).get()!.n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sleeve_encounters').get()!.n, 0);
});

test('historical encountered tracks and their album copies are excluded rather than backfilled by seeding', () => {
  const db = open();
  completeSeed();
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('d','Delta','delta')`).run();
  cacheConnectionLibraryTracks(db, [
    { id: 'd-old', title: 'A Previously Encountered Song', artist: 'Delta' },
    { id: 'd-copy', title: 'A Previously Encountered Song', artist: 'Delta' },
    { id: 'd-new', title: 'Z Unexamined Song', artist: 'Delta' },
  ], 'scan');
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES ('d-old','A Previously Encountered Song','Delta','unmatched',?,?,?)`).run(now, now, now);
  assert.equal(enqueueNextGeniusLibrarySeed(), true);
  assert.equal(latestSeed().trackId, 'd-new');
});
