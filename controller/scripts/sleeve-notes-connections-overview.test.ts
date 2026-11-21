import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-brain-'));
process.env.STATE_DIR = root;
const { migrate, close } = await import('../src/sleeve-notes/db.js');
const { researchConnectionsOverviewInDatabase: overview } = await import('../src/sleeve-notes/connections-overview.js');
const { cacheConnectionLibraryTracks, reconcileLibraryConnections } = await import('../src/sleeve-notes/library-connections.js');
const { researchConnectionsGraphInDatabase, resolveConnectionLocalTrackInDatabase, searchConnectionsInDatabase, researchEntityDossierInDatabase } = await import('../src/sleeve-notes/research-repository.js');
test.after(async () => { close(); await removeTempDir(root); });
const now = '2026-10-12T12:00:00.000Z';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); migrate(db);
  for (const [id, name] of [['a', 'Alpha'], ['b', 'Beta']]) {
    db.prepare('INSERT INTO sleeve_artists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
  }
  for (const [id, artist, title, providerId] of [['a1', 'a', 'First', '1'], ['a2', 'a', 'Second', '2'], ['b1', 'b', 'Original', '3']]) {
    db.prepare(`INSERT INTO sleeve_recordings (id, title, artist_id, match_state, created_at, updated_at)
      VALUES (?, ?, ?, 'matched', ?, ?)`).run(id, title, artist, now, now);
    const artistName = artist === 'a' ? 'Alpha' : 'Beta';
    db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id, recording_id, title, artist,
      match_state, first_encountered_at, last_encountered_at, updated_at)
      VALUES (?, ?, ?, ?, 'matched', ?, ?, ?)`).run(`local-${id}`, id, title, artistName, now, now, now);
    db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
      content_hash, content_kind, content, attribution, retrieved_at)
      VALUES (?, 'recording', ?, 'genius', ?, ?, 'structured-json', ?, 'Genius', ?)`).run(
      `doc-${id}`, id, `https://genius.test/${id}`, id, JSON.stringify({ identity: { providerId } }), now);
  }
  return db;
}
function claim(db: Database.Database, id: string, recording: string, category: string, evidence: unknown) {
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES (?, 'recording', ?, ?, ?, 'A supported fact', ?, ?, ?, ?)`).run(
    id, recording, category, id, `doc-${recording}`, JSON.stringify(evidence), now, now);
}
function sample(db: Database.Database, id: string, recording = 'a1', targetId = '3', targetArtist = 'Beta') {
  claim(db, id, recording, 'musical-connections', { type: 'samples',
    target: { providerId: targetId, title: 'Original', artist: targetArtist, canonicalUrl: 'https://genius.test/original' } });
}
function credit(db: Database.Database, id: string, recording: string, personId: string, role = 'Writer') {
  claim(db, id, recording, 'credits', { role, names: ['Someone'], contributors: [{ providerId: personId, name: 'Someone' }] });
}

test('artist overview aggregates track evidence, preserves direction and performs no writes', () => {
  const db = fixture(); sample(db, 'first'); sample(db, 'second', 'a2');
  db.prepare("UPDATE sleeve_source_documents SET content = 'malformed legacy content' WHERE id = 'doc-a2'").run();
  const writes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const graph = overview(db);
  assert.equal(graph.focusId, '');
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, 'artist:a'); assert.equal(graph.edges[0].target, 'artist:b');
  assert.equal(graph.edges[0].count, 2); assert.equal(graph.edges[0].sources?.length, 2);
  assert.match(graph.edges[0].sources![1].evidence, /Second by Alpha samples Original by Beta/);
  assert.equal(graph.nodes.find((node) => node.id === 'artist:a')?.trackCount, 2);
  assert.equal(graph.nodes.find((node) => node.id === 'artist:a')?.verifiedConnectionCount, 2);
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, writes);
  assert.ok(!JSON.stringify(graph).includes('examples'));
  assert.equal(overview(db, ['cover-of']).edges.length, 0);
  db.close();
});

test('only shared contributor identities become hubs; namesakes and stale names remain separate', () => {
  const db = fixture();
  credit(db, 'writer-a', 'a1', 'shared'); credit(db, 'writer-b', 'b1', 'shared');
  credit(db, 'namesake', 'a2', 'different'); credit(db, 'producer', 'a1', 'shared', 'Producer');
  claim(db, 'stale', 'b1', 'credits', { role: 'Writer', names: ['Someone'], contributors: [{ providerId: 'different', name: 'Other Person' }] });
  const graph = overview(db, ['writer']);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.filter((node) => node.kind === 'contributor').length, 1);
  assert.ok(graph.edges.every((edge) => edge.target === 'genius-contributor:shared'));
  db.prepare("UPDATE sleeve_claims SET enabled = 0 WHERE id = 'writer-b'").run();
  assert.equal(overview(db, ['writer']).edges.length, 0);
  db.close();
});

test('catalogue artists appear before encounters and verified targets join their library group', () => {
  const db = fixture(); sample(db, 'target', 'a1', 'unseen', 'New Band');
  cacheConnectionLibraryTracks(db, [{ id: 'new-local', title: 'Original', artist: 'New Band' },
    { id: 'other-local', title: 'Another Song', artist: 'Unplayed Band' }], 'scan');
  reconcileLibraryConnections(db);
  const graph = overview(db);
  const target = graph.nodes.find((node) => node.id === graph.edges[0].target)!;
  assert.equal(target.title, 'New Band'); assert.equal(target.local, true);
  assert.equal(target.entityType, 'library-artist'); assert.equal(target.expandable, false);
  assert.ok(graph.nodes.some((node) => node.title === 'Unplayed Band' && node.trackCount === 1));
  db.close();
});

test('an ambiguous target and an edited claim never inherit an obsolete library match', () => {
  const db = fixture(); sample(db, 'target');
  cacheConnectionLibraryTracks(db, [{ id: 'one', title: 'Original', artist: 'Beta' }, { id: 'two', title: 'Original', artist: 'Beta' }], 'scan');
  reconcileLibraryConnections(db);
  let graph = overview(db);
  assert.equal(graph.nodes.find((node) => node.id === graph.edges[0].target)?.local, false);
  assert.equal(graph.edges[0].target, 'external-artist:label:beta');
  db.prepare("UPDATE sleeve_claims SET evidence = ? WHERE id = 'target'").run(JSON.stringify({
    type: 'cover_of', target: { providerId: 'new-id', title: 'Other', artist: 'Beta' }}));
  graph = overview(db);
  assert.equal(graph.edges[0].target, 'external-artist:label:beta');
  assert.equal(graph.edges[0].type, 'cover-of');
  db.prepare("UPDATE sleeve_claims SET enabled = 0 WHERE id = 'target'").run();
  assert.equal(overview(db).edges.length, 0);
  db.close();
});

test('overview caps preserve connected nodes, valid endpoints and deterministic order', () => {
  const db = fixture(); sample(db, 'target', 'a1', 'external', 'External Band');
  cacheConnectionLibraryTracks(db, Array.from({ length: 6100 }, (_, i) => ({ id: `track-${i}`, title: `Track ${i}`, artist: `Unplayed ${i}` })), 'scan');
  const graph = overview(db);
  assert.equal(graph.nodes.length, 6000); assert.equal(graph.truncated, true);
  assert.ok(graph.nodes.some((node) => node.id === 'artist:a'));
  assert.ok(graph.nodes.some((node) => node.id === 'external-artist:label:external%20band'));
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
  assert.deepEqual(graph, overview(db));
  db.close();
});

test('artist drilldown defers track relationships and current targeting names its artist node', () => {
  const db = fixture(); sample(db, 'first');
  const graph = researchConnectionsGraphInDatabase(db, { entityType: 'artist', entityId: 'a', edgeTypes: ['samples'] })!;
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.focusId, 'artist:a');
  const current = resolveConnectionLocalTrackInDatabase(db, 'local-a1')!;
  assert.equal(current.nodeId, 'recording:a1'); assert.equal(current.artistNodeId, 'artist:a');
  db.prepare("UPDATE sleeve_local_attachments SET match_state = 'ambiguous' WHERE local_track_id = 'local-a1'").run();
  assert.equal(resolveConnectionLocalTrackInDatabase(db, 'local-a1'), null);
  db.close();
});

test('a completed catalogue governs local status instead of historic encounters', () => {
  const db = fixture();
  cacheConnectionLibraryTracks(db, [{ id: 'local-a1', title: 'First', artist: 'Alpha' }], 'scan');
  db.prepare(`INSERT INTO sleeve_connection_library_scan (id, generation, album_offset, completed_at)
    VALUES (1, 'scan', 0, ?)`).run(now);
  const graph = overview(db);
  assert.equal(graph.nodes.find((node) => node.id === 'artist:a')?.trackCount, 1);
  assert.equal(graph.nodes.find((node) => node.id === 'artist:b')?.local, false);
  db.close();
});


test('per-song provisional artists share the unambiguous library artist display without merging stored rows', () => {
  const db = fixture();
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('alpha-local','Alpha','alpha')`).run();
  cacheConnectionLibraryTracks(db,[{id:'local-a1',title:'First',artist:'Alpha'},{id:'local-a2',title:'Second',artist:'Alpha'}],'scan');
  db.prepare(`INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('provisional','Alpha',?,?)`).run(now,now);
  db.prepare(`UPDATE sleeve_recordings SET artist_id='provisional' WHERE id='a2'`).run();
  sample(db,'one'); sample(db,'two','a2');
  const changes=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n;
  const graph=overview(db);
  assert.equal(graph.nodes.filter(node=>node.title==='Alpha').length,1);
  assert.equal(graph.nodes.find(node=>node.title==='Alpha')?.localArtistId,'alpha-local');
  assert.equal(graph.edges.filter(edge=>edge.type==='samples').length,1);
  assert.equal(graph.edges.find(edge=>edge.type==='samples')?.count,2);
  assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sleeve_artists WHERE name='Alpha'").get() as {n:number}).n,2);
  db.close();
});

test('multiple external songs share an unverified artist label while retaining their evidence', () => {
  const db=fixture();sample(db,'external-one','a1','100','Outside Band');sample(db,'external-two','a2','101','Outside Band');
  const graph=overview(db);
  const external=graph.nodes.filter(node=>node.title==='Outside Band');
  assert.equal(external.length,1);assert.equal(external[0].local,false);assert.equal(external[0].expandable,false);
  assert.equal(graph.edges[0].count,2);assert.equal(graph.edges[0].sources?.length,2);
  assert.equal(external[0].verifiedConnectionCount??0,0);
  db.close();
});


test('distinct canonical artists with the same name remain separate from the provisional library group', () => {
  const db=fixture();
  db.prepare("UPDATE sleeve_artists SET musicbrainz_id='canonical-one' WHERE id='a'").run();
  db.prepare(`INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES ('namesake','Alpha','canonical-two',?,?)`).run(now,now);
  db.prepare(`INSERT INTO sleeve_connection_library_artists VALUES ('alpha-local','Alpha','alpha')`).run();
  cacheConnectionLibraryTracks(db,[{id:'local-a1',title:'First',artist:'Alpha'}],'scan');
  const graph=overview(db);
  assert.ok(graph.nodes.some(node=>node.id==='artist:a'));
  assert.ok(graph.nodes.some(node=>node.id==='artist:namesake'));
  assert.ok(graph.nodes.some(node=>node.id==='library-artist:alpha-local'));
  db.close();
});


test('known entities without stories have an empty dossier; missing identities remain missing',()=>{
 const db=fixture();
 try {
  const dossier=researchEntityDossierInDatabase(db,'artist','a');
  assert.equal(dossier?.title,'Alpha');
  assert.deepEqual(dossier?.claims,[]);
  assert.equal(researchEntityDossierInDatabase(db,'recording','a1')?.claimCount,0);
  assert.equal(researchEntityDossierInDatabase(db,'recording','missing'),null);
 } finally {db.close();}
});

test('search hides provisional artist duplicates before limiting and preserves distinct identified namesakes',()=>{
 const db=fixture();
 try {
  for(let i=0;i<20;i++)db.prepare('INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(`alias-${i}`,'Alpha',now,now);
  const artists=()=>searchConnectionsInDatabase(db,'Alpha',30).filter(row=>row.kind==='artist');
  assert.equal(artists().length,1);
  db.prepare("UPDATE sleeve_artists SET musicbrainz_id='confirmed-one' WHERE id='a'").run();
  assert.deepEqual(artists().map(row=>row.entityId),['a']);
  db.prepare("UPDATE sleeve_artists SET musicbrainz_id='confirmed-two' WHERE id='alias-0'").run();
  assert.equal(artists().length,2);
 } finally {db.close();}
});
