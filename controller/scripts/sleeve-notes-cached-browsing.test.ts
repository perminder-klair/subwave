import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
const root = createTempDir(join(tmpdir(), 'subwave-cached-notes-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const { researchStoreReadout, researchStoreExplore, researchEntityDossier, researchConnectionsGraph } = await import('../src/sleeve-notes/research-repository.js');
const { cachedBrainLibraryGraph } = await import('../src/sleeve-notes/brain-library.js');
const { migrate, open, close, withCachedRead } = await import('../src/sleeve-notes/db.js');
const { router } = await import('../src/routes/sleeve-notes.js');
const { stopConnectionCompute } = await import('../src/sleeve-notes/connection-compute.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing test address');
const base = `http://127.0.0.1:${address.port}`;
const path = join(root, 'sleeve-notes.db');
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (!String(input).startsWith(base)) throw new Error(`Unexpected provider access: ${String(input)}`);
  return originalFetch(input, init);
}) as typeof fetch;
const get = async (endpoint: string) => {
  const response = await fetch(`${base}/sleeve-notes/${endpoint}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as {
    enabled: boolean; active: boolean; retainedClaims: number; total: number;
    claims: Array<{ entityId: string }>;
    recentSparks: Array<{ speechSignal: unknown }>;
    entities: Array<{ title: string }>; nodes: Array<{ title: string }>;
  };
};
test('the disabled API exposes saved read-only views without creating the station cache', async () => {
  assert.equal((await get('status')).enabled, false);
  for (const endpoint of ['readout?cached=1','explore?cached=1','connections/overview?cached=1','moderation']) {
    assert.equal((await fetch(`${base}/sleeve-notes/${endpoint}`)).status,200);
  }
  assert.equal(existsSync(path), false);
});
test('cached Stories, history, Review and Brain read v42 without migration or writes', async () => {
  const db = new Database(path);
  migrate(db);
  const now = '2026-10-13T12:00:00Z';
  db.prepare(`INSERT INTO sleeve_artists (id, name, created_at, updated_at) VALUES ('a', 'Example Band', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url, content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('s', 'artist', 'a', 'wikipedia', 'https://example.test', 'hash', 'bounded-text', 'They formed in Cardiff.', 'Wikipedia', ?)`).run(now);
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording, source_document_id, evidence, created_at, updated_at)
    VALUES ('c', 'artist', 'a', 'artist-stories', 'formation', 'They formed in Cardiff.', 's', 'They formed in Cardiff.', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_claim_uses (id, claim_id, entity_type, entity_id, category, topic, supplied_at, offered_wording)
    VALUES ('u', 'c', 'artist', 'a', 'artist-stories', 'formation', ?, 'They formed in Cardiff.')`).run(now);
  for (const column of ['generated_signal', 'speech_signal', 'tts_rendered_at', 'tts_engine']) db.exec(`ALTER TABLE sleeve_claim_uses DROP COLUMN ${column}`);
  db.exec('DROP TABLE sleeve_brain_layers');
  for (const column of ['enabled', 'origin', 'removed']) db.exec(`ALTER TABLE sleeve_musicbrainz_series DROP COLUMN ${column}`);
  db.pragma('user_version = 42');
  db.close();
  const before = readFileSync(path);
  const readout = withCachedRead(() => researchStoreReadout());
  assert.equal(readout.claims[0].entityId, 'a');
  assert.equal(readout.recentSparks[0].speechSignal, null);
  assert.equal(withCachedRead(() => researchStoreExplore({})).entities[0].title, 'Example Band');
  assert.equal(withCachedRead(() => researchEntityDossier('artist','a'))!.claims.length, 1);
  assert.equal(withCachedRead(() => researchConnectionsGraph({entityType:'artist',entityId:'a'}))!.nodes[0].title, 'Example Band');
  for (const endpoint of ['connections/search?q=Example&cached=1','connections/overview?cached=1','moderation']) {
    assert.equal((await fetch(`${base}/sleeve-notes/${endpoint}`)).status,200);
  }
  assert.throws(() => withCachedRead(() => open().exec("UPDATE sleeve_artists SET name = 'Bad'")), /readonly/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(`${path}-wal`), false);
});
test('saved library snapshots remain readable over HTTP while disabled writes are refused', async () => {
  rmSync(path, {force:true});
  const db = new Database(path);
  migrate(db);
  const graph = { focusId: 'library-artist:local', nodes: [{ id: 'library-artist:local', title: 'Example Band' }], edges: [], truncated: false };
  db.prepare('INSERT INTO sleeve_brain_layers VALUES (?, ?, ?)').run('library-artist', 'local', JSON.stringify(graph));
  db.close();
  assert.equal(withCachedRead(() => cachedBrainLibraryGraph('library-artist','local'))!.nodes[0].title, 'Example Band');
  assert.equal((await fetch(`${base}/sleeve-notes/connections/graph?entityType=library-album&entityId=missing&cached=1`)).status, 404);
  for (const endpoint of ['connections/populate', 'wikipedia-refresh', 'wikipedia-prompt-preview']) {
    assert.equal((await fetch(`${base}/sleeve-notes/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  }
});
test('opening a library layer saves its display snapshot without creating research work', async () => {
  const { brainLibraryGraph, cachedBrainLibraryGraph } = await import('../src/sleeve-notes/brain-library.js');
  const db = open();
  const counts = () => ['sleeve_encounters', 'sleeve_claims', 'sleeve_research_jobs'].map((table) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  const before = counts();
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes('/rest/getArtist')) return new Response(JSON.stringify({
      'subsonic-response': { status: 'ok', artist: { id: 'local', name: 'Example Band', album: [{ id: 'album', name: 'First Album' }] } }}), { headers: { 'Content-Type': 'application/json' } });
    if (String(input).includes('/rest/getAlbum')) return new Response(JSON.stringify({
      'subsonic-response': { status: 'ok', album: { id: 'album', name: 'First Album', artistId: 'local', song: [{ id: 'song', title: 'First Song' }] } }}), { headers: { 'Content-Type': 'application/json' } });
    return guardedFetch(input, init);
  }) as typeof fetch;
  try {
    const artist = await brainLibraryGraph('library-artist', 'local', undefined, {
      id: 'artist:a', entityType: 'artist', entityId: 'a', kind: 'artist', title: 'Example Band',
      subtitle: null, local: true, expandable: true, sourceUrl: null});
    assert.equal(artist.focusId, 'artist:a');
    const saved = withCachedRead(() => cachedBrainLibraryGraph('library-artist', 'local'))!;
    assert.equal(saved.focusId, 'library-artist:local');
    assert.equal(saved.edges[0].source, saved.focusId);
    await brainLibraryGraph('library-album', 'album');
    assert.equal(withCachedRead(() => cachedBrainLibraryGraph('library-album', 'album'))?.nodes[1].title, 'First Song');
    assert.deepEqual(counts(), before);
  } finally { globalThis.fetch = guardedFetch; }
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  stopConnectionCompute();
  close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(root);
});
