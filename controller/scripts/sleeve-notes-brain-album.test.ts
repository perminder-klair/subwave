import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-brain-album-'));
process.env.STATE_DIR=root;process.env.ADMIN_USER='album-test';process.env.ADMIN_PASS='album-password';
const {open,close,migrate,withCachedRead,DB_PATH}=await import('../src/sleeve-notes/db.js');
const {queueBrainAlbumInDatabase,queueBrainLibraryAlbumInDatabase,brainAlbumCoverageInDatabase,finishBrainAlbumMatchesInDatabase}=await import('../src/sleeve-notes/brain-album-research.js');
const settings=await import('../src/settings.js');
const {router}=await import('../src/routes/sleeve-notes.js');
const {MusicBrainzMatchWorker}=await import('../src/sleeve-notes/musicbrainz-worker.js');
const {WikipediaWorker}=await import('../src/sleeve-notes/wikipedia-worker.js');
const {ResearchWorker,researchQueueDetails}=await import('../src/sleeve-notes/research-worker.js');
await settings.load();await settings.update({djBehaviour:{extendedSleeveNotes:true}});
const now=new Date().toISOString();
function release(db:Database.Database,id='release',group='group',title='Album'){
 db.prepare(`INSERT INTO sleeve_releases(id,title,musicbrainz_release_id,musicbrainz_release_group_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(id,title,'mb-'+id,group,now,now);
}
function source(db:Database.Database){db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES ('source','release-group','group','wikipedia','https://en.wikipedia.org/wiki/Album','hash','bounded-text',?,'Wikipedia',?)`).run('Album was recorded in a converted barn. '.repeat(30),now);}
const seed={albumId:'local-album',title:'Album',track:{id:'local-track',title:'Song',artist:'Band',album:'Album',mbid:null}};
function fixture(){const db=new Database(':memory:');migrate(db);release(db);return db;}

test('canonical release and group queue the same album job, preserve retry windows and create no plays',()=>{
 const db=fixture();assert.equal(brainAlbumCoverageInDatabase(db,'release','release').state,'unexplored');
 assert.equal(queueBrainAlbumInDatabase(db,'release','release').queued,true);
 assert.equal(queueBrainAlbumInDatabase(db,'release-group','group').queued,false);
 db.prepare("UPDATE sleeve_research_jobs SET state='retry-at',run_after='2099-01-01'").run();queueBrainAlbumInDatabase(db,'release','release');
 assert.equal((db.prepare('SELECT run_after FROM sleeve_research_jobs').get() as {run_after:string}).run_after,'2099-01-01');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_encounters').get() as {n:number}).n,0);
 assert.equal(brainAlbumCoverageInDatabase(db,'release-group','group').canQueue,false);
 assert.throws(()=>queueBrainAlbumInDatabase(db,'release','missing'),/confirmed MusicBrainz/);db.close();
});
test('manual queueing promotes an existing automatic extraction without resetting its retry window',()=>{
 const db=fixture();
 db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,priority,attempts,run_after,created_at,updated_at)
 VALUES ('automatic','researcher','release','group','extract-wikipedia-release-group','retry-at',350,2,'2099-01-01',?,?)`).run(now,now);
 assert.equal(queueBrainAlbumInDatabase(db,'release-group','group').queued,false);
 assert.deepEqual(db.prepare("SELECT operator_requested AS requested,priority,attempts,state,run_after AS next FROM sleeve_research_jobs WHERE id='automatic'").get(),
 {requested:1,priority:500,attempts:2,state:'retry-at',next:'2099-01-01'});
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_research_jobs').get() as {n:number}).n,1);db.close();
});

test('cached album rescan preserves existing facts and operator holds',()=>{
 const db=fixture();source(db);
 db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,enabled,feedback_hold,created_at,updated_at)
 VALUES ('held','release-group','group','release-stories','sessions','Album was recorded in a barn.','source','Album was recorded in a barn.',0,1,?,?)`).run(now,now);
 queueBrainAlbumInDatabase(db,'release-group','group');
 assert.equal((db.prepare('SELECT capability FROM sleeve_research_jobs').get() as {capability:string}).capability,'extract-wikipedia-release-group');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_wikipedia_rescan_requests').get() as {n:number}).n,1);
 assert.deepEqual(db.prepare("SELECT enabled,feedback_hold FROM sleeve_claims WHERE id='held'").get(),{enabled:0,feedback_hold:1});db.close();
});
test('library album matching queues its selected album even when it is not the canonical home release',async()=>{
 const db=open();queueBrainLibraryAlbumInDatabase(db,seed);
 assert.equal(queueBrainLibraryAlbumInDatabase(db,seed).queued,false);
 const lookup={lookup:async()=>({id:'recording',title:'Song',artist:{id:'artist',name:'Band'},releases:[
 {id:'earlier',releaseGroupId:'earlier-group',title:'Earlier Album',date:'1970',country:'GB',status:'Official',primaryType:'Album',artistCredit:'Band',isCompilation:false},
 {id:'selected',releaseGroupId:'selected-group',title:'Album',date:'1973',country:'GB',status:'Official',primaryType:'Album',artistCredit:'Band',isCompilation:false},
 ]})};
 assert.equal(await new MusicBrainzMatchWorker({isQuiet:()=>false},lookup).runOnce(),false);
 await new MusicBrainzMatchWorker({isQuiet:()=>true},lookup).runOnce();
 assert.ok(db.prepare("SELECT 1 FROM sleeve_research_jobs WHERE provider='wikipedia' AND subject_id='selected-group' AND operator_requested=1").get());
 assert.equal(brainAlbumCoverageInDatabase(db,'library-album','local-album').state,'queued');
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_encounters').get() as {n:number}).n,0);
 db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
});
test('canonical-home automatic lookup is promoted when a manual library album match finishes',async()=>{
 const db=open();const selected={albumId:'canonical-album',title:'Canonical Album',track:{id:'canonical-local',title:'Canonical Song',artist:'Band',album:'Canonical Album',mbid:null}};
 queueBrainLibraryAlbumInDatabase(db,selected);
 const lookup={lookup:async()=>({id:'canonical-recording',title:'Canonical Song',artist:{id:'artist',name:'Band'},releases:[
 {id:'canonical-release',releaseGroupId:'canonical-group',title:'Canonical Album',date:'1973',country:'GB',status:'Official',primaryType:'Album',artistCredit:'Band',isCompilation:false}]})};
 await new MusicBrainzMatchWorker({isQuiet:()=>true},lookup).runOnce();
 assert.deepEqual(db.prepare("SELECT operator_requested AS requested,priority FROM sleeve_research_jobs WHERE provider='wikipedia' AND subject_id='canonical-group'").get(),{requested:1,priority:500});
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_encounters').get() as {n:number}).n,0);
 db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
});

test('failed identity does not substitute a different album and can be retried',()=>{
 const db=fixture();queueBrainLibraryAlbumInDatabase(db,seed);finishBrainAlbumMatchesInDatabase(db,seed.track.id,false);
 const coverage=brainAlbumCoverageInDatabase(db,'library-album',seed.albumId);
 assert.equal(coverage.state,'incomplete');assert.match(coverage.error??'',/No different album/);
 assert.equal(queueBrainLibraryAlbumInDatabase(db,seed).queued,true);db.close();
});
test('verified album lookup uses its own tracks and rejects mismatched album identities',async t=>{
 const db=open();db.prepare(`INSERT INTO sleeve_brain_layers(entity_type,entity_id,graph_json) VALUES ('library-album','verify',?)`).run(JSON.stringify({nodes:[{entityType:'library-album',entityId:'verify',title:'Verified Album'}]}));
 let wrong=false;
 t.mock.method(globalThis,'fetch',async()=>Response.json({'subsonic-response':{status:'ok',album:{id:wrong?'different':'verify',name:'Verified Album',artist:'Band',song:[{id:'verify-track',title:'Verified Song',artist:'Band',albumId:'verify'}]}}}));
 const {brainLibraryAlbumResearchSeed}=await import('../src/sleeve-notes/brain-library.js');
 assert.equal((await brainLibraryAlbumResearchSeed('verify')).track.id,'verify-track');
 wrong=true;await assert.rejects(brainLibraryAlbumResearchSeed('verify'),/identity changed|malformed album/);
});
test('first-time explicit album source lookup reaches extraction without waiting for playback',async()=>{
 const db=open();db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();release(db,'new-release','new-group','Unplayed Album');
 queueBrainAlbumInDatabase(db,'release-group','new-group');
 await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>null,fetchWikipediaReleaseGroupDocument:async()=>({title:'Unplayed Album',url:'https://en.wikipedia.org/wiki/Unplayed_Album',revisionId:'1',text:'Unplayed Album was recorded in a converted barn. '.repeat(30),attribution:'Wikipedia',retrievedAt:now,sourceFormatVersion:1})}).runOnce();
 const job=db.prepare("SELECT id,operator_requested AS requested FROM sleeve_research_jobs WHERE provider='researcher' AND subject_id='new-group'").get() as {id:string;requested:number};
 assert.equal(job.requested,1);assert.equal(researchQueueDetails(new Date(),false).find(row=>row.id===job.id)?.phase,'ready');
 let first=true;
 const researcher={extract:async()=>[],extractWikipediaSparks:async()=>{if(first){first=false;throw new Error('Temporary extraction failure');}return {claims:[],rawResponse:''};}};
 assert.equal(await new ResearchWorker({isQuiet:()=>false},researcher).runOnce(),false);
 assert.equal(await new ResearchWorker({isQuiet:()=>true,isEmptyMaintenanceAllowed:()=>false},researcher).runOnce(),true);
 assert.equal((db.prepare('SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id=?').get(job.id) as {requested:number}).requested,1);
 db.prepare('UPDATE sleeve_research_jobs SET run_after=NULL WHERE id=?').run(job.id);
 db.prepare('DELETE FROM sleeve_research_pacing').run();
 assert.equal(await new ResearchWorker({isQuiet:()=>true,isEmptyMaintenanceAllowed:()=>false},researcher).runOnce(),true);
 assert.equal((db.prepare('SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id=?').get(job.id) as {requested:number}).requested,0);
});
test('explicit fallback handoff restarts completed work but preserves an active retry window',async()=>{
 const {enqueueResearchJob,forwardOperatorResearchRequest}=await import('../src/sleeve-notes/research-repository.js');
 const db=open();
 enqueueResearchJob({provider:'wikipedia',subjectType:'release',subjectId:'fallback-group',capability:'release-group-biography',priority:500});
 enqueueResearchJob({provider:'genius',subjectType:'release',subjectId:'fallback-group',capability:'album-biography',priority:100});
 const parent=db.prepare("SELECT id FROM sleeve_research_jobs WHERE provider='wikipedia' AND subject_id='fallback-group'").get() as {id:string};
 const job={...parent,provider:'wikipedia',subjectType:'release' as const,subjectId:'fallback-group',capability:'release-group-biography',priority:500,attempts:0,originLocalTrackId:null};
 db.prepare("UPDATE sleeve_research_jobs SET operator_requested=1 WHERE id=?").run(parent.id);
 db.prepare("UPDATE sleeve_research_jobs SET state='complete' WHERE provider='genius' AND subject_id='fallback-group'").run();
 forwardOperatorResearchRequest(job,'genius','album-biography');
 assert.deepEqual(db.prepare("SELECT state,operator_requested AS requested,priority FROM sleeve_research_jobs WHERE provider='genius' AND subject_id='fallback-group'").get(),{state:'queued',requested:1,priority:500});
 db.prepare("UPDATE sleeve_research_jobs SET operator_requested=1 WHERE id=?").run(parent.id);
 db.prepare("UPDATE sleeve_research_jobs SET state='retry-at',run_after='2099-01-01' WHERE provider='genius' AND subject_id='fallback-group'").run();
 forwardOperatorResearchRequest(job,'genius','album-biography');
 assert.equal((db.prepare("SELECT run_after AS next FROM sleeve_research_jobs WHERE provider='genius' AND subject_id='fallback-group'").get() as {next:string}).next,'2099-01-01');
});
const app=express();app.use(express.json(),router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address();if(!address||typeof address==='string')throw new Error('Missing address');
const base=`http://127.0.0.1:${address.port}/sleeve-notes/connections`,auth=`Basic ${Buffer.from('album-test:album-password').toString('base64')}`;
test('album API requires admin access, blocks disabled writes and permits read-only cached coverage',async()=>{
 const post=(headers:Record<string,string>={Authorization:auth})=>fetch(`${base}/research`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({entityType:'release-group',entityId:'new-group'})});
 assert.equal((await post({})).status,401);assert.equal((await post()).status,200);
 await settings.update({djBehaviour:{extendedSleeveNotes:false}});assert.equal((await post()).status,409);
 open().pragma('user_version=48');close();const before=readFileSync(DB_PATH);
 const response=await fetch(`${base}/album-coverage?entityType=release-group&entityId=new-group`,{headers:{Authorization:auth}});
 assert.equal(response.status,200);assert.deepEqual(readFileSync(DB_PATH),before);
 assert.equal(withCachedRead(()=>open().pragma('user_version',{simple:true})),48);
});
test.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));close();await removeTempDir(root);});
