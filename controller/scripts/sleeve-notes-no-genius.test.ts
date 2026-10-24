import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-no-genius-'));process.env.STATE_DIR=root;
delete process.env.GENIUS_ACCESS_TOKEN;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const notes=await import('../src/sleeve-notes/db.js');
const repo=await import('../src/sleeve-notes/research-repository.js');
const {GeniusResearchWorker}=await import('../src/sleeve-notes/genius-worker.js');
const {projectCanonicalRecording}=await import('../src/music/musicbrainz.js');
const {brainLibraryGraph}=await import('../src/sleeve-notes/brain-library.js');
await settings.load();const saved=settings.get();
function configure(enabled:boolean,accessToken:string) {
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true},
  sleeveNotes:{...saved.sleeveNotes,providers:{...saved.sleeveNotes.providers,genius:{enabled,accessToken}}}});
}
function encounter(id:string,autopilot=false) {
 repo.admitLocalEncounter({localTrackId:id,title:'Song',artist:'Band',releaseTitle:'Album',musicbrainzRecordingId:null,
  source:'played',priority:1,autopilot,listenerPresent:false});
}

test('Genius off with a saved key creates no Genius jobs and preserves Wikipedia research and an old queued job',async t=>{
 configure(true,'synthetic-key');
 repo.enqueueResearchJob({provider:'genius',subjectType:'local-track',subjectId:'old',capability:'connections',priority:100});
 const db=notes.open();
 const old=db.prepare("SELECT * FROM sleeve_research_jobs WHERE provider='genius'").all();
 configure(false,'synthetic-key');
 encounter('fresh',true);
 assert.ok(db.prepare("SELECT 1 FROM sleeve_local_attachments WHERE local_track_id='fresh'").get(),'paused Genius work must not block new autopilot admission');
 const canonical=projectCanonicalRecording({id:'recording',title:'Song','artist-credit':[{name:'Band',artist:{id:'artist',name:'Band'}}],
  releases:[{id:'release',title:'Album',date:'2001-01-01',status:'Official','release-group':{id:'group','primary-type':'Album','secondary-types':[]}}]});
 assert.ok(canonical);repo.retainCanonicalMusicBrainzMatch('fresh',canonical);
 repo.enqueueResearchJob({provider:'genius',subjectType:'release',subjectId:'fallback',capability:'album-biography',priority:1});
 assert.equal(repo.enqueueGeniusAlbumPilotJobs(),0);
 assert.deepEqual(db.prepare("SELECT * FROM sleeve_research_jobs WHERE provider='genius'").all(),old);
 assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='wikipedia' AND capability='biography'").get());
 assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='wikipedia' AND capability='release-group-biography'").get());
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Genius must not be contacted');});
 assert.equal(await new GeniusResearchWorker({isQuiet:()=>true}).runOnce(),false);
 assert.equal(network.mock.callCount(),0);
 assert.deepEqual(db.prepare("SELECT * FROM sleeve_research_jobs WHERE provider='genius'").all(),old);
});

test('enabled Genius without a key waits without requests or changing existing jobs',async t=>{
 configure(true,'');
 const before=notes.open().prepare("SELECT * FROM sleeve_research_jobs WHERE provider='genius'").all();
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Missing-key worker must not contact Genius');});
 assert.equal(await new GeniusResearchWorker({isQuiet:()=>true}).runOnce(),false);
 assert.equal(network.mock.callCount(),0);
 assert.deepEqual(notes.open().prepare("SELECT * FROM sleeve_research_jobs WHERE provider='genius'").all(),before);
});

test('Station Brain still browses library artists, albums and tracks without any Genius source',async t=>{
 configure(false,'synthetic-key');
 const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async(input)=>{
  const url=String(input);calls.push(url);
  if(url.includes('/rest/getArtist'))return Response.json({'subsonic-response':{status:'ok',artist:{id:'library-artist',name:'Band',album:[{id:'album',name:'Album'}]}}});
  if(url.includes('/rest/getAlbum'))return Response.json({'subsonic-response':{status:'ok',album:{id:'album',name:'Album',artistId:'library-artist',song:[{id:'fresh',title:'Song',artist:'Band'}]}}});
  throw new Error('Unexpected external request');
 });
 const artist=await brainLibraryGraph('library-artist','library-artist');
 assert.ok(artist.nodes.some(node=>node.title==='Album'));
 const album=await brainLibraryGraph('library-album','album');
 assert.ok(album.nodes.some(node=>node.title==='Song'));
 assert.equal(notes.open().prepare("SELECT 1 FROM sleeve_source_documents WHERE provider='genius'").get(),undefined);
 assert.ok(calls.length>0);assert.ok(calls.every(url=>url.includes('/rest/')));
});

test('Wikipedia facts remain selectable for links and can produce a native segment while Genius is off',async()=>{
 configure(false,'synthetic-key');
 const db=notes.open();
 const artist=(db.prepare("SELECT artist_id AS id FROM sleeve_recordings WHERE musicbrainz_id='recording'").get() as {id:string}).id;
 const stories=['Band recorded the album in a converted barn using a mobile studio.','Band built a tape loop from coins and cash registers to shape the rhythm.'];
 const source=repo.retainSourceDocument({entityType:'artist',entityId:artist,provider:'wikipedia',sourceUrl:'https://example.test/wiki',revisionId:'1',contentKind:'bounded-text',content:stories.join(' '),attribution:'Wikipedia'});
 repo.retainResearchClaims({entityType:'artist',entityId:artist,sourceDocumentId:source,candidates:stories.map((wording,index)=>({category:'artist-stories',topic:'story-'+index,wording,evidence:wording}))});
 const {selectExtendedSleeveNote}=await import('../src/sleeve-notes/link-selection.js');
 assert.ok(selectExtendedSleeveNote({id:'fresh',artist:'Band'}),'ordinary link selection still offers Wikipedia research');
 const {prepareSleeveNotesSegmentInDatabase,runSleeveNotesSegment}=await import('../src/sleeve-notes/segment.js');
 const {DEFAULT_SLEEVE_NOTES_SEGMENT}=await import('../src/schemas/settings.js');
 const host=settings.getOnAirRoster().host;assert.ok(host);
 const brief=prepareSleeveNotesSegmentInDatabase(db,{id:'fresh',title:'Song',artist:'Band',album:'Album'},
  {...DEFAULT_SLEEVE_NOTES_SEGMENT,enabled:true},host,[],Date.now(),true);
 assert.ok(brief);let published=false;
 assert.equal(await runSleeveNotesSegment(brief,async()=>{published=true;return true;},async()=>({air:true,reason:'A studio story.',lines:[{speaker:host.id,text:stories[0]}]})),true);
 assert.equal(published,true);
 assert.equal(db.prepare("SELECT 1 FROM sleeve_source_documents WHERE provider='genius'").get(),undefined);
});

test('re-enabling Genius retains old work and resumes requests with a configured key',async t=>{
 configure(true,'synthetic-key');encounter('enabled-track');
 assert.ok(notes.open().prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND subject_id='enabled-track'").get());
 assert.ok(notes.open().prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND subject_id='old' AND state='queued'").get());
 repo.enqueueResearchJob({provider:'genius',subjectType:'local-track',subjectId:'enabled-track',capability:'connections',priority:999});
 const network=t.mock.method(globalThis,'fetch',async(input)=>{
  assert.ok(String(input).startsWith('https://api.genius.com/'));
  return Response.json({response:{hits:[]}});
 });
 assert.equal(await new GeniusResearchWorker({isQuiet:()=>true}).runOnce(),true);
 assert.equal(network.mock.callCount(),1);
});

test('turning capture off preserves saved Genius sources and connection facts',async t=>{
 const recording=repo.localRecordingForGenius('enabled-track');assert.ok(recording);
 repo.retainGeniusResult(recording,{identity:{providerId:'77',title:'Song',artist:'Band',canonicalUrl:'https://genius.test/song'},credits:[],
  relationships:[{type:'samples',target:{providerId:'78',title:'Original Song',artist:'Earlier Band',canonicalUrl:'https://genius.test/original'}}],
  attribution:'Genius',retrievedAt:new Date().toISOString()});
 const db=notes.open();
 const sources=()=>db.prepare("SELECT * FROM sleeve_source_documents WHERE provider='genius'").all();
 const facts=()=>db.prepare("SELECT * FROM sleeve_claims WHERE source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider='genius')").all();
 const beforeSources=sources(),beforeFacts=facts();assert.ok(beforeSources.length);assert.ok(beforeFacts.length);
 configure(false,'synthetic-key');
 const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Disabled capture must not contact Genius');});
 assert.equal(await new GeniusResearchWorker({isQuiet:()=>true}).runOnce(),false);
 assert.equal(network.mock.callCount(),0);
 assert.deepEqual(sources(),beforeSources);assert.deepEqual(facts(),beforeFacts);
});

test.after(async ()=>{notes.close();store.setCache(saved);await removeTempDir(root);});
