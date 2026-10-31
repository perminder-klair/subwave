import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, {after,beforeEach} from 'node:test';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-local-identity-'));process.env.STATE_DIR=root;
const notes=await import('../src/sleeve-notes/db.js');
const repo=await import('../src/sleeve-notes/research-repository.js');
const settings=await import('../src/settings.js');
const {cacheConnectionLibraryTracks}=await import('../src/sleeve-notes/library-connections.js');
const {loadExtendedSleeveNoteCandidatesInDatabase}=await import('../src/sleeve-notes/link-selection.js');
const {projectCanonicalRecording}=await import('../src/music/musicbrainz.js');
const {MusicBrainzMatchWorker}=await import('../src/sleeve-notes/musicbrainz-worker.js');
const input={localTrackId:'track',title:'Old Song',artist:'Old Band',releaseTitle:'Old Album',musicbrainzRecordingId:null,source:'played' as const,priority:100};
const canonical=projectCanonicalRecording({id:'old-mbid',title:'Old Song','artist-credit':[{name:'Old Band',artist:{id:'old-artist',name:'Old Band'}}],releases:[]})!;
assert.ok(canonical);
beforeEach(async()=>{
 notes.close();for(const suffix of ['','-wal','-shm'])rmSync(notes.DB_PATH+suffix,{force:true});
 await settings.update({djBehaviour:{extendedSleeveNotes:true,sleeveNotesCollectionPaused:false}});
});
after(async ()=>{notes.close();await removeTempDir(root);});
function fixture(){
 const db=notes.open();repo.admitLocalEncounterInDatabase(db,input);repo.retainCanonicalMusicBrainzMatchInDatabase(db,input.localTrackId,canonical);
 const row=db.prepare("SELECT recording_id AS id FROM sleeve_local_attachments WHERE local_track_id='track'").get() as {id:string};
 db.prepare("INSERT INTO sleeve_genius_local_tracks VALUES ('track',?)").run(row.id);
 db.prepare("INSERT INTO sleeve_genius_library_seeds VALUES ('track',?,'old song','old band')").run(row.id);
 cacheConnectionLibraryTracks(db,[{id:'track',title:input.title,artist:input.artist,album:input.releaseTitle}],'scan');
 const source=repo.retainSourceDocument({entityType:'recording',entityId:row.id,provider:'genius',sourceUrl:'https://example.test/old-song',revisionId:null,contentKind:'bounded-text',content:'A saved old song story.',attribution:'Example'});
 db.prepare("INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,evidence,source_document_id,created_at,updated_at) VALUES ('old-fact','recording',?,'track-stories','recording','A saved old song story.','A saved old song story.',?,'old','old')").run(row.id,source);
 db.prepare("INSERT INTO sleeve_series_library_claims VALUES ('track','album','old-fact','series','member','old')").run();
 db.prepare("INSERT INTO sleeve_claim_history(id,claim_id,action,actor,before_json,created_at) VALUES ('history','old-fact','corrected','operator','{}','old')").run();
 db.prepare("UPDATE sleeve_research_jobs SET state='complete',attempts=7,completed_at='old' WHERE subject_type='local-track'").run();
 return db;
}

test('retagging removes local canonical, Genius and Series bindings, requeues work and preserves knowledge/history',()=>{
 const db=fixture();const claims=db.prepare('SELECT * FROM sleeve_claims').all();
 repo.admitLocalEncounterInDatabase(db,{...input,title:'New Song',artist:'New Band',releaseTitle:'New Album'});
 assert.deepEqual(db.prepare("SELECT recording_id AS id,match_state AS state,musicbrainz_recording_id AS mbid FROM sleeve_local_attachments WHERE local_track_id='track'").get(),{id:null,state:'unmatched',mbid:null});
 for(const table of ['sleeve_genius_local_tracks','sleeve_genius_library_seeds','sleeve_series_library_claims'])assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_research_jobs WHERE subject_type='local-track' AND (state<>'queued' OR attempts<>0 OR completed_at IS NOT NULL)").get() as {n:number}).n,0);
 assert.deepEqual(loadExtendedSleeveNoteCandidatesInDatabase(db,'track','New Band'),[]);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_claims').all(),claims);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_history').get() as {n:number}).n,1);
});

test('case, whitespace and omitted optional metadata do not restart completed matching',()=>{
 const db=fixture();
 repo.admitLocalEncounterInDatabase(db,{...input,title:' old   SONG ',artist:' OLD BAND ',releaseTitle:null,source:'queue'});
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'matched');
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_research_jobs WHERE subject_type='local-track' AND state='complete'").get() as {n:number}).n,2);
 assert.equal((db.prepare("SELECT musicbrainz_recording_id AS id FROM sleeve_local_attachments").get() as {id:string}).id,'old-mbid');
});

test('catalogue updates invalidate before the track plays, including changed recording MBIDs',()=>{
 const db=fixture();
 cacheConnectionLibraryTracks(db,[{id:'track',title:input.title,artist:input.artist,album:input.releaseTitle,musicbrainzId:'11111111-1111-4111-8111-111111111111'}],'new-scan');
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'unmatched');
 assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz' AND subject_type='local-track'").get() as {state:string}).state,'queued');
 assert.deepEqual(loadExtendedSleeveNoteCandidatesInDatabase(db,'track','Old Band'),[]);
});

test('an old MusicBrainz response cannot republish after metadata changes during lookup',async()=>{
 const db=notes.open();repo.admitLocalEncounterInDatabase(db,input);
 const worker=new MusicBrainzMatchWorker({isQuiet:()=>true},{lookup:async()=>{
  repo.admitLocalEncounterInDatabase(db,{...input,title:'New Song',artist:'New Band',musicbrainzRecordingId:'new-mbid'});
  return canonical;
 }});
 assert.equal(await worker.runOnce(),true);
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'unmatched');
 assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz'").get() as {state:string}).state,'queued');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_recordings').get() as {n:number}).n,0);
});

test('server/account changes clear only local bindings; password rotation and a same-source restart preserve them',async()=>{
 const {config}=await import('../src/config.js');
 const previous={...config.navidrome};
 try {
  const db=fixture();const claims=db.prepare('SELECT * FROM sleeve_claims').all();
  config.navidrome.password='rotated-test-password';
  assert.equal((notes.open().prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'matched');
  config.navidrome.url='http://other-library.test';config.navidrome.user='other-test-user';
  assert.equal((notes.open().prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'unmatched');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_connection_library_tracks').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_genius_local_tracks').get() as {n:number}).n,0);
  assert.deepEqual(db.prepare('SELECT * FROM sleeve_claims').all(),claims);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_history").get() as {n:number}).n,1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_research_jobs WHERE subject_type='local-track' AND state<>'cancelled'").get() as {n:number}).n,0);
  repo.admitLocalEncounterInDatabase(db,{...input,title:'New Song',artist:'New Band'});
  db.prepare("UPDATE sleeve_local_attachments SET match_state='matched'").run();
  notes.close();
  assert.equal((notes.open().prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'matched');
 } finally {notes.close();Object.assign(config.navidrome,previous);}
});

test('disabled cached reads cannot reset bindings after a music source change',async()=>{
 const {config}=await import('../src/config.js');const {readFileSync}=await import('node:fs');
 const previous={...config.navidrome};
 try {
  fixture();notes.close();const before=readFileSync(notes.DB_PATH);
  config.navidrome.url='http://other-library.test';
  const state=notes.withCachedRead(()=>notes.open().prepare('SELECT match_state FROM sleeve_local_attachments').get()) as {match_state:string};
  assert.equal(state.match_state,'matched');assert.deepEqual(readFileSync(notes.DB_PATH),before);
  assert.equal((notes.open().prepare('SELECT match_state FROM sleeve_local_attachments').get() as {match_state:string}).match_state,'unmatched');
 } finally {notes.close();Object.assign(config.navidrome,previous);}
});

test('a source change during MusicBrainz lookup leaves the old local job cancelled',async()=>{
 const {config}=await import('../src/config.js');const previous={...config.navidrome};
 try {
  const db=notes.open();repo.admitLocalEncounterInDatabase(db,input);
  const worker=new MusicBrainzMatchWorker({isQuiet:()=>true},{lookup:async()=>{config.navidrome.url='http://other-library.test';return canonical;}});
  await worker.runOnce();
  assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz'").get() as {state:string}).state,'cancelled');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_recordings').get() as {n:number}).n,0);
 } finally {notes.close();Object.assign(config.navidrome,previous);}
});

test('an old catalogue response cannot populate the cache after a source change',async()=>{
 const {config}=await import('../src/config.js');const {ConnectionLibraryWorker}=await import('../src/sleeve-notes/connection-library-worker.js');
 const previous={...config.navidrome};
 try {
  const db=notes.open();
  const worker=new ConnectionLibraryWorker({isQuiet:()=>true},{
   getScanStatus:async()=>false,
   getAlbumList:async()=>[{id:'album'}],
   getAlbumWithSongs:async()=>{config.navidrome.url='http://other-library.test';return {album:{id:'album',name:'Old album'},songs:[{id:'old-track',title:'Old Song',artist:'Old Band'}]};}});
  assert.equal(await worker.runOnce(),false);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_connection_library_tracks').get() as {n:number}).n,0);
 } finally {notes.close();Object.assign(config.navidrome,previous);}
});

test('explicit Station Brain artist and album research also discard a stale local identity',async()=>{
 const {queueBrainLibrarySeedInDatabase}=await import('../src/sleeve-notes/brain-coverage.js');
 const {queueBrainLibraryAlbumInDatabase}=await import('../src/sleeve-notes/brain-album-research.js');
 const db=fixture();
 const seed={id:'track',title:'New Song',artist:'New Band',album:'New Album',mbid:null};
 queueBrainLibrarySeedInDatabase(db,seed);
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments WHERE local_track_id='track'").get() as {match_state:string}).match_state,'unmatched');
 repo.retainCanonicalMusicBrainzMatchInDatabase(db,'track',canonical);
 queueBrainLibraryAlbumInDatabase(db,{albumId:'new-album',title:'Another Album',track:{...seed,title:'Another Song'}});
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments WHERE local_track_id='track'").get() as {match_state:string}).match_state,'unmatched');
 assert.equal((db.prepare("SELECT state FROM sleeve_brain_album_requests WHERE local_album_id='new-album'").get() as {state:string}).state,'waiting');
});


test('authoritative tag removal clears the bad MBID without rematching inferred tagless recordings',()=>{
 const db=fixture();
 // Matching fills attachment MBIDs even when the catalogue has no tag.
 cacheConnectionLibraryTracks(db,[{id:'track',title:input.title,artist:input.artist,album:input.releaseTitle,musicbrainzId:null}],'unchanged');
 assert.equal(repo.localAttachmentForMatch('track')?.musicbrainzRecordingId,'old-mbid');
 assert.equal((db.prepare("SELECT match_state FROM sleeve_local_attachments").get() as {match_state:string}).match_state,'matched');
 // A previous authoritative catalogue row proves this tag actually existed.
 const tagged='11111111-1111-4111-8111-111111111111';
 db.prepare('UPDATE sleeve_connection_library_tracks SET musicbrainz_recording_id=?').run(tagged);
 db.prepare('UPDATE sleeve_local_attachments SET musicbrainz_recording_id=?').run(tagged);
 cacheConnectionLibraryTracks(db,[{id:'track',title:input.title,artist:input.artist,album:input.releaseTitle,musicbrainzId:null}],'removed');
 assert.equal(repo.localAttachmentForMatch('track')?.musicbrainzRecordingId,null);
 assert.equal((db.prepare('SELECT match_state FROM sleeve_local_attachments').get() as {match_state:string}).match_state,'unmatched');
 assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE provider='musicbrainz'").get() as {state:string}).state,'queued');
 repo.admitLocalEncounterInDatabase(db,{...input,source:'queue'});
 assert.equal(repo.localAttachmentForMatch('track')?.musicbrainzRecordingId,null,'partial playback must not resurrect the removed tag');
 assert.deepEqual(loadExtendedSleeveNoteCandidatesInDatabase(db,'track','Old Band'),[]);
});

test('removing artist metadata invalidates a catalogue row instead of leaving old local matches',()=>{
 const db=fixture();
 cacheConnectionLibraryTracks(db,[{id:'track',title:input.title,artist:'',album:input.releaseTitle}],'artist-removed');
 assert.equal((db.prepare('SELECT match_state FROM sleeve_local_attachments').get() as {match_state:string}).match_state,'unmatched');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_connection_library_tracks').get() as {n:number}).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_genius_local_tracks').get() as {n:number}).n,0);
});


test('explicit Station Brain research notices tag removal before the next catalogue sweep',async()=>{
 const {queueBrainLibrarySeedInDatabase}=await import('../src/sleeve-notes/brain-coverage.js');
 const db=fixture();
 db.prepare("UPDATE sleeve_connection_library_tracks SET musicbrainz_recording_id='11111111-1111-4111-8111-111111111111'").run();
 queueBrainLibrarySeedInDatabase(db,{id:'track',title:input.title,artist:input.artist,album:input.releaseTitle,mbid:null});
 assert.equal((db.prepare('SELECT match_state FROM sleeve_local_attachments').get() as {match_state:string}).match_state,'unmatched');
 assert.equal(repo.localAttachmentForMatch('track')?.musicbrainzRecordingId,null);
});
