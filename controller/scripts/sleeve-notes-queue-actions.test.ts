import assert from 'node:assert/strict';
import test,{beforeEach,after} from 'node:test';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
import {removeTempDir, createTempDir} from './test-utils/temp-dir.js';
const root=createTempDir(join(tmpdir(),'subwave-queue-actions-'));process.env.STATE_DIR=root;
process.env.ADMIN_USER='operator';process.env.ADMIN_PASS='test-secret';
const notes=await import('../src/sleeve-notes/db.js');
const settings=await import('../src/settings.js');
const {manageQueuedJob,queuePromotion}=await import('../src/sleeve-notes/queue-actions.js');
const repo=await import('../src/sleeve-notes/research-repository.js');
const {nextAiringReview}=await import('../src/sleeve-notes/airing-review.js');
const { stopConnectionCompute } = await import('../src/sleeve-notes/connection-compute.js');
const {router}=await import('../src/routes/sleeve-notes.js');
const {listen}=await import('./test-utils/http.js');
const app=express();app.use(router);const {server,url}=await listen(app);server.unref();
const at='2026-10-21T12:00:00.000Z';
function job(id:string,state='queued'){
 notes.open().prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,priority,created_at,updated_at)
 VALUES (?,'musicbrainz','local-track',?,'match',?,1,?,?)`).run(id,id,state,at,at);
}
function review(id:string){notes.open().prepare(`INSERT INTO sleeve_airing_reviews(id,airing_key,state,context_json,created_at,updated_at) VALUES (?,?,'queued','{}',?,?)`).run(id,id,at,at);}
beforeEach(async()=>{notes.open().exec('DELETE FROM sleeve_wikipedia_rescan_requests;DELETE FROM sleeve_queue_promotions;DELETE FROM sleeve_research_jobs;DELETE FROM sleeve_airing_reviews;');await settings.update({djBehaviour:{extendedSleeveNotes:true}});});
after(async()=>{stopConnectionCompute();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));notes.close();await removeTempDir(root);});

test('promotion reorders eligible work, survives reopen, retains retry gates and is consumed on start',()=>{
 job('a');job('b');const db=notes.open();
 assert.equal(repo.nextPendingResearchJob('musicbrainz')?.id,'a');
 manageQueuedJob(db,'b','top');notes.close();
 assert.equal(repo.nextPendingResearchJob('musicbrainz')?.id,'b');
 notes.open().prepare("UPDATE sleeve_research_jobs SET run_after='2999-01-01' WHERE id='b'").run();
 assert.equal(repo.nextPendingResearchJob('musicbrainz',{promotedOnly:true}),null);
 assert.equal(repo.nextPendingResearchJob('musicbrainz')?.id,'a');
 notes.open().prepare("UPDATE sleeve_research_jobs SET run_after=NULL WHERE id='b'").run();
 repo.markResearchJobRunning('b');assert.equal(queuePromotion(notes.open(),'b'),'');
 assert.throws(()=>manageQueuedJob(notes.open(),'b','cancel'),/running/);
 assert.throws(()=>manageQueuedJob(notes.open(),'b','top'),/running/);
});

test('cancel clears refresh intent and priority, retains attempts, and permits a later request',()=>{
 job('a');const db=notes.open();
 db.prepare("UPDATE sleeve_research_jobs SET attempts=3,provider='researcher',subject_type='artist',capability='extract-wikipedia' WHERE id='a'").run();
 db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES ('source','artist','a','wikipedia','https://example.test','hash','bounded-text','A supported story about the recording.','Example',?)`).run(at);
 db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,evidence,source_document_id,created_at,updated_at)
 VALUES ('fact','artist','a','artist-stories','recording','A supported story about the recording.','A supported story about the recording.','source',?,?)`).run(at,at);
 db.prepare("INSERT INTO sleeve_wikipedia_scan_progress(job_id,source_document_id,chunk_count,next_chunk,updated_at) VALUES ('a','source',3,1,?)").run(at);
 db.prepare("INSERT INTO sleeve_claim_history(id,claim_id,action,actor,before_json,created_at) VALUES ('history','fact','edited','operator','{}',?)").run(at);
 const tables=['sleeve_source_documents','sleeve_claims','sleeve_wikipedia_scan_progress','sleeve_claim_history'];
 const before=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
 db.prepare("INSERT INTO sleeve_wikipedia_rescan_requests(job_id,encounter_count_at_request,requested_at,refresh_mode) VALUES ('a',0,?,'replace')").run(at);
 manageQueuedJob(db,'a','top');manageQueuedJob(db,'a','cancel');
 assert.equal(queuePromotion(db,'a'),'');
 assert.deepEqual(db.prepare("SELECT state,attempts FROM sleeve_research_jobs WHERE id='a'").get(),{state:'cancelled',attempts:3});
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_wikipedia_rescan_requests').get() as {n:number}).n,0);
 assert.equal(repo.nextPendingResearchJob('researcher'),null);
 assert.deepEqual(tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all()),before);
 assert.throws(()=>manageQueuedJob(db,'a','top'),/no longer queued/);
 repo.requeueResearchJob('a');assert.equal(repo.nextPendingResearchJob('researcher')?.id,'a');
});

test('review promotion changes selection and cancellation dismisses the queued finding',()=>{
 review('first');review('second');const db=notes.open();
 manageQueuedJob(db,'review:second','top');assert.equal(nextAiringReview()?.id,'second');
 manageQueuedJob(db,'review:second','cancel');assert.equal(nextAiringReview()?.id,'first');
 assert.equal((db.prepare("SELECT state FROM sleeve_airing_reviews WHERE id='second'").get() as {state:string}).state,'dismissed');
 assert.throws(()=>manageQueuedJob(db,'review:second','top'),/no longer queued/);
});

test('admin API validates actions, rechecks state, and enforces master switch and authentication',async()=>{
 job('api');const headers={Authorization:`Basic ${Buffer.from('operator:test-secret').toString('base64')}`};
 const post=(action:string,authenticated=true)=>fetch(`${url}/sleeve-notes/queue/api/${action}`,{method:'POST',headers:authenticated?headers:{}});
 assert.equal((await post('top',false)).status,401);
 assert.equal((await post('bogus')).status,400);
 assert.equal((await post('top')).status,200);
 const readout=await fetch(`${url}/sleeve-notes/readout`,{headers});
 assert.equal(readout.status,200);
 const body=await readout.json() as {workQueueItems:Array<{id:string;promotedAt:string|null}>};
 assert.ok(body.workQueueItems.find(row=>row.id==='api')?.promotedAt);
 notes.open().prepare("UPDATE sleeve_research_jobs SET state='running' WHERE id='api'").run();
 assert.equal((await post('cancel')).status,409);
 await settings.update({djBehaviour:{extendedSleeveNotes:false}});
 assert.equal((await post('top')).status,409);
});
