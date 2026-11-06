import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate,open,close,SCHEMA_VERSION } from '../src/sleeve-notes/db.js';
import { researchOverrideSchema } from '../src/schemas/sleeve-notes-corrections.js';
import { saveResearchOverride,researchOverride,queueArtistRescan,startLibraryVerification,cancelLibraryVerification,verificationReadout } from '../src/sleeve-notes/research-corrections.js';
import { researchGapsInDatabase } from '../src/sleeve-notes/research-gaps.js';
import { WikipediaWorker } from '../src/sleeve-notes/wikipedia-worker.js';
import * as settings from '../src/settings.js';
const mbid='11111111-2222-3333-4444-555555555555',article='https://en.wikipedia.org/wiki/Example_Artist',now='2026-10-25T12:00:00.000Z';
function seed(db:Database.Database,id='a',identity:string|null=mbid) {
  db.prepare('INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'Example Artist',identity,now,now);
  db.prepare("INSERT OR IGNORE INTO sleeve_connection_library_artists(local_artist_id,name,name_key) VALUES('local','Example Artist','example artist')").run();
}
function source(db:Database.Database) {
  db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
    VALUES('source','artist','a','wikipedia',?,'hash','bounded-text','Evidence of an album.','Wikipedia',?)`).run(article,now);
  for (const state of ['auto','approved','deleted']) db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,evidence,source_document_id,operator_state,created_at,updated_at)
    VALUES(?,'artist','a','artist-stories',?,'A story','Evidence','source',?,?,?)`).run(state,state,state,now,now);
}

test('validates artist links and rejects arbitrary hosts, namespaces, encoded controls and malformed ids',()=>{
  assert.equal(researchOverrideSchema.parse({musicBrainzId:`https://musicbrainz.org/artist/${mbid}/`,wikipediaUrl:article}).musicBrainzId,mbid);
  for (const wikipediaUrl of ['http://en.wikipedia.org/wiki/Example','https://example.org/wiki/Example','https://en.wikipedia.org/wiki/Special:Random','https://en.wikipedia.org/wiki/Example#History','https://en.wikipedia.org/wiki/%0AArtist','https://en.wikipedia.org/wiki/A%7CB','https://en.wikipedia.org@localhost/wiki/Example']) assert.equal(researchOverrideSchema.safeParse({musicBrainzId:'',wikipediaUrl}).success,false,wikipediaUrl);
  assert.equal(researchOverrideSchema.safeParse({musicBrainzId:'bad',wikipediaUrl:''}).success,false);
});
test('schema 3 upgrades additively without changing saved decisions',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);source(db);
  db.exec('DROP TABLE sleeve_artist_research_overrides; DROP TABLE sleeve_artist_verification; DROP TABLE sleeve_library_verification');db.pragma('user_version=3');
  const before=db.prepare('SELECT * FROM sleeve_claims').all();migrate(db);migrate(db);
  assert.equal(db.pragma('user_version',{simple:true}),SCHEMA_VERSION);assert.deepEqual(db.prepare('SELECT * FROM sleeve_claims').all(),before);assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
});
test('corrections preserve canonical identity and approved facts, queue collection and supersede old sources even after removal',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);source(db);
  saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:'https://en.wikipedia.org/wiki/Correct_Artist'});
  assert.equal(researchOverride(db,'a')?.wikipediaUrl,'https://en.wikipedia.org/wiki/Correct_Artist');
  assert.equal((db.prepare("SELECT musicbrainz_id AS id FROM sleeve_artists WHERE id='a'").get() as {id:string}).id,mbid);
  assert.deepEqual(db.prepare('SELECT operator_state AS state,enabled FROM sleeve_claims ORDER BY operator_state').all(),[{state:'approved',enabled:1},{state:'auto',enabled:0},{state:'deleted',enabled:1}]);
  assert.equal(researchGapsInDatabase(db).items[0]?.identities[0]?.articleUrl,null);
  saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:''});assert.equal(researchOverride(db,'a'),null);
  assert.equal(researchGapsInDatabase(db).items[0]?.identities[0]?.articleUrl,null);assert.equal((db.prepare('SELECT COUNT(*) n FROM sleeve_source_documents').get() as {n:number}).n,1);db.close();
});
test('running extraction blocks edits atomically; repeated rescans replace progress without duplicate jobs',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);source(db);
  db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at) VALUES('extract','researcher','artist','a','extract-wikipedia','running',?,?)`).run(now,now);
  assert.throws(()=>saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article}),/running/);assert.equal(researchOverride(db,'a'),null);
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='auto'").get() as {enabled:number}).enabled,1);
  db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();queueArtistRescan(db,'a');queueArtistRescan(db,'a');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sleeve_research_jobs WHERE provider='wikipedia'").get() as {n:number}).n,1);
  assert.equal(db.prepare("SELECT 1 FROM sleeve_wikipedia_rescan_requests WHERE job_id='extract'").get(),undefined,'old extraction cannot resume before fresh collection');db.close();
});
const document={title:'Example Artist',url:article,revisionId:'123',retrievedAt:now,text:'A biography with evidence.',attribution:'Wikipedia',sourceFormatVersion:2};
async function withWorker(run:(db:Database.Database)=>Promise<void>) {
  await settings.load();await settings.update({djBehaviour:{extendedSleeveNotes:true,sleeveNotesCollectionPaused:false}});
  const db=open();db.exec('DELETE FROM sleeve_artist_verification; DELETE FROM sleeve_library_verification; DELETE FROM sleeve_artist_research_overrides; DELETE FROM sleeve_research_jobs; DELETE FROM sleeve_artists; DELETE FROM sleeve_connection_library_artists; DELETE FROM sleeve_source_documents');seed(db);
  try {await run(db);}finally{close();}
}
test('library scan checks known identities, survives reopen, and never retains articles or queues LLM work',async()=>withWorker(async db=>{
  db.prepare("INSERT INTO sleeve_connection_library_artists(local_artist_id,name,name_key) VALUES('unplayed','Unplayed Artist','unplayed artist')").run();
  const scan=startLibraryVerification(db,researchGapsInDatabase(db));assert.equal(scan.total,1);assert.equal(scan.skipped,1);assert.throws(()=>startLibraryVerification(db,researchGapsInDatabase(db)),/already/);
  close();const reopened=open();assert.equal(verificationReadout(reopened).state,'running');
  const worker=new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>document,fetchWikipediaReleaseGroupDocument:async()=>null});
  assert.equal(await worker.runOnce(),true);assert.equal(verificationReadout(reopened).found,1);assert.equal(verificationReadout(reopened).state,'complete');
  assert.equal((reopened.prepare('SELECT COUNT(*) n FROM sleeve_source_documents').get() as {n:number}).n,0);assert.equal((reopened.prepare('SELECT COUNT(*) n FROM sleeve_research_jobs').get() as {n:number}).n,0);
}));
test('verification obeys quiet, feature, pause gates and one-minute cadence',async()=>withWorker(async db=>{
  seed(db,'b','22222222-2222-3333-4444-555555555555');startLibraryVerification(db,researchGapsInDatabase(db));let calls=0,quiet=false;
  const worker=new WikipediaWorker({isQuiet:()=>quiet},{fetchWikipediaArtistDocument:async()=>{calls++;return null;},fetchWikipediaReleaseGroupDocument:async()=>null});
  assert.equal(await worker.runOnce(),false);quiet=true;await settings.update({djBehaviour:{sleeveNotesCollectionPaused:true}});assert.equal(await worker.runOnce(),false);
  await settings.update({djBehaviour:{sleeveNotesCollectionPaused:false,extendedSleeveNotes:false}});assert.equal(await worker.runOnce(),false);
  await settings.update({djBehaviour:{extendedSleeveNotes:true}});await worker.runOnce();await worker.runOnce();assert.equal(calls,1);assert.equal(verificationReadout(db).missing,1);assert.equal(researchGapsInDatabase(db).items[0]?.status,'source-missing');
}));
test('cancellation rejects late in-flight results',async()=>withWorker(async db=>{
  startLibraryVerification(db,researchGapsInDatabase(db));let finish!:(value:typeof document)=>void;
  const pending=new Promise<typeof document>(resolve=>{finish=resolve;});const worker=new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:()=>pending,fetchWikipediaReleaseGroupDocument:async()=>null});
  const running=worker.runOnce();await new Promise(resolve=>setImmediate(resolve));cancelLibraryVerification(db);finish(document);await running;
  assert.equal(verificationReadout(db).state,'cancelled');assert.equal(verificationReadout(db).found,0);
}));
test('source outage defers the whole scan without falsely reporting missing biographies',async()=>withWorker(async db=>{
  seed(db,'b','22222222-2222-3333-4444-555555555555');startLibraryVerification(db,researchGapsInDatabase(db));
  const worker=new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>{throw new Error('HTTP 429');},fetchWikipediaReleaseGroupDocument:async()=>null});
  await worker.runOnce();assert.equal(verificationReadout(db).missing,0);assert.equal(verificationReadout(db).checked,0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sleeve_artist_verification WHERE run_after>?').get(new Date().toISOString()) as {n:number}).n,2);
}));
test('artist rescan uses the override and forwards operator intent to extraction',async()=>withWorker(async db=>{
  saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article});let used:string|undefined;
  const worker=new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async(_id,url)=>{used=url;return document;},fetchWikipediaReleaseGroupDocument:async()=>null});
  await worker.runOnce();assert.equal(used,article);assert.equal((db.prepare("SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE provider='researcher'").get() as {requested:number}).requested,1);
  assert.equal((db.prepare('SELECT source_url AS url FROM sleeve_source_documents').get() as {url:string}).url,article);
}));

test('an in-flight scan cannot publish against a changed override',async()=>withWorker(async db=>{
  startLibraryVerification(db,researchGapsInDatabase(db));let finish!:(value:typeof document)=>void;
  const pending=new Promise<typeof document>(resolve=>{finish=resolve;});const worker=new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:()=>pending,fetchWikipediaReleaseGroupDocument:async()=>null});
  const running=worker.runOnce();await new Promise(resolve=>setImmediate(resolve));saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article});finish(document);await running;
  assert.equal(verificationReadout(db).found,0);assert.equal(researchGapsInDatabase(db).items[0]?.identities[0]?.verification,null);
}));
test('old feature-off caches remain readable without adding correction tables',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);source(db);
  db.exec('DROP TABLE sleeve_artist_research_overrides; DROP TABLE sleeve_artist_verification; DROP TABLE sleeve_library_verification');db.pragma('user_version=3');
  const before=db.prepare('SELECT total_changes() AS n').get();
  assert.equal(researchGapsInDatabase(db).items.length,1);assert.equal(verificationReadout(db).state,'idle');
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(),before);assert.equal(db.pragma('user_version',{simple:true}),3);db.close();
});
test('retrying a queued rescan preserves its provider backoff and single job',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);queueArtistRescan(db,'a');const after='2099-01-01T00:00:00.000Z';
  db.prepare("UPDATE sleeve_research_jobs SET state='retry-at',run_after=?").run(after);queueArtistRescan(db,'a');
  assert.equal((db.prepare('SELECT run_after AS at FROM sleeve_research_jobs').get() as {at:string}).at,after);
  saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article});assert.equal((db.prepare('SELECT run_after AS at FROM sleeve_research_jobs').get() as {at:string}).at,after);db.close();
});

test('repeated service failures finish as failed checks, not missing biographies',async()=>withWorker(async db=>{
  startLibraryVerification(db,researchGapsInDatabase(db));
  for(let attempt=0;attempt<3;attempt++) {
    db.prepare('UPDATE sleeve_library_verification SET last_step_at=NULL,next_step_at=NULL').run();db.prepare('UPDATE sleeve_artist_verification SET run_after=NULL').run();
    await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>{throw new Error('HTTP 503');},fetchWikipediaReleaseGroupDocument:async()=>null}).runOnce();
  }
  assert.equal(verificationReadout(db).state,'complete');assert.equal(verificationReadout(db).failed,1);assert.equal(verificationReadout(db).missing,0);
  assert.equal(researchGapsInDatabase(db).items[0]?.status,'source-error');
  cancelLibraryVerification(db);assert.equal(verificationReadout(db).state,'complete');
}));
test('pacing survives a worker restart and source corrections do not reset a service outage',async()=>withWorker(async db=>{
  seed(db,'b','22222222-2222-3333-4444-555555555555');startLibraryVerification(db,researchGapsInDatabase(db));let calls=0;
  const sources={fetchWikipediaArtistDocument:async()=>{calls++;return document;},fetchWikipediaReleaseGroupDocument:async()=>null};
  await new WikipediaWorker({isQuiet:()=>true},sources).runOnce();await new WikipediaWorker({isQuiet:()=>true},sources).runOnce();assert.equal(calls,1);
}));
test('a reachable source is actionable without claiming it has already been researched',async()=>withWorker(async db=>{
  startLibraryVerification(db,researchGapsInDatabase(db));await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>document,fetchWikipediaReleaseGroupDocument:async()=>null}).runOnce();
  assert.equal(researchGapsInDatabase(db).items[0]?.status,'source-available');
}));

test('fresh successful collection clears an older missing-source finding',async()=>withWorker(async db=>{
  startLibraryVerification(db,researchGapsInDatabase(db));await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>null,fetchWikipediaReleaseGroupDocument:async()=>null}).runOnce();
  assert.equal(researchGapsInDatabase(db).items[0]?.status,'source-missing');
  db.prepare('UPDATE sleeve_artist_verification SET checked_at=?').run(now);
  queueArtistRescan(db,'a');await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async()=>document,fetchWikipediaReleaseGroupDocument:async()=>null}).runOnce();
  db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
  assert.equal(researchGapsInDatabase(db).counts.attention,0);
}));

test('an explicit Wikipedia source works without a MusicBrainz match and remains queueable in Station Brain',async()=>withWorker(async db=>{
  db.prepare("UPDATE sleeve_artists SET musicbrainz_id=NULL WHERE id='a'").run();saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article});
  await new WikipediaWorker({isQuiet:()=>true},{fetchWikipediaArtistDocument:async(_id,url)=>{assert.equal(url,article);return document;},fetchWikipediaReleaseGroupDocument:async()=>null}).runOnce();
  db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
  const {brainCoverageInDatabase,queueBrainArtistInDatabase}=await import('../src/sleeve-notes/brain-coverage.js');
  assert.equal(brainCoverageInDatabase(db)['artist:a']?.canQueue,true);assert.equal(queueBrainArtistInDatabase(db,'a').queued,true);
}));

test('a stale snapshot cannot admit orphan identities after a database replacement',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);const snapshot=researchGapsInDatabase(db);
  db.prepare('DELETE FROM sleeve_artists').run();const result=startLibraryVerification(db,snapshot);assert.equal(result.total,0);assert.equal(result.skipped,1);assert.equal(result.state,'complete');db.close();
});

test('an override can be removed even when no automatic MusicBrainz identity exists',()=>{
  const db=new Database(':memory:');migrate(db);seed(db,'a',null);saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:article});
  assert.deepEqual(saveResearchOverride(db,'a',{musicBrainzId:'',wikipediaUrl:''}),{queued:false});assert.equal(researchOverride(db,'a'),null);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sleeve_research_jobs WHERE state IN ('queued','retry-at')").get() as {n:number}).n,0);db.close();
});

test('rescan marks an already queued automatic lookup as explicit without bypassing backoff',()=>{
  const db=new Database(':memory:');migrate(db);seed(db);queueArtistRescan(db,'a');
  db.prepare("UPDATE sleeve_research_jobs SET operator_requested=0,state='retry-at',run_after='2099-01-01'").run();queueArtistRescan(db,'a');
  assert.deepEqual(db.prepare('SELECT operator_requested AS requested,run_after AS after FROM sleeve_research_jobs').get(),{requested:1,after:'2099-01-01'});db.close();
});
