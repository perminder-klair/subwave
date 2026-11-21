import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SleeveRelationshipType } from '../src/sleeve-notes/provider.js';

const root = createTempDir(join(tmpdir(), 'subwave-library-connections-'));
process.env.STATE_DIR = root;
const { migrate, close } = await import('../src/sleeve-notes/db.js');
const { cacheConnectionLibraryTracks, reconcileLibraryConnections, libraryConnectionsInDatabase, connectionRevision } = await import('../src/sleeve-notes/library-connections.js');
const { ConnectionLibraryWorker } = await import('../src/sleeve-notes/connection-library-worker.js');
const { loadExtendedSleeveNoteCandidatesInDatabase, selectMostSpecificEligibleClaim } = await import('../src/sleeve-notes/link-selection.js');
const { researchConnectionsGraphInDatabase, replaceAutomaticWikipediaClaimsInDatabase } = await import('../src/sleeve-notes/research-repository.js');
test.after(async () => { close(); await removeTempDir(root); });

const now = '2026-10-12T10:00:00.000Z';
function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare(`INSERT INTO sleeve_artists (id, name, musicbrainz_id, created_at, updated_at)
    VALUES ('artist', 'Band', 'artist', ?, ?)`).run(now, now);
  recording(db, 'source', 'Source', '1');
  db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id, recording_id, title, artist,
    match_state, first_encountered_at, last_encountered_at, updated_at)
    VALUES ('local-source', 'source', 'Source', 'Band', 'matched', ?, ?, ?)`).run(now, now, now);
  return db;
}
function recording(db: Database.Database, id: string, title: string, geniusId: string) {
  db.prepare(`INSERT INTO sleeve_recordings (id, title, artist_id, match_state, created_at, updated_at)
    VALUES (?, ?, 'artist', 'matched', ?, ?)`).run(id, title, now, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    content_hash, content_kind, content, attribution, retrieved_at)
    VALUES (?, 'recording', ?, 'genius', 'https://genius.test/song', ?, 'structured-json', ?, 'Genius', ?)`)
    .run(`doc-${id}`, id, id, JSON.stringify({ identity: { providerId: geniusId, title, artist: 'Band' } }), now);
}
function claim(db: Database.Database, id: string, recordingId: string, category: string, evidence: unknown) {
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES (?, 'recording', ?, ?, ?, 'A supported provider claim.', ?, ?, ?, ?)`)
    .run(id, recordingId, category, id, `doc-${recordingId}`, JSON.stringify(evidence), now, now);
}
function relation(db: Database.Database, id: string, type: SleeveRelationshipType, title = 'Target', artist = 'Target Band') {
  claim(db, id, 'source', 'musical-connections', {
    type, target: { providerId: '2', title, artist, canonicalUrl: 'https://genius.test/target' }});
}
function credit(db: Database.Database, id: string, recordingId: string, providerId = 'person', role = 'Producer') {
  claim(db, id, recordingId, 'credits', {
    role, names: ['Person'], contributors: [{ providerId, name: 'Person' }]});
}

test('a stored cover becomes selectable and Graph-local when its target is added, then loses that match on removal', () => {
  const db = fixture();
  relation(db, 'covered', 'covered_by');
  reconcileLibraryConnections(db, now);
  let candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, 'local-source', 'Band');
  assert.equal(selectMostSpecificEligibleClaim(candidates, [], Date.parse(now)), null);
  cacheConnectionLibraryTracks(db, [{ id: 'target-local', title: 'Target', artist: 'Target Band' }], 'scan');
  reconcileLibraryConnections(db, now);
  const connection = libraryConnectionsInDatabase(db, 'source')[0];
  assert.equal(connection.type, 'covered_by');
  assert.equal(connection.matchState, 'matched');
  assert.equal(connection.tracks[0].id, 'target-local');
  candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, 'local-source', 'Band');
  assert.equal(selectMostSpecificEligibleClaim(candidates, [], Date.parse(now))?.claimId, 'covered');
  assert.equal(candidates[0].wording, 'Target by Target Band is a cover version of Source by Band.');
  const graph = researchConnectionsGraphInDatabase(db, { entityType: 'recording', entityId: 'source' });
  assert.ok(graph?.nodes.some((node) => node.localTrackId === 'target-local' && node.local));
  db.prepare('DELETE FROM sleeve_connection_library_tracks').run();
  reconcileLibraryConnections(db, now);
  assert.equal(libraryConnectionsInDatabase(db, 'source')[0].matchState, 'unresolved');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claims').get() as { n: number }).n, 1);
  db.close();
});

test('matching refuses another artist, a version qualifier, and ambiguous local copies', () => {
  const db = fixture();
  relation(db, 'sample', 'samples');
  cacheConnectionLibraryTracks(db, [
    { id: 'wrong', title: 'Target', artist: 'Other Band' },
    { id: 'live', title: 'Target (Live)', artist: 'Target Band' },
  ], 'scan');
  reconcileLibraryConnections(db);
  assert.equal(libraryConnectionsInDatabase(db, 'source')[0].matchState, 'unresolved');
  cacheConnectionLibraryTracks(db, [
    { id: 'copy-one', title: 'Target', artist: 'Target Band' },
    { id: 'copy-two', title: 'Target', artist: 'Target Band' },
  ], 'scan');
  reconcileLibraryConnections(db);
  const edge = libraryConnectionsInDatabase(db, 'source')[0];
  assert.equal(edge.matchState, 'ambiguous');
  assert.deepEqual(edge.tracks, []);
  db.close();
});

test('copies on different albums resolve when their recording MBID proves they are the same version', () => {
  const db = fixture();
  relation(db, 'sample', 'samples');
  const mbid = '12345678-1234-1234-1234-123456789012';
  cacheConnectionLibraryTracks(db, [
    { id: 'album-copy', title: 'Target', artist: 'Target Band', musicbrainzId: mbid },
    { id: 'compilation-copy', title: 'Target', artist: 'Target Band', musicbrainzId: mbid },
  ], 'scan');
  reconcileLibraryConnections(db);
  const edge = libraryConnectionsInDatabase(db, 'source')[0];
  assert.equal(edge.matchState, 'matched');
  assert.equal(edge.tracks.length, 1);
  assert.match(edge.tracks[0].matchBasis, /same-recording-copies/);
  db.close();
});

test('a shared contributor ID and role connects local peer recordings and boosts the credit Spark', () => {
  const db = fixture();
  recording(db, 'peer', 'Peer', '3');
  recording(db, 'namesake', 'Namesake', '4');
  recording(db, 'different-role', 'Different Role', '5');
  credit(db, 'source-credit', 'source');
  credit(db, 'peer-credit', 'peer');
  credit(db, 'namesake-credit', 'namesake', 'other-person');
  credit(db, 'writer-credit', 'different-role', 'person', 'Writer');
  relation(db, 'external-sample', 'samples');
  cacheConnectionLibraryTracks(db, [
    { id: 'local-source', title: 'Source', artist: 'Band' },
    { id: 'local-peer', title: 'Peer', artist: 'Band' },
    { id: 'local-namesake', title: 'Namesake', artist: 'Band' },
    { id: 'local-writer', title: 'Different Role', artist: 'Band' },
  ], 'scan');
  reconcileLibraryConnections(db);
  const edge = libraryConnectionsInDatabase(db, 'source').find((edge) => edge.type === 'producer');
  assert.deepEqual(edge?.tracks.map((track) => track.id), ['local-peer']);
  const candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, 'local-source', 'Band');
  const selected = selectMostSpecificEligibleClaim(candidates, [], Date.parse(now));
  assert.equal(selected?.claimId, 'source-credit');
  assert.match(selected!.wording, /Peer by Band also credits Person as producer/);
  db.prepare("UPDATE sleeve_claims SET enabled = 0 WHERE id = 'peer-credit'").run();
  // Read-side validation removes the enrichment even before the next sweep.
  assert.deepEqual(libraryConnectionsInDatabase(db, 'source').find((edge) => edge.type === 'producer')?.tracks, []);
  db.close();
});

test('a missing contributor ID cannot shift the next person identity onto the wrong credit name', () => {
  const db = fixture();
  claim(db, 'mixed-credit', 'source', 'credits', {
    role: 'Writer', names: ['Unidentified', 'Person'], contributors: [{ providerId: 'person', name: 'Person' }]});
  reconcileLibraryConnections(db);
  const graph = researchConnectionsGraphInDatabase(db, { entityType: 'recording', entityId: 'source' });
  const identified = graph?.nodes.find((node) => node.kind === 'contributor' && node.entityId === 'person');
  assert.equal(identified?.title, 'Person');
  assert.ok(graph?.nodes.some((node) => node.title === 'Unidentified' && node.entityId !== 'person'));
  db.close();
});

test('library matches take priority and sampled-in wording preserves the actual sampler', () => {
  const db = fixture();
  relation(db, 'sampled', 'sampled_in');
  cacheConnectionLibraryTracks(db, [{ id: 'target-local', title: 'Target', artist: 'Target Band' }], 'scan');
  reconcileLibraryConnections(db);
  const connection = loadExtendedSleeveNoteCandidatesInDatabase(db, 'local-source', 'Band')[0];
  assert.equal(connection.wording, 'Target by Target Band samples Source by Band.');
  const story = { ...connection, claimId: 'story', category: 'track-stories', provider: 'wikipedia', connection: undefined };
  assert.equal(selectMostSpecificEligibleClaim([story, connection], [], Date.parse(now))?.claimId, 'sampled');
  db.close();
});

test('Wikipedia replacement persists section-local rank without needing a wipe', () => {
  const db = fixture();
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('wiki', 'artist', 'artist', 'wikipedia', 'https://wiki.test', 'wiki', 'bounded-text', 'Facts.', 'Wiki', ?)`)
    .run(now);
  replaceAutomaticWikipediaClaimsInDatabase(db, { entityType: 'artist', entityId: 'artist', sourceDocumentId: 'wiki',
    candidates: [{ wording: 'A supported Wikipedia sentence.', topic: 'topic', category: 'artist-stories',
      evidence: 'A supported Wikipedia sentence.', extractionRank: 2, extractionSection: 3 }] });
  assert.deepEqual(db.prepare('SELECT extraction_rank AS rank, extraction_section AS section FROM sleeve_claims').get(), { rank: 2, section: 3 });
  db.close();
});

test('worker checkpoints pages, retries a failed album, and only prunes after a complete catalogue sweep', async () => {
  const db = fixture();
  relation(db, 'cover', 'covered_by');
  cacheConnectionLibraryTracks(db, [{ id: 'old', title: 'Old', artist: 'Band' }], 'old');
  let fail = true;
  const worker = new ConnectionLibraryWorker({ isQuiet: () => true }, {
    getAlbumList: async (offset) => offset === 0 ? [{ id: 'album' }] : [],
    getAlbumWithSongs: async () => {
      if (fail) throw new Error('temporary album failure');
      return { album: { id: 'album' }, songs: [{ id: 'target', title: 'Target', artist: 'Target Band' }] };
    },
    getScanStatus: async () => false}, () => db, () => true);
  const at = Date.parse(now);
  assert.equal(await worker.runOnce(at), false);
  assert.equal((db.prepare('SELECT album_offset FROM sleeve_connection_library_scan').get() as { album_offset: number }).album_offset, 0);
  assert.ok(db.prepare("SELECT 1 FROM sleeve_connection_library_tracks WHERE local_track_id = 'old'").get());
  fail = false;
  assert.equal(await worker.runOnce(at + 11 * 60_000), true);
  assert.equal(libraryConnectionsInDatabase(db, 'source')[0].tracks[0].id, 'target');
  assert.ok(db.prepare("SELECT 1 FROM sleeve_connection_library_tracks WHERE local_track_id = 'old'").get());
  assert.equal(await worker.runOnce(at + 12 * 60_000), true);
  assert.equal(db.prepare("SELECT 1 FROM sleeve_connection_library_tracks WHERE local_track_id = 'old'").get(), undefined);
  db.close();
});

test('a transient empty catalogue leaves the cached tracks and connections intact', async () => {
  const db = fixture();
  relation(db, 'sample', 'samples');
  cacheConnectionLibraryTracks(db, [{ id: 'target', title: 'Target', artist: 'Target Band' }], 'previous');
  reconcileLibraryConnections(db, now); // The failure must preserve an index that already exists.
  const worker = new ConnectionLibraryWorker({ isQuiet: () => true }, {
    getAlbumList: async () => [], getAlbumWithSongs: async () => null, getScanStatus: async () => false}, () => db, () => true);
  assert.equal(await worker.runOnce(Date.parse(now)), false);
  assert.equal(libraryConnectionsInDatabase(db, 'source')[0].tracks[0].id, 'target');
  assert.ok(db.prepare("SELECT 1 FROM sleeve_connection_library_tracks WHERE local_track_id = 'target'").get());
  db.close();
});

test('artist spelling variants resolve to library tracks while title variants remain distinct',()=>{
 const db=fixture();
 try{
  relation(db,'variant','samples','Target','Run-DMC');
  db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('run','Run‐D.M.C.','run‐d.m.c.')").run();
  cacheConnectionLibraryTracks(db,[{id:'run-song',title:'Target',artist:'Run‐D.M.C.'}],'variant');
  reconcileLibraryConnections(db,now);
  assert.equal(libraryConnectionsInDatabase(db,'source')[0].tracks[0]?.id,'run-song');
  cacheConnectionLibraryTracks(db,[{id:'run-song',title:'Target (Live)',artist:'Run‐D.M.C.'}],'variant-live');
  reconcileLibraryConnections(db,now);
  assert.equal(libraryConnectionsInDatabase(db,'source')[0].matchState,'unresolved');
 }finally{db.close();}
});

test('a Genius leading The resolves to the library artist while conflicting artist identities remain separate',()=>{
 const db=fixture();
 try {
  relation(db,'article-variant','samples','Target','The Incredible Bongo Band');
  db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('bongo','Incredible Bongo Band','incredible bongo band')").run();
  cacheConnectionLibraryTracks(db,[{id:'bongo-song',title:'Target',artist:'Incredible Bongo Band'}],'article-variant');
  reconcileLibraryConnections(db,now);
  assert.equal(libraryConnectionsInDatabase(db,'source')[0].tracks[0]?.id,'bongo-song');
  db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('other-bongo','The Incredible Bongo Band','the incredible bongo band')").run();
  reconcileLibraryConnections(db,now);
  assert.notEqual(libraryConnectionsInDatabase(db,'source')[0].matchState,'matched','distinct library identities must not be merged by name folding');
 } finally {db.close();}
});

test('saved knowledge and its filtered view count each intra-library sample/cover once', async () => {
  const { researchStoreSummaryInDatabase, searchResearchStoriesInDatabase } = await import('../src/sleeve-notes/research-repository.js');
  const { externalDiscoveriesInDatabase } = await import('../src/sleeve-notes/external-discoveries.js');
  const db = fixture();
  recording(db, 'target', 'Target', '2');
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,recording_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES ('local-target','target','Target','Band','matched',?,?,?)`).run(now,now,now);
  cacheConnectionLibraryTracks(db, [
    { id: 'local-source', title: 'Source', artist: 'Band' },
    { id: 'local-target', title: 'Target', artist: 'Band' },
    { id: 'target-copy', title: 'Target', artist: 'Band' },
  ], 'scan');
  db.prepare(`INSERT INTO sleeve_genius_library_seeds(local_track_id,recording_id,artist_key,title_key)
    VALUES ('target-copy','target','band','target')`).run();
  relation(db, 'sample', 'samples', 'Target', 'Band');
  relation(db, 'sample-copy', 'samples', 'Target', 'Band');
  claim(db, 'sample-inverse', 'target', 'musical-connections', { type: 'sampled_in', target: { providerId: '1', title: 'Source', artist: 'Band' } });
  relation(db, 'cover', 'cover_of', 'Target', 'Band');
  claim(db, 'cover-inverse', 'target', 'musical-connections', { type: 'covered_by', target: { providerId: '1', title: 'Source', artist: 'Band' } });
  claim(db, 'external', 'source', 'musical-connections', { type: 'samples', target: { providerId: '3', title: 'Outside', artist: 'Other Band' } });
  recording(db, 'off-library', 'Outside recording', '3');
  claim(db, 'off-library-source', 'off-library', 'musical-connections', { type: 'samples', target: { providerId: '1', title: 'Source', artist: 'Band' } });
  credit(db, 'producer', 'source');
  reconcileLibraryConnections(db, now);
  const summary = () => ({...researchStoreSummaryInDatabase(db),libraryConnections:searchResearchStoriesInDatabase(db,{category:'library-connections'}).total});
  const filtered = (input = {}) => searchResearchStoriesInDatabase(db, { category: 'library-connections', ...input });
  assert.equal(summary().libraryConnections, 2);
  assert.equal(summary().connectionClaims, 7, 'all saved facts retain their original count');
  assert.equal(externalDiscoveriesInDatabase(db).allSavedRelationships, 7);
  assert.equal(filtered().total, 2);
  assert.equal(filtered().claims.length, 2);
  assert.ok(filtered().claims.every(row => row.category === 'musical-connections'));
  assert.equal(filtered({ limit: 1, offset: 1 }).claims.length, 1);
  assert.equal(filtered({ search: 'absent phrase' }).total, 0);
  // Withdrawn facts and stale match snapshots cannot contribute a relationship.
  db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id IN ('sample','sample-copy')").run();
  assert.equal(summary().libraryConnections, 2, 'the inverse fact still supports the same pair');
  db.prepare("UPDATE sleeve_claims SET evidence='Changed evidence' WHERE id='sample-inverse'").run();
  assert.equal(summary().libraryConnections, 1);
  assert.equal(filtered().total, 1);
  db.prepare("UPDATE sleeve_connection_edges SET match_state='ambiguous' WHERE claim_id IN ('cover','cover-inverse')").run();
  assert.equal(summary().libraryConnections, 0);
  reconcileLibraryConnections(db, now);
  assert.equal(summary().libraryConnections, 1);
  db.prepare("DELETE FROM sleeve_connection_library_tracks WHERE local_track_id IN ('local-target','target-copy')").run();
  assert.equal(summary().libraryConnections, 0, 'both ends must still exist in the current catalogue');
  assert.equal(filtered().total, 0);
  assert.equal(summary().connectionClaims, 5, 'library removal does not delete the saved collection');
  db.close();
});


test('the real read-only child serves library connection pages without blocking or changing the cache', async () => {
  const { libraryConnectionStoriesInBackground, stopConnectionCompute } = await import('../src/sleeve-notes/connection-compute.js');
  const { readFileSync } = await import('node:fs');
  const db = fixture();
  relation(db, 'sample', 'samples', 'Target', 'Band');
  cacheConnectionLibraryTracks(db, [{ id:'local-source',title:'Source',artist:'Band' },{ id:'target-local',title:'Target',artist:'Band' }], 'scan');
  reconcileLibraryConnections(db, now);
  const file=join(root,'library-count-child.db');await db.backup(file);db.close();
  const saved=readFileSync(file);const disk=new Database(file);
  try {
    let yielded=false;
    const reading=libraryConnectionStoriesInBackground(disk,{category:'library-connections',limit:1});
    await new Promise<void>(resolve=>setImmediate(()=>{yielded=true;resolve();}));
    const result=await reading;
    assert.equal(yielded,true);assert.equal(result.total,1);assert.equal(result.claims[0].id,'sample');
    assert.deepEqual(readFileSync(file),saved,'background reads cannot rewrite the saved database');
    disk.prepare("DELETE FROM sleeve_connection_library_tracks WHERE local_track_id='target-local'").run();
    assert.equal((await libraryConnectionStoriesInBackground(disk,{category:'library-connections'})).total,0);
  } finally {stopConnectionCompute();disk.close();}
});

test('the library-only HTTP filter shares its count with pages and respects the master switch', async () => {
  const express=(await import('express')).default;
  const notes=await import('../src/sleeve-notes/db.js');
  const settings=await import('../src/settings.js');
  const settingsStore=await import('../src/settings/store.js');
  const {router}=await import('../src/routes/sleeve-notes.js');
  const {stopConnectionCompute}=await import('../src/sleeve-notes/connection-compute.js');
  const {existsSync,readFileSync}=await import('node:fs');
  const previous=settings.get();
  settingsStore.setCache({...previous,djBehaviour:{...previous.djBehaviour,extendedSleeveNotes:false}});
  notes.close();
  for(const suffix of ['','-wal','-shm'])rmSync(notes.DB_PATH+suffix,{force:true});
  const app=express();app.use(router);const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('No port');
  const url=`http://127.0.0.1:${address.port}/sleeve-notes/stories?category=library-connections&cached=1`;
  try {
    const absent=await fetch(url+'&limit=1');assert.equal(absent.status,200);
    assert.equal(existsSync(notes.DB_PATH),false,'disabled reads cannot create the station cache');
    const fixtureDb=fixture();relation(fixtureDb,'sample','samples','Target','Band');
    cacheConnectionLibraryTracks(fixtureDb,[{id:'local-source',title:'Source',artist:'Band'},{id:'target-local',title:'Target',artist:'Band'}],'scan');
    reconcileLibraryConnections(fixtureDb,now);await fixtureDb.backup(notes.DB_PATH);fixtureDb.close();
    const bytes=readFileSync(notes.DB_PATH);
    const cached=await fetch(url);assert.equal(cached.status,200,'cached browsing bypasses the master switch without writes');
    assert.deepEqual(readFileSync(notes.DB_PATH),bytes);
    settingsStore.setCache({...previous,djBehaviour:{...previous.djBehaviour,extendedSleeveNotes:true}});
    const count=await fetch(url+'&limit=1');assert.equal(count.status,200);
    const result=await count.json() as {total:number;claims:Array<{id:string}>};
    assert.equal(result.total,1);assert.equal(result.claims[0].id,'sample');
    const page=await fetch(url);assert.equal(page.status,200);
    assert.equal((await page.json() as {total:number}).total,result.total);
  } finally {
    stopConnectionCompute();notes.close();settingsStore.setCache(previous);
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});


test('catalogue responses cannot publish after disable, collection pause or broadcast priority changes',async t=>{
 for(const phase of ['listing','album'] as const) for(const reason of ['settings','broadcast'] as const) {
  await t.test(`${phase}: ${reason}`,async()=>{
   const db=fixture();let enabled=true,quiet=true;
   cacheConnectionLibraryTracks(db,[{id:'old',title:'Old',artist:'Band'}],'old');
   const before=db.prepare('SELECT * FROM sleeve_connection_library_tracks').all();
   const interrupt=()=>{if(reason==='settings')enabled=false;else quiet=false;};
   try {
    const worker=new ConnectionLibraryWorker({isQuiet:()=>quiet},{
     getAlbumList:async()=>{if(phase==='listing')interrupt();return [{id:'album'}];},
     getAlbumWithSongs:async()=>{interrupt();return {album:{id:'album'},songs:[{id:'new',title:'New',artist:'Band'}]};},
     getScanStatus:async()=>false},()=>db,()=>enabled);
    assert.equal(await worker.runOnce(Date.parse(now)),false);
    assert.deepEqual(db.prepare('SELECT * FROM sleeve_connection_library_tracks').all(),before);
    assert.equal((db.prepare('SELECT album_offset FROM sleeve_connection_library_scan').get() as {album_offset:number}).album_offset,0);
   } finally {db.close();}
  });
 }
});

test('a Navidrome scan starting during an album fetch discards that response and restarts the sweep',async()=>{
 const db=fixture();let scanning=false;
 try {
  cacheConnectionLibraryTracks(db,[{id:'old',title:'Old',artist:'Band'}],'old');
  const worker=new ConnectionLibraryWorker({isQuiet:()=>true},{
   getAlbumList:async()=>[{id:'album'}],
   getAlbumWithSongs:async()=>{scanning=true;return {album:{id:'album'},songs:[{id:'new',title:'New',artist:'Band'}]};},
   getScanStatus:async()=>scanning},()=>db,()=>true);
  assert.equal(await worker.runOnce(Date.parse(now)),false);
  assert.deepEqual(db.prepare('SELECT local_track_id FROM sleeve_connection_library_tracks').all(),[{local_track_id:'old'}]);
  assert.equal((db.prepare('SELECT album_offset FROM sleeve_connection_library_scan').get() as {album_offset:number}).album_offset,0);
 } finally {db.close();}
});

test('an unknown scan status cannot authorise deleting unseen cached tracks',async()=>{
 const db=fixture();let page=0;let scanKnown=true;
 try {
  cacheConnectionLibraryTracks(db,[{id:'old',title:'Old',artist:'Band'}],'old');
  const worker=new ConnectionLibraryWorker({isQuiet:()=>true},{
   getAlbumList:async()=>page++===0?[{id:'album'}]:[],
   getAlbumWithSongs:async()=>({album:{id:'album'},songs:[{id:'new',title:'New',artist:'Band'}]}),
   getScanStatus:async()=>scanKnown?false:null},()=>db,()=>true);
  assert.equal(await worker.runOnce(Date.parse(now)),true);
  scanKnown=false;
  assert.equal(await worker.runOnce(Date.parse(now)+30_000),false);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_connection_library_tracks').get() as {n:number}).n,2);
  assert.equal((db.prepare('SELECT completed_at FROM sleeve_connection_library_scan').get() as {completed_at:null}).completed_at,null);
 } finally {db.close();}
});

test('matching batches continuing research for five minutes, waits for quiet time and skips unchanged revisions',async()=>{
  const db=fixture();let calls=0,quiet=true;
  const at=Date.parse(now);
  try {
    db.prepare(`INSERT INTO sleeve_connection_library_scan(id,generation,album_offset,run_after)
      VALUES(1,'parked',0,?)`).run(new Date(at+24*60*60_000).toISOString());
    relation(db,'initial','samples');
    const {reconcileConnectionsInBackground}=await import('../src/sleeve-notes/connection-compute.js');
    const worker=new ConnectionLibraryWorker({isQuiet:()=>quiet},{
      getAlbumList:async()=>{throw new Error('Catalogue is not due');},
      getAlbumWithSongs:async()=>{throw new Error('Catalogue is not due');},getScanStatus:async()=>false},()=>db,()=>true,async database=>{calls++;return reconcileConnectionsInBackground(database);});
    await worker.runOnce(at);
    assert.equal(calls,1);
    for(let n=1;n<10;n++) {
      relation(db,`pending-${n}`,'samples');
      await worker.runOnce(at+n*30_000);
      assert.equal(calls,1,'new facts must not restart the full calculation every timer tick');
    }
    assert.equal(libraryConnectionsInDatabase(db,'source').length,1);
    quiet=false;await worker.runOnce(at+5*60_000);assert.equal(calls,1);
    quiet=true;await worker.runOnce(at+5*60_000+30_000);
    assert.equal(calls,2);
    assert.equal(libraryConnectionsInDatabase(db,'source').length,10,'all accumulated facts must be published together');
    await worker.runOnce(at+11*60_000);assert.equal(calls,2,'an elapsed interval alone must not trigger unchanged work');
    relation(db,'later','samples');await worker.runOnce(at+11*60_000+30_000);
    assert.equal(calls,3,'unchanged checks must not keep moving the deadline forward');
  } finally {db.close();}
});

test('stale matching attempts are batched too; failures retain ten-minute backoff and pending revisions',async()=>{
  const db=fixture();let calls=0,enabled=true;
  const at=Date.parse(now);
  try {
    db.prepare(`INSERT INTO sleeve_connection_library_scan(id,generation,album_offset,run_after)
      VALUES(1,'parked',0,?)`).run(new Date(at+24*60*60_000).toISOString());
    const worker=new ConnectionLibraryWorker({isQuiet:()=>true},{
      getAlbumList:async()=>[],getAlbumWithSongs:async()=>null,getScanStatus:async()=>false},()=>db,()=>enabled,async database=>{
      calls++;
      if(calls===1)return null; // A source change invalidated the calculated snapshot.
      if(calls===2)throw new Error('Matching temporarily unavailable');
      return connectionRevision(database,'facts');
    });
    await worker.runOnce(at);assert.equal(calls,1);
    relation(db,'pending','samples');
    await worker.runOnce(at+30_000);assert.equal(calls,1);
    await worker.runOnce(at+5*60_000);assert.equal(calls,2);
    await worker.runOnce(at+15*60_000-1);assert.equal(calls,2);
    enabled=false;await worker.runOnce(at+15*60_000);assert.equal(calls,2);
    enabled=true;await worker.runOnce(at+15*60_000+30_000);assert.equal(calls,3);
    await worker.runOnce(at+21*60_000);assert.equal(calls,3,'the eventual successful revision must be remembered');
  } finally {db.close();}
});

test('library relationships recognise unplayed Genius sources using the same safe catalogue resolver', async () => {
  const { searchResearchStoriesInDatabase } = await import('../src/sleeve-notes/research-repository.js');
  const db = fixture();
  try {
    db.prepare('DELETE FROM sleeve_local_attachments').run();
    recording(db, 'target', 'Target', '2');
    relation(db, 'forward', 'samples', 'Target', 'Band');
    claim(db, 'inverse', 'target', 'musical-connections', {
      type: 'sampled_in', target: { providerId: '1', title: 'Source', artist: 'Band' },
    });
    const source = { id: 'unplayed-source', title: 'Source', artist: 'Band', musicbrainzId: '11111111-1111-1111-1111-111111111111' };
    const target = { id: 'unplayed-target', title: 'Target', artist: 'Band', musicbrainzId: '22222222-2222-2222-2222-222222222222' };
    const count = () => searchResearchStoriesInDatabase(db, { category: 'library-connections' }).total;
    cacheConnectionLibraryTracks(db, [source, target, { ...source, id: 'source-copy' }], 'scan');
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 1, 'both directions and compilation copies count as one internal relationship');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_local_attachments').get() as {n:number}).n, 0,
      'recognising library membership must not invent a played-track attachment');

    db.prepare("UPDATE sleeve_connection_library_tracks SET musicbrainz_recording_id='different-version' WHERE local_track_id='source-copy'").run();
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 0, 'same-title recordings with different identities remain ambiguous');
    db.prepare("DELETE FROM sleeve_connection_library_tracks WHERE local_track_id='source-copy'").run();
    db.prepare("UPDATE sleeve_recordings SET musicbrainz_id='conflicting-source-mbid' WHERE id='source'").run();
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 0, 'a known conflicting recording identity defeats an exact title match');
    db.prepare("UPDATE sleeve_recordings SET musicbrainz_id=NULL WHERE id='source'").run();
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 1);
    cacheConnectionLibraryTracks(db, [{...source, title:'Source (Live)'}], 'scan');
    assert.equal(count(), 0, 'metadata invalidation clears the old source binding before the next matching pass');
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 0, 'a live version cannot substitute for the named studio recording');
    cacheConnectionLibraryTracks(db, [source], 'scan');
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 1);
    db.prepare("DELETE FROM sleeve_connection_library_tracks WHERE local_track_id='unplayed-source'").run();
    assert.equal(count(), 0, 'external sources do not count even when the target is local');
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 0);
    cacheConnectionLibraryTracks(db, [source], 'scan');
    db.prepare("DELETE FROM sleeve_connection_library_tracks WHERE local_track_id='unplayed-target'").run();
    reconcileLibraryConnections(db, now);
    assert.equal(count(), 0, 'external targets do not count even when the source is local');
  } finally { db.close(); }
});


test('pre-upgrade cached library counts remain readable without changing schema', async () => {
  const { searchResearchStoriesInDatabase } = await import('../src/sleeve-notes/research-repository.js');
  const db = fixture();
  try {
    relation(db, 'forward', 'samples', 'Target', 'Band');
    cacheConnectionLibraryTracks(db, [
      { id: 'local-source', title: 'Source', artist: 'Band' },
      { id: 'local-target', title: 'Target', artist: 'Band' },
    ], 'scan');
    reconcileLibraryConnections(db, now);
    db.exec('DROP INDEX idx_sleeve_connection_source_local; ALTER TABLE sleeve_connection_edges DROP COLUMN source_local_track_id');
    db.pragma('user_version=2');
    db.pragma('query_only=ON');
    assert.equal(searchResearchStoriesInDatabase(db, {category:'library-connections'}).total, 1);
    assert.equal(db.pragma('user_version', {simple:true}), 2);
  } finally { db.close(); }
});
