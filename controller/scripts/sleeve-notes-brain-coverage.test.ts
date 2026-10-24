import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-brain-coverage-'));
process.env.STATE_DIR = root;
process.env.ADMIN_USER = 'brain-test'; process.env.ADMIN_PASS = 'brain-password';
const { migrate, open, close, withCachedRead } = await import('../src/sleeve-notes/db.js');
const { brainCoverageInDatabase, queueBrainArtistInDatabase, queueBrainLibrarySeedInDatabase } = await import('../src/sleeve-notes/brain-coverage.js');
const settings = await import('../src/settings.js');
const { ResearchWorker, researchQueueDetails } = await import('../src/sleeve-notes/research-worker.js');
const { router } = await import('../src/routes/sleeve-notes.js');
await settings.load(); await settings.update({ djBehaviour: { extendedSleeveNotes: true } });
const now = new Date().toISOString();
function artist(db: Database.Database, id = 'artist', name = 'Band') {
  db.prepare(`INSERT INTO sleeve_artists (id,name,musicbrainz_id,created_at,updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, name, id, now, now);
}
function source(db: Database.Database, id = 'source', artistId = 'artist') {
  db.prepare(`INSERT INTO sleeve_source_documents (id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
    VALUES (?, 'artist', ?, 'wikipedia', 'https://en.wikipedia.org/wiki/Band', ?, 'bounded-text', ?, 'Wikipedia', ?)`)
    .run(id, artistId, id, '# Band\n\n' + 'Band recorded their album in a converted barn with a mobile recording studio. '.repeat(20), now);
}
function job(db: Database.Database, state: string, id = 'job', artistId = 'artist', provider = 'researcher') {
  db.prepare(`INSERT INTO sleeve_research_jobs (id,provider,subject_type,subject_id,capability,state,created_at,updated_at,completed_at)
    VALUES (?, ?, 'artist', ?, ?, ?, ?, ?, ?)`).run(id, provider, artistId, provider === 'researcher' ? 'extract-wikipedia' : 'biography', state, now, now, state === 'complete' ? now : null);
}
function story(db: Database.Database, id = 'story', enabled = 1) {
  db.prepare(`INSERT INTO sleeve_claims (id,entity_type,entity_id,category,topic,wording,evidence,source_document_id,enabled,created_at,updated_at)
    VALUES (?, 'artist', 'artist', 'artist-stories', ?, 'Band recorded in a barn.', 'Band recorded in a barn.', 'source', ?, ?, ?)`).run(id, id, enabled, now, now);
}
function fixture() { const db = new Database(':memory:'); migrate(db); artist(db); return db; }
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('identity and sources do not imply completed research; failed work is incomplete', () => {
  const db = fixture(); assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'unexplored');
  source(db); job(db, 'complete', 'lookup', 'artist', 'wikipedia');
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'unexplored');
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].hasResearchHistory, false);
  job(db, 'failed'); assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'incomplete');
  db.prepare("UPDATE sleeve_research_jobs SET state = 'complete', completed_at = ? WHERE id = 'job'").run(now);
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'empty');
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].lastResearchedAt, now); db.close();
});
test('coverage excludes disabled, held and mismatched scoped stories; active work stays visible', () => {
  const db = fixture(); source(db); story(db); story(db, 'disabled', 0); story(db, 'held', 0); story(db, 'scoped');
  db.prepare("UPDATE sleeve_claims SET feedback_hold = 1 WHERE id = 'held'").run();
  db.prepare("UPDATE sleeve_claims SET airtime_scope = 'matching-track-only', matching_track_title = 'Unknown Song' WHERE id = 'scoped'").run();
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].usableStories, 1);
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'ready'); job(db, 'queued');
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'queued');
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].canQueue, false);
  db.prepare("UPDATE sleeve_research_jobs SET state = 'running' WHERE id = 'job'").run();
  assert.equal(brainCoverageInDatabase(db)['artist:artist'].state, 'researching'); db.close();
});
test('queueing is idempotent, preserves provider retry windows, and creates no encounters', () => {
  const db = fixture(); assert.equal(queueBrainArtistInDatabase(db, 'artist').queued, true);
  assert.equal(queueBrainArtistInDatabase(db, 'artist').queued, false); assert.equal(count(db, 'sleeve_research_jobs'), 1);
  db.prepare("UPDATE sleeve_research_jobs SET state = 'retry-at', run_after = '2099-01-01'").run(); queueBrainArtistInDatabase(db, 'artist');
  assert.equal((db.prepare('SELECT run_after FROM sleeve_research_jobs').get() as { run_after: string }).run_after, '2099-01-01');
  assert.equal(count(db, 'sleeve_encounters'), 0); db.close();
});
test('repeat research reuses cached text and preserves stories and operator holds', () => {
  const db = fixture(); source(db); story(db); story(db, 'held', 0); job(db, 'complete');
  db.prepare("UPDATE sleeve_claims SET feedback_hold = 1 WHERE id = 'held'").run(); queueBrainArtistInDatabase(db, 'artist');
  assert.equal((db.prepare("SELECT operator_requested FROM sleeve_research_jobs WHERE id = 'job'").get() as { operator_requested: number }).operator_requested, 1);
  assert.equal(count(db, 'sleeve_wikipedia_rescan_requests'), 1); assert.equal(queueBrainArtistInDatabase(db, 'artist').queued, false);
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='story'").get() as { enabled: number }).enabled, 1);
  assert.equal((db.prepare("SELECT feedback_hold FROM sleeve_claims WHERE id='held'").get() as { feedback_hold: number }).feedback_hold, 1); db.close();
});
test('unknown library artists queue a match and remain unplayed; failed matches can retry', () => {
  const db = fixture(); db.prepare("INSERT INTO sleeve_connection_library_artists (local_artist_id,name,name_key) VALUES ('local','Unexplored Band','unexplored band')").run();
  const seed = { id: 'track', title: 'Song', artist: 'Unexplored Band', album: 'Album', mbid: null };
  queueBrainLibrarySeedInDatabase(db, seed); assert.equal(queueBrainLibrarySeedInDatabase(db, seed).queued, false);
  assert.equal(brainCoverageInDatabase(db)['library-artist:local'].state, 'queued'); assert.equal(count(db, 'sleeve_encounters'), 0);
  db.prepare("UPDATE sleeve_research_jobs SET state='failed'").run(); assert.equal(brainCoverageInDatabase(db)['library-artist:local'].state, 'incomplete');
  assert.equal(queueBrainLibrarySeedInDatabase(db, seed).queued, true); db.close();
});
test('ambiguous names do not inherit another artist’s story coverage', () => {
  const db = fixture(); source(db); story(db); artist(db, 'other', 'Band');
  db.prepare("INSERT INTO sleeve_connection_library_artists (local_artist_id,name,name_key) VALUES ('local','Band','band')").run();
  assert.equal(brainCoverageInDatabase(db)['library-artist:local'].usableStories, 0); db.close();
});
test('explicit cached research needs no play but still obeys broadcast priority', async () => {
  const db = open(); artist(db, 'manual', 'Manual Band'); source(db, 'manual-source', 'manual'); job(db, 'complete', 'manual-job', 'manual'); queueBrainArtistInDatabase(db, 'manual');
  assert.equal(researchQueueDetails(new Date(), false).find(row => row.id === 'manual-job')?.phase, 'ready');
  const researcher = { extract: async () => [], extractWikipediaSparks: async () => ({ claims: [], rawResponse: '' }) };
  assert.equal(await new ResearchWorker({ isQuiet: () => false }, researcher).runOnce(), false);
  assert.ok(db.prepare("SELECT 1 FROM sleeve_wikipedia_rescan_requests WHERE job_id = 'manual-job'").get());
  assert.equal(await new ResearchWorker({ isQuiet: () => true, isEmptyMaintenanceAllowed: () => false }, researcher).runOnce(), true);
  assert.equal(db.prepare("SELECT 1 FROM sleeve_wikipedia_rescan_requests WHERE job_id = 'manual-job'").get(), undefined);
  assert.equal((db.prepare("SELECT operator_requested FROM sleeve_research_jobs WHERE id='manual-job'").get() as { operator_requested: number }).operator_requested, 0);
  assert.equal(count(db, 'sleeve_encounters'), 0);
});
test('library seed lookup validates the selected identity and rejects another artist’s track', async (t) => {
  const db = open();
  db.prepare("INSERT INTO sleeve_connection_library_artists (local_artist_id,name,name_key) VALUES ('verified-library','Verified Band','verified band')").run();
  const { brainLibraryResearchSeed } = await import('../src/sleeve-notes/brain-library.js');
  let mismatched = false;
  let incorrectIdentity = false;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/getArtist')) return Response.json({ 'subsonic-response': { status: 'ok', artist: {
      id: incorrectIdentity ? 'different-library' : 'verified-library', name: 'Verified Band', album: [{ id: 'verified-album', name: 'Album' }]} } });
    if (url.pathname.endsWith('/getAlbum')) return Response.json({ 'subsonic-response': { status: 'ok', album: {
      id: 'verified-album', name: 'Album', song: [{ id: 'verified-song', title: 'Song', artist: 'Verified Band', artistId: mismatched ? 'different-artist' : 'verified-library' }]} } });
    throw new Error('Unexpected provider access');
  });
  assert.equal((await brainLibraryResearchSeed('verified-library')).id, 'verified-song');
  mismatched = true; await assert.rejects(brainLibraryResearchSeed('verified-library'), /No track with a matching artist credit/);
  incorrectIdentity = true; await assert.rejects(brainLibraryResearchSeed('verified-library'), /identity changed/);
  const abort = new AbortController(); abort.abort(new Error('test cancellation'));
  await assert.rejects(brainLibraryResearchSeed('verified-library', abort.signal));
});

test('explicit library matching hands off to artist research even when the automatic queue is full', async () => {
  await settings.update({ djBehaviour: { extendedSleeveNotes: true } });
  const db = open();
  db.prepare("UPDATE sleeve_research_jobs SET state = 'complete'").run();
  db.prepare("DELETE FROM sleeve_wikipedia_rescan_requests").run();
  db.prepare("INSERT INTO sleeve_connection_library_artists (local_artist_id,name,name_key) VALUES ('handoff','Library Alias','library alias')").run();
  queueBrainLibrarySeedInDatabase(db, { id: 'handoff-track', title: 'Song', artist: 'Library Alias', album: null, mbid: null });
  for (let i = 0; i < 12; i++) job(db, 'queued', `backlog-${i}`, `backlog-artist-${i}`, 'wikipedia');
  const { MusicBrainzMatchWorker } = await import('../src/sleeve-notes/musicbrainz-worker.js');
  const worker = new MusicBrainzMatchWorker({ isQuiet: () => true }, { lookup: async () => ({
    id: 'handoff-recording', title: 'Song', artist: { id: 'handoff-artist', name: 'Canonical Name' }, releases: []}) });
  assert.equal(await worker.runOnce(), true);
  const attachment = db.prepare(`SELECT recording.artist_id AS id FROM sleeve_local_attachments local
    JOIN sleeve_recordings recording ON recording.id = local.recording_id WHERE local.local_track_id = 'handoff-track'`).get() as { id: string };
  assert.ok(db.prepare(`SELECT 1 FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=?
    AND provider='wikipedia' AND state='queued'`).get(attachment.id));
  assert.equal(brainCoverageInDatabase(db)['library-artist:handoff'].state, 'queued');
  assert.equal(count(db, 'sleeve_encounters'), 0);
  db.prepare("UPDATE sleeve_research_jobs SET state = 'complete'").run();
});

const app = express(); app.use(express.json(), router); const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const auth = `Basic ${Buffer.from('brain-test:brain-password').toString('base64')}`;
const post = (body: unknown) => fetch(`${url}/sleeve-notes/connections/research`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('API enforces admin access, validates targets and keeps disabled reads read-only', async () => {
  assert.equal((await fetch(`${url}/sleeve-notes/connections/research`, { method: 'POST' })).status, 401);
  assert.equal((await post({ entityType: 'recording', entityId: 'manual' })).status, 400);
  assert.equal((await post({ entityType: 'artist', entityId: 'missing' })).status, 404);
  assert.equal((await post({ entityType: 'library-artist', entityId: 'missing' })).status, 404);
  assert.equal((await post({ entityType: 'artist', entityId: 'manual' })).status, 200);
  assert.equal(((await (await post({ entityType: 'artist', entityId: 'manual' })).json()) as { queued: boolean }).queued, false);
  await settings.update({ djBehaviour: { extendedSleeveNotes: false } }); assert.equal((await post({ entityType: 'artist', entityId: 'manual' })).status, 409);
  const read = await fetch(`${url}/sleeve-notes/connections/coverage?cached=1`, { headers: { Authorization: auth } }); assert.equal(read.status, 200);
  assert.doesNotThrow(() => withCachedRead(() => brainCoverageInDatabase(open())));
});
test.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); close(); await removeTempDir(root); });
