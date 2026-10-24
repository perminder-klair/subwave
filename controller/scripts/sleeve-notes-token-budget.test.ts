import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {ResearchJob,ResearchCandidate} from '../src/sleeve-notes/researcher.js';
const root=createTempDir(join(tmpdir(),'notes-budget-'));process.env.STATE_DIR=root;
const settings=await import('../src/settings.js');const store=await import('../src/settings/store.js');
const {addDailyUsage}=await import('../src/llm/internal/telemetry/budget.js');
const {researchAllowed}=await import('../src/broadcast/dj-budget.js');
const {LlmResearcher}=await import('../src/sleeve-notes/llm-researcher.js');
const {ResearchDeferredError}=await import('../src/llm/log.js');
const {ResearchWorker}=await import('../src/sleeve-notes/research-worker.js');
const {open,close}=await import('../src/sleeve-notes/db.js');
await settings.load();
const saved=settings.get();
const job:ResearchJob={id:'job',document:{id:'source',entityId:'artist',provider:'wikipedia',sourceUrl:'https://example.test',revisionId:null,text:'Band formed in Cardiff.'},categories:['artist-stories'],maxCandidates:2};
const candidate:ResearchCandidate={category:'artist-stories',topic:'origin',wording:'Band formed in Cardiff.',evidence:'Band formed in Cardiff.'};

test('every research generation checks the shared hard cap before transport, including later phases',async t=>{
 store.setCache({...saved,llm:{...saved.llm,dailyTokenCap:10}});addDailyUsage(10);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Network forbidden');});
 const researcher=new LlmResearcher();const signal=new AbortController().signal;
 for(const run of [()=>researcher.extractWikipediaSparks(job,'lead',signal),()=>researcher.extract(job,signal),
  ()=>researcher.rankForAirtime(job,[candidate,candidate],signal),()=>researcher.reviewForAirtime(job,[candidate],signal)]) {
  await assert.rejects(run,error=>error instanceof ResearchDeferredError && error.reason==='station-token-cap');
 }
 assert.equal(calls,0);assert.equal(researchAllowed(),false);
 store.setCache({...saved,llm:{...saved.llm,dailyTokenCap:100}});assert.equal(researchAllowed(),true);
 store.setCache({...saved,llm:{...saved.llm,dailyTokenCap:0}});assert.equal(researchAllowed(),true);
});

test('a blocked worker preserves queued work and attempts for later resumption',async()=>{
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:true},llm:{...saved.llm,dailyTokenCap:1}});
 const db=open();const at=new Date().toISOString();
 db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,attempts,created_at,updated_at)
  VALUES ('queued','researcher','artist','artist','extract-wikipedia','queued',3,?,?)`).run(at,at);
 const before=db.prepare('SELECT * FROM sleeve_research_jobs').all();
 assert.equal(await new ResearchWorker({isQuiet:()=>true}).runOnce(),false);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_research_jobs').all(),before);
});

test.after(async ()=>{store.setCache(saved);close();await removeTempDir(root);});
