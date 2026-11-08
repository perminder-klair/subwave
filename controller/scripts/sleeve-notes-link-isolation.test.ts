import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const root=createTempDir(join(tmpdir(),'subwave-link-isolation-'));process.env.STATE_DIR=root;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const notes=await import('../src/sleeve-notes/db.js');
const {sleeveNotesFor}=await import('../src/llm/internal/prompts/sleeve-notes.js');
const saved=settings.get();
store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:false}});
const track={id:'library-track',title:'Song',album:'Library Album',year:2001};
const expected=['Album: Library Album.','Release year: 2001.'];

test('ordinary link metadata with master off cannot create the optional research database',()=>{
 try {
  assert.deepEqual(sleeveNotesFor(track),expected);
  assert.equal(existsSync(notes.DB_PATH),false);
 } finally {
  notes.close();
  for(const suffix of ['', '-wal', '-shm'])rmSync(notes.DB_PATH+suffix,{force:true});
 }
});

test('ordinary link metadata with master off cannot migrate or write an older research database',()=>{
 const db=new Database(notes.DB_PATH);notes.migrate(db);db.pragma('user_version=56');db.close();
 const before=readFileSync(notes.DB_PATH);
 assert.deepEqual(sleeveNotesFor(track),expected);
 assert.deepEqual(readFileSync(notes.DB_PATH),before);
 assert.equal(existsSync(notes.DB_PATH+'-wal'),false);
 rmSync(notes.DB_PATH, {force:true});
});

test('canonical enrichment works when enabled and is ignored after disabling without losing library facts',async()=>{
 const {admitLocalEncounterInDatabase,retainCanonicalMusicBrainzMatchInDatabase}=await import('../src/sleeve-notes/research-repository.js');
 const {projectCanonicalRecording}=await import('../src/music/musicbrainz.js');
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true}});
 const db=notes.open();
 admitLocalEncounterInDatabase(db,{localTrackId:track.id,title:track.title,artist:'Example Band',releaseTitle:track.album,musicbrainzRecordingId:null,source:'played',priority:1});
 const match=projectCanonicalRecording({id:'recording',title:track.title,
  'artist-credit':[{name:'Example Band',artist:{id:'artist',name:'Example Band'}}],
  releases:[{id:'original',title:'Original Album',date:'1990-01-01',status:'Official',
   'release-group':{id:'group','primary-type':'Album','secondary-types':[]}}]});
 assert.ok(match);retainCanonicalMusicBrainzMatchInDatabase(db,track.id,match);
 assert.deepEqual(sleeveNotesFor(track),['Album: Original Album.','Release year: 1990.']);
 notes.close();const before=readFileSync(notes.DB_PATH);
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:false}});
 assert.deepEqual(sleeveNotesFor(track),expected);
 assert.deepEqual(readFileSync(notes.DB_PATH),before,'disable must not modify retained canonical research');
});

test.after(async ()=>{notes.close();store.setCache(saved);await removeTempDir(root);});
