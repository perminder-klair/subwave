import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test,{beforeEach,after} from 'node:test';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=createTempDir(join(tmpdir(),'subwave-wiki-retention-'));process.env.STATE_DIR=root;
delete process.env.ADMIN_USER;delete process.env.ADMIN_PASS;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const notes=await import('../src/sleeve-notes/db.js');
const repo=await import('../src/sleeve-notes/research-repository.js');
const {pruneCompletedWikipediaArticlesInDatabase:prune,compactWikipediaEvidence}=await import('../src/sleeve-notes/wikipedia-retention.js');
await settings.load();await settings.update({djBehaviour:{extendedSleeveNotes:true,sleeveNotesCollectionPaused:false}});
const saved=settings.get();
const old=new Date(Date.now()-2*24*60*60_000).toISOString();
const evidence='The following month, the band announced a festival appearance.';
const article='<!-- subwave-wikipedia-source-format:2 -->\n'+('Unrelated background. '.repeat(300))
 +'\n\nIn January 2010, the band announced a tour. '+evidence+'\n\n'+('Unrelated later history. '.repeat(300));
const input={entityType:'artist' as const,entityId:'artist',provider:'wikipedia',sourceUrl:'https://example.test/wiki',revisionId:'1',contentKind:'bounded-text' as const,content:article,attribution:'Wikipedia contributors'};
function fixture() {
 const db=notes.open();
 db.prepare("INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES ('artist','Band','mb-artist',?,?)").run(old,old);
 const source=repo.retainSourceDocument(input);
 db.prepare('UPDATE sleeve_source_documents SET retrieved_at=? WHERE id=?').run(old,source);
 db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,operator_state,created_at,updated_at)
  VALUES ('claim','artist','artist','artist-stories','touring','In February 2010, the band announced a festival appearance.',?,?,'approved',?,?)`).run(source,evidence,old,old);
 db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at,completed_at)
  VALUES ('job','researcher','artist','artist','extract-wikipedia','complete',?,?,?)`).run(old,old,old);
 db.prepare(`INSERT INTO sleeve_wikipedia_scan_progress(job_id,source_document_id,chunk_count,next_chunk,updated_at)
  VALUES ('job',?,1,1,?)`).run(source,old);
 return {db,source};
}
beforeEach(()=>{
 notes.close();for(const suffix of ['','-wal','-shm'])rmSync(notes.DB_PATH+suffix,{force:true});
 store.setCache(saved);
});
after(async ()=>{notes.close();store.setCache(null);await removeTempDir(root);});

test('completed old article becomes evidence with context while corrections, identity and source hash remain unchanged',async()=>{
 const {db,source}=fixture();
 const claims=db.prepare('SELECT * FROM sleeve_claims').all();
 const hash=(db.prepare('SELECT content_hash AS hash FROM sleeve_source_documents').get() as {hash:string}).hash;
 assert.equal(prune(db),1);
 const retained=repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!;
 assert.ok(retained.wikipediaPrunedAt);assert.ok(retained.content.length<article.length/2);
 assert.match(retained.content,/In January 2010/);assert.ok(retained.content.includes(evidence));
 assert.equal((db.prepare('SELECT content_hash AS hash FROM sleeve_source_documents').get() as {hash:string}).hash,hash);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_claims').all(),claims);
 const {flagStoredClaim,listAiringReviews}=await import('../src/sleeve-notes/airing-review.js');
 const flag=flagStoredClaim('claim');
 const context=listAiringReviews().items.find(item=>item.id===flag.id)!.context.sparks[0];
 assert.match(context.sourceText,/January 2010/);assert.ok(context.sourceText.includes(evidence));
 const {moderateExistingClaim}=await import('../src/sleeve-notes/moderation.js');
 moderateExistingClaim('claim','approved',{category:'artist-stories',topic:'touring',wording:'In February 2010, the band confirmed a festival appearance.',evidence,shortWording:''});
 assert.equal((db.prepare('SELECT source_document_id AS source FROM sleeve_claims').get() as {source:string}).source,source);
 assert.equal(prune(db),0,'pruning is idempotent');
});

test('newly completed, incomplete, failed, paused and disabled research retain the whole article',()=>{
 const {db}=fixture();
 db.prepare('UPDATE sleeve_research_jobs SET completed_at=?').run(new Date().toISOString());assert.equal(prune(db),0);
 db.prepare('UPDATE sleeve_research_jobs SET completed_at=?').run(old);
 db.prepare('UPDATE sleeve_wikipedia_scan_progress SET next_chunk=0').run();assert.equal(prune(db),0);
 db.prepare('UPDATE sleeve_wikipedia_scan_progress SET next_chunk=1').run();
 for(const state of ['queued','retry-at','running','failed']) {
  db.prepare('UPDATE sleeve_research_jobs SET state=?').run(state);assert.equal(prune(db),0);
 }
 db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,sleeveNotesCollectionPaused:true}});assert.equal(prune(db),0);
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:false}});assert.equal(prune(db),0);
 assert.equal(repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!.content,article);
});

test('pending reviews protect the full source; malformed citations are never discarded',async()=>{
 const {db}=fixture();
 const {flagStoredClaim}=await import('../src/sleeve-notes/airing-review.js');const flag=flagStoredClaim('claim');
 assert.equal(prune(db),0);
 db.prepare("UPDATE sleeve_airing_reviews SET state='dismissed' WHERE id=?").run(flag.id);
 db.prepare("UPDATE sleeve_claims SET evidence='An exact passage absent from this source.'").run();assert.equal(prune(db),0);
 assert.equal(compactWikipediaEvidence(article,['A missing supporting passage.']),null);
 db.prepare('UPDATE sleeve_claims SET evidence=?').run(evidence);
 assert.equal(prune(db),1);
});

test('pending moderation and a refresh plan retain the complete article until resolved',()=>{
 const {db,source}=fixture();
 db.prepare(`INSERT INTO sleeve_moderation_candidates(id,source_document_id,fingerprint,entity_type,entity_id,category,topic,wording,evidence,original_json,rejection_reason,created_at,updated_at)
  VALUES ('candidate',?,'fingerprint','artist','artist','artist-stories','touring','A saved proposed story.',?,'{}','wording',?,?)`).run(source,evidence,old,old);
 assert.equal(prune(db),0);
 db.prepare("UPDATE sleeve_moderation_candidates SET status='retained'").run();
 db.prepare("INSERT INTO sleeve_wikipedia_refresh_plan(id,requested_at) VALUES (1,?)").run(new Date().toISOString());
 assert.equal(prune(db),0);
 db.prepare('UPDATE sleeve_research_jobs SET wikipedia_refreshed_at=?').run(new Date().toISOString());
 assert.equal(prune(db),1,'a completed entity can be cleaned while the wider refresh plan still has work');
});

test('rehydrating an unchanged revision reuses its source, resets scan progress and never duplicates NULL-revision sources',()=>{
 const {db,source}=fixture();assert.equal(prune(db),1);
 assert.equal(repo.retainSourceDocument(input),source);
 assert.equal(repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!.content,article);
 assert.equal(repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!.wikipediaPrunedAt,null);
 assert.equal(db.prepare('SELECT 1 FROM sleeve_wikipedia_scan_progress').get(),undefined);
 const series={...input,provider:'musicbrainz-series',revisionId:null,content:'A fixed Series membership reference.'};
 const first=repo.retainSourceDocument(series);
 for(let i=0;i<5;i++)assert.equal(repo.retainSourceDocument(series),first);
 assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_source_documents WHERE provider='musicbrainz-series'").get() as {n:number}).n,1);
});

test('refresh of cleared text schedules the paced source worker without an LLM call, then rehydrates the original source',async()=>{
 const {db,source}=fixture();assert.equal(prune(db),1);
 db.prepare("UPDATE sleeve_research_jobs SET state='queued',attempts=2,operator_requested=1,wikipedia_refresh_mode='replace'").run();
 const {ResearchWorker}=await import('../src/sleeve-notes/research-worker.js');
 let generations=0;
 const worker=new ResearchWorker({isQuiet:()=>true},{extract:async()=>{generations++;return [];},extractWikipediaSparks:async()=>{generations++;return {claims:[],rawResponse:''};}});
 assert.equal(await worker.runOnce(),true);assert.equal(generations,0);
 assert.deepEqual(db.prepare("SELECT state,attempts,wikipedia_refresh_mode AS mode FROM sleeve_research_jobs WHERE id='job'").get(),{state:'retry-at',attempts:2,mode:'replace'});
 const {WikipediaWorker}=await import('../src/sleeve-notes/wikipedia-worker.js');let fetched=0;
 const sources={fetchWikipediaArtistDocument:async()=>{fetched++;return {title:'Band',url:input.sourceUrl,revisionId:'1',retrievedAt:new Date().toISOString(),text:article,attribution:input.attribution,sourceFormatVersion:2};},fetchWikipediaReleaseGroupDocument:async()=>null};
 assert.equal(await new WikipediaWorker({isQuiet:()=>true},sources).runOnce(),true);assert.equal(fetched,1);
 const restored=repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!;
 assert.equal(restored.id,source);assert.equal(restored.content,article);assert.equal(restored.wikipediaPrunedAt,null);
 assert.equal((db.prepare("SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id='job'").get() as {requested:number}).requested,1);
 db.prepare("UPDATE sleeve_research_jobs SET run_after=NULL WHERE id='job'").run();
 let sawFullArticle=false;
 const resumed=new ResearchWorker({isQuiet:()=>true},{extract:async()=>{throw new Error('Expected the Wikipedia extractor');},
  extractWikipediaSparks:async job=>{sawFullArticle ||= job.document.text.includes('Unrelated background.');return {claims:[],rawResponse:''};}});
 for(let section=0;section<4;section++) {
  db.prepare("UPDATE sleeve_research_jobs SET run_after=NULL WHERE id='job'").run();
  db.prepare('DELETE FROM sleeve_research_pacing').run();
  assert.equal(await resumed.runOnce(),true);
  if((db.prepare("SELECT state FROM sleeve_research_jobs WHERE id='job'").get() as {state:string}).state==='complete')break;
 }
 assert.equal(sawFullArticle,true);
 assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE id='job'").get() as {state:string}).state,'complete');
 assert.ok((db.prepare('SELECT wikipedia_completed_at AS at FROM sleeve_source_documents WHERE id=?').get(source) as {at:string|null}).at,'the worker records source completion independently of the job checkpoint');
 assert.equal(prune(db),0,'a newly completed refresh gets its own 24-hour preview window');
});

test('cold reopen keeps article text and operator facts intact',async()=>{
 const {db,source}=fixture();
 const before=db.prepare('SELECT wording,evidence,operator_state FROM sleeve_claims').all();
 notes.close();
 const Database=(await import('better-sqlite3')).default;
 const reopened=new Database(notes.DB_PATH);
 try {
  notes.migrate(reopened);notes.migrate(reopened);
  assert.equal(reopened.pragma('user_version',{simple:true}),notes.SCHEMA_VERSION);
  assert.deepEqual(reopened.prepare('SELECT wording,evidence,operator_state FROM sleeve_claims').all(),before);
  assert.deepEqual(reopened.prepare('SELECT content,wikipedia_pruned_at AS prunedAt FROM sleeve_source_documents WHERE id=?').get(source),{content:article,prunedAt:null});
 } finally {reopened.close();}
});

test('maintenance batches are capped and never prune another provider',()=>{
 const {db}=fixture();
 const other=repo.retainSourceDocument({...input,provider:'other'});
 for(let i=0;i<14;i++) {
  const id='other-'+i,source=repo.retainSourceDocument({...input,entityId:id});
  db.prepare('UPDATE sleeve_source_documents SET retrieved_at=? WHERE id=?').run(old,source);
  db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at,completed_at)
   VALUES (?,'researcher','artist',?,'extract-wikipedia','complete',?,?,?)`).run(id,id,old,old,old);
  db.prepare(`INSERT INTO sleeve_wikipedia_scan_progress(job_id,source_document_id,chunk_count,next_chunk,updated_at)
   VALUES (?,?,1,1,?)`).run(id,source,old);
 }
 assert.equal(prune(db,100),10);assert.equal(prune(db,100),5);assert.equal(prune(db),0);
 assert.equal((db.prepare('SELECT content FROM sleeve_source_documents WHERE id=?').get(other) as {content:string}).content,article);
});

test('a missing article body produces a clear preview response without contacting a provider',async t=>{
 const {db}=fixture();assert.equal(prune(db),1);
 const express=(await import('express')).default;
 const {router}=await import('../src/routes/sleeve-notes.js');
 const {listen}=await import('./test-utils/http.js');const app=express();app.use(express.json(),router);
 const {server,url}=await listen(app);const fetcher=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  if(!String(input).startsWith(url))throw new Error('Unexpected provider request');
  return fetcher(input,init);
 });
 try {
  const response=await fetch(url+'/sleeve-notes/wikipedia-prompt-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entityType:'artist',entityId:'artist',prompt:'Find stories.'})});
  assert.equal(response.status,409);assert.match((await response.json() as {error:string}).error,/cleared after research/);
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('a completed source stays eligible when a refresh replaces its checkpoint',()=>{
 const {db,source}=fixture();
 db.prepare('UPDATE sleeve_source_documents SET wikipedia_completed_at=? WHERE id=?').run(old,source);
 const replacement=repo.retainSourceDocument({...input,revisionId:'2',content:article+' A new paragraph.'});
 db.prepare("UPDATE sleeve_wikipedia_scan_progress SET source_document_id=? WHERE job_id='job'").run(replacement);
 const facts=db.prepare('SELECT * FROM sleeve_claims').all();
 assert.equal(prune(db,10,source),1);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_claims').all(),facts);
 assert.ok((db.prepare('SELECT wikipedia_pruned_at AS at FROM sleeve_source_documents WHERE id=?').get(source) as {at:string}).at);
 assert.equal((db.prepare('SELECT wikipedia_pruned_at AS at FROM sleeve_source_documents WHERE id=?').get(replacement) as {at:string|null}).at,null);
 assert.equal(repo.retainSourceDocument(input),source);
 assert.equal((db.prepare('SELECT wikipedia_completed_at AS at FROM sleeve_source_documents WHERE id=?').get(source) as {at:string|null}).at,null,'refetch requires a fresh successful scan');
});

test('maintenance does not invent completion for an unfinished or orphaned article',()=>{
 const {db,source}=fixture();
 db.prepare('UPDATE sleeve_wikipedia_scan_progress SET next_chunk=0').run();
 notes.migrate(db);
 assert.equal((db.prepare('SELECT wikipedia_completed_at AS at FROM sleeve_source_documents WHERE id=?').get(source) as {at:string|null}).at,null);
 db.prepare('DELETE FROM sleeve_wikipedia_scan_progress').run();
 notes.migrate(db);
 assert.equal(prune(db,10,source),0);
 assert.equal(repo.latestSourceDocumentForResearch('artist','artist','wikipedia')!.content,article);
});
