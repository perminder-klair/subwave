import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=createTempDir(join(tmpdir(),'subwave-airing-review-'));
process.env.STATE_DIR=root;
delete process.env.ADMIN_USER;delete process.env.ADMIN_PASS;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const {open,close,withCachedRead}=await import('../src/sleeve-notes/db.js');
const {flagAiredUse,listAiringReviews,nextAiringReview,runAiringReview,decideAiringReview,approvedAiringGuidance,reviewReadyCount,flagStoredClaim,storedClaimReviews}=await import('../src/sleeve-notes/airing-review.js');
const {ResearchWorker}=await import('../src/sleeve-notes/research-worker.js');
const {primaryLeg}=await import('../src/llm/internal/provider/legs.js');
const defaults=settings.getDefaults();
store.setCache({...defaults,djBehaviour:{...defaults.djBehaviour,extendedSleeveNotes:true},llm:{...defaults.llm,
  provider:'openai',model:'review-test',baseUrl:'http://review-test.invalid/v1',fallback:{...defaults.llm.fallback,enabled:false}}});
const db=open(),at=new Date().toISOString();
const wording='Following Raven’s death in 2007, all four founding members returned the following year.';
db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
  VALUES ('source','artist','artist','wikipedia','https://example.test','hash','bounded-text',?,'Source',?)`).run(wording,at);
db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
  VALUES ('claim','artist','artist','artist-stories','reunion',?,'source',?,?,?)`).run(wording,wording,at,at);
const insert=db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,supplied_at,offered_wording,
  claim_wording_at_offer,aired_at,tts_rendered_at,tts_text,consumer,segment_id)
  VALUES (?,'claim','artist','artist','artist-stories','reunion',?,?,?,?,?,'Even in death we can find closure.',?,?)`);
function use(id:string,segment:string|null=null) {insert.run(id,at,wording,wording,at,at,segment?'sleeveNotesSegment':'generateLink',segment);}
const result={finding:'presentation',summary:'The link adds an unsupported emotional conclusion.',
  explanation:'The Spark gives a death and reunion chronology. Closure is the DJ’s invented interpretation.',
  suggestedSpeech:'After Raven’s death in 2007, the four founding members reunited the following year.',
  proposedGuidance:'Preserve date context and do not invent emotional conclusions.',sparkCorrection:null};
function model(t:TestContext,answer:unknown,onCall: (request:unknown)=>void=()=>{}) {
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Real network forbidden');});
  const leg=primaryLeg();
  for(const engine of new Set([leg.model,leg.noThinkModel]))t.mock.method(engine,'doGenerate',async(request:unknown)=>{
    calls++;onCall(request);
    return {content:[{type:'text',text:JSON.stringify(answer)}],finishReason:{unified:'stop',raw:'stop'},
      usage:{inputTokens:{total:1000,noCache:1000,cacheRead:0,cacheWrite:0},outputTokens:{total:200,text:200,reasoning:0}},warnings:[]};
  });
  return ()=>calls;
}

test('one click snapshots the whole segment once, keeps Sparks active and accepts undetected speech',async()=>{
  use('one','segment');use('two','segment');
  db.prepare(`INSERT INTO sleeve_segment_lines VALUES ('segment',0,2,'host','Host','First contribution',?)`).run(at);
  db.prepare(`INSERT INTO sleeve_segment_lines VALUES ('segment',1,2,'guest','Guest','Second contribution',?)`).run(at);
  const first=await flagAiredUse('one');
  assert.deepEqual(await flagAiredUse('two'),first);
  const page=listAiringReviews();assert.equal(page.total,1);assert.equal(page.items[0].context.sparks.length,2);
  assert.match(JSON.stringify(page.items[0].context.speech),/Second contribution/);
  assert.equal((db.prepare('SELECT enabled FROM sleeve_claims').get() as {enabled:number}).enabled,1);
  assert.equal(approvedAiringGuidance(),'');assert.equal(reviewReadyCount(),0,'queued reviews do not need operator input');
  await assert.rejects(flagAiredUse('missing'),/No confirmed/);
});

test('explicitly promoted research takes priority; the next pacing slot runs the review',async t=>{
  const calls=model(t,result),worker=new ResearchWorker({isQuiet:()=>true});
  db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,operator_requested,created_at,updated_at)
    VALUES ('research-first','researcher','artist','missing','extract-wikipedia','queued',1,?,?)`).run(at,at);
  const {manageQueuedJob}=await import('../src/sleeve-notes/queue-actions.js');
  manageQueuedJob(db,'research-first','top');
  assert.equal(await worker.runOnce(),true);assert.equal(calls(),0);assert.equal(listAiringReviews().items[0].state,'queued');
  assert.equal(await worker.runOnce(),true);assert.equal(calls(),1);
  const review=listAiringReviews().items[0];assert.equal(review.state,'ready');assert.deepEqual(review.result,result);assert.equal(reviewReadyCount(),1);
  assert.equal(approvedAiringGuidance(),'');assert.equal(await worker.runOnce(),false);
  decideAiringReview(review.id,'apply-guidance');assert.match(approvedAiringGuidance(),/Preserve date context/);
  assert.equal(listAiringReviews().total,0);assert.equal(listAiringReviews('resolved').total,1);assert.equal(reviewReadyCount(),0);
  decideAiringReview(review.id,'revoke-guidance');assert.equal(approvedAiringGuidance(),'');
});

test('requested reviews take a normal pacing slot ahead of unpromoted background research',async t=>{
 use('priority-review');const flag=await flagAiredUse('priority-review');
 const calls=model(t,result);db.prepare('DELETE FROM sleeve_research_pacing').run();
 db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,operator_requested,created_at,updated_at)
 VALUES ('background-behind-review','researcher','artist','background-missing','extract-wikipedia','queued',1,?,?)`).run(at,at);
 assert.equal(await new ResearchWorker({isQuiet:()=>true}).runOnce(),true);
 assert.equal(calls(),1);
 assert.equal((db.prepare("SELECT state FROM sleeve_research_jobs WHERE id='background-behind-review'").get() as {state:string}).state,'queued');
 assert.equal((db.prepare('SELECT last_slot_kind AS kind FROM sleeve_research_pacing WHERE id=1').get() as {kind:string}).kind,'review');
 use('second-priority-review');const second=await flagAiredUse('second-priority-review');
 db.prepare("UPDATE sleeve_research_pacing SET next_pair_at='2000-01-01' WHERE id=1").run();
 assert.equal(await new ResearchWorker({isQuiet:()=>true}).runOnce(),true);
 assert.equal(calls(),1,'a new worker should select background research before another ordinary review');
 assert.equal((db.prepare('SELECT state FROM sleeve_airing_reviews WHERE id=?').get(second.id) as {state:string}).state,'queued');
 db.prepare('DELETE FROM sleeve_airing_reviews WHERE id=?').run(second.id);
 db.prepare("DELETE FROM sleeve_research_jobs WHERE id='background-behind-review'").run();
 db.prepare('DELETE FROM sleeve_airing_reviews WHERE id=?').run(flag.id);
});

test('interruptions retry durably, and the shared pacing gate prevents immediate repeated calls',async t=>{
  use('interrupted');await flagAiredUse('interrupted');
  let quiet=true;const calls=model(t,result,()=>{quiet=false;});
  db.prepare('DELETE FROM sleeve_research_pacing').run();
  const worker=new ResearchWorker({isQuiet:()=>quiet});
  assert.equal(await worker.runOnce(),true);assert.equal(calls(),1);assert.equal(listAiringReviews().items[0].state,'queued');
  quiet=true;assert.equal(await worker.runOnce(),false);assert.equal(calls(),1);
  const job=nextAiringReview()!;
  db.prepare("UPDATE sleeve_airing_reviews SET state='running',lease_token='old',updated_at='2000-01-01' WHERE id=?").run(job.id);
  assert.equal(nextAiringReview()?.id,job.id,'a dead controller lease is recoverable');
  db.prepare("UPDATE sleeve_airing_reviews SET state='dismissed' WHERE id=?").run(job.id);
  assert.equal(await runAiringReview(job,{isQuiet:()=>true}),false,'a stale job cannot overwrite a decision');
});

test('a correction needs explicit approval and cannot overwrite a later operator edit',async t=>{
  use('correct');const flag=await flagAiredUse('correct');
  model(t,{...result,finding:'spark',proposedGuidance:null,sparkCorrection:{claimId:'claim',wording:'After Raven’s death in 2007, all four founding members returned the following year.',evidence:wording}});
  await runAiringReview(nextAiringReview()!,{isQuiet:()=>true});
  db.prepare("UPDATE sleeve_claims SET wording='A later operator correction.' WHERE id='claim'").run();
  assert.throws(()=>decideAiringReview(flag.id,'apply-correction'),/changed or was removed/);
  assert.equal((db.prepare("SELECT wording FROM sleeve_claims WHERE id='claim'").get() as {wording:string}).wording,'A later operator correction.');
  db.prepare("UPDATE sleeve_claims SET wording=? WHERE id='claim'").run(wording);
  decideAiringReview(flag.id,'apply-correction');
  assert.equal(listAiringReviews('resolved').items.find(item=>item.id===flag.id)?.state,'resolved');
  assert.equal((db.prepare("SELECT operator_state AS state FROM sleeve_claims WHERE id='claim'").get() as {state:string}).state,'approved');
});

test('retaining a review snapshot does not block expiry of its original usage record',()=>{
  const before=listAiringReviews('resolved').total;
  db.prepare("DELETE FROM sleeve_claim_uses WHERE id='one'").run();
  assert.equal(listAiringReviews('resolved').total,before);
  assert.equal((db.prepare("SELECT use_id FROM sleeve_airing_reviews WHERE airing_key='segment:segment'").get() as {use_id:null}).use_id,null);
});

test('flagging a recovered legacy conversation includes all its offered Sparks',async()=>{
  db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
    VALUES ('second-claim','artist','artist','artist-stories','second-topic',?,'source',?,?,?)`).run(wording,wording,at,at);
  use('legacy-a');use('legacy-b');
  db.prepare("UPDATE sleeve_claim_uses SET consumer='sleeveNotesSegment' WHERE id IN ('legacy-a','legacy-b')").run();
  db.prepare("UPDATE sleeve_claim_uses SET claim_id='second-claim' WHERE id='legacy-b'").run();
  writeFileSync(join(root,'session.json'),JSON.stringify({messages:['legacy-a','legacy-b'].map(id=>({
    role:'segment',kind:'sleeve-notes',text:'Even in death we can find closure.',
    meta:{airedAt:at,sleeveNotesSegmentUseIds:[id],personaName:'Host',personaId:'host'}}))}));
  const flag=await flagAiredUse('legacy-a');
  assert.deepEqual(await flagAiredUse('legacy-b'),flag);
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.context.sparks.length,2);
});

test('review headings use library metadata when the airing snapshot has none, including existing flags',async()=>{
  use('metadata');
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES ('metadata-track','The Madding Crowd','Killing Joke','unmatched',?,?,?)`).run(at,at,at);
  db.prepare("UPDATE sleeve_claim_uses SET local_track_id='metadata-track' WHERE id='metadata'").run();
  const flag=await flagAiredUse('metadata');
  const stored=JSON.parse((db.prepare('SELECT context_json AS context FROM sleeve_airing_reviews WHERE id=?').get(flag.id) as {context:string}).context);
  assert.equal(stored.artist,'Killing Joke');assert.equal(stored.title,'The Madding Crowd');
  stored.artist=null;stored.title=null;
  db.prepare('UPDATE sleeve_airing_reviews SET context_json=? WHERE id=?').run(JSON.stringify(stored),flag.id);
  const context=listAiringReviews().items.find(item=>item.id===flag.id)!.context;
  assert.equal(context.artist,'Killing Joke');assert.equal(context.title,'The Madding Crowd');
  stored.artist='Original artist';stored.title='Original title';
  db.prepare('UPDATE sleeve_airing_reviews SET context_json=? WHERE id=?').run(JSON.stringify(stored),flag.id);
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)!.context.artist,'Original artist');
});

test('unchanged corrections are suppressed and dismissed reviews can retry the same frozen airing',async t=>{
  use('retry-example');const flag=await flagAiredUse('retry-example');
  const answer={...result,finding:'spark',proposedGuidance:null,sparkCorrection:{claimId:'claim',wording,evidence:wording}};
  const calls=model(t,answer);
  const context=(db.prepare('SELECT context_json AS context FROM sleeve_airing_reviews WHERE id=?').get(flag.id) as {context:string}).context;
  await runAiringReview({id:flag.id,context},{isQuiet:()=>true});
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.result?.sparkCorrection,null);
  assert.throws(()=>decideAiringReview(flag.id,'apply-correction'),/No Spark wording correction/);
  assert.throws(()=>decideAiringReview(flag.id,'retry'),/Only dismissed/);
  db.prepare('UPDATE sleeve_airing_reviews SET result_json=? WHERE id=?').run(JSON.stringify(answer),flag.id);
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.result?.sparkCorrection,null,'old findings are also filtered');
  decideAiringReview(flag.id,'dismiss');decideAiringReview(flag.id,'retry');
  assert.deepEqual(db.prepare('SELECT state,result_json,last_error,lease_token,context_json FROM sleeve_airing_reviews WHERE id=?').get(flag.id),
    {state:'queued',result_json:null,last_error:null,lease_token:null,context_json:context});
  await runAiringReview({id:flag.id,context},{isQuiet:()=>true});
  assert.equal(calls(),2);assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.state,'ready');
  assert.deepEqual(await flagAiredUse('retry-example'),{id:flag.id,state:'ready'},'retry retains the original review identity');
});

test('ready counts ignore older manual review items',async()=>{
  const before=reviewReadyCount();
  const {sendClaimToReview}=await import('../src/sleeve-notes/moderation.js');
  sendClaimToReview('claim');
  assert.equal(reviewReadyCount(),before);
});

function fact(id:string) {
  db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
    VALUES (?,'artist','artist','artist-stories',?,?,'source',?,?,?)`).run(id,id,wording,wording,at,at);
}
function jobFor(id:string) {
  return db.prepare('SELECT id,context_json AS context FROM sleeve_airing_reviews WHERE id=?').get(id) as {id:string;context:string};
}

test('saved facts use the same AI queue; withdrawal survives dismissal and retry until explicit restoration',async t=>{
  const {setClaimAvailability}=await import('../src/sleeve-notes/moderation.js');
  const {retainResearchClaims,searchResearchStoriesInDatabase}=await import('../src/sleeve-notes/research-repository.js');
  fact('fact-review');
  const flag=flagStoredClaim('fact-review');assert.deepEqual(flagStoredClaim('fact-review'),flag);
  assert.deepEqual(storedClaimReviews(['fact-review','missing']),{'fact-review':flag});
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='fact-review'").get() as {enabled:number}).enabled,1);
  const context=JSON.parse(jobFor(flag.id).context);assert.equal(context.kind,'fact');assert.equal(context.airedAt,null);assert.deepEqual(context.speech,[]);
  decideAiringReview(flag.id,'withdraw-fact');
  retainResearchClaims({entityType:'artist',entityId:'artist',sourceDocumentId:'source',candidates:[{category:'artist-stories',topic:'fact-review',wording,evidence:wording}]});
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='fact-review'").get() as {enabled:number}).enabled,0);
  assert.ok(searchResearchStoriesInDatabase(db,{withdrawn:true}).claims.some(item=>item.id==='fact-review'));
  assert.ok(!searchResearchStoriesInDatabase(db).claims.some(item=>item.id==='fact-review'));
  const calls=model(t,{...result,finding:'no-issue',sparkCorrection:null});
  await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  const review=listAiringReviews().items.find(item=>item.id===flag.id)!;
  assert.equal(review.result?.suggestedSpeech,'');assert.equal(review.result?.proposedGuidance,null);assert.equal(review.context.sparks[0].enabled,0);
  decideAiringReview(flag.id,'dismiss');
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='fact-review'").get() as {enabled:number}).enabled,0);
  decideAiringReview(flag.id,'retry');await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  assert.equal(calls(),2);
  decideAiringReview(flag.id,'restore-fact');
  assert.deepEqual(db.prepare("SELECT enabled,feedback_hold,operator_state FROM sleeve_claims WHERE id='fact-review'").get(),{enabled:1,feedback_hold:0,operator_state:'approved'});
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claim_uses WHERE claim_id='fact-review'").get() as {n:number}).n,0);
  setClaimAvailability('fact-review','withdraw');
  assert.equal(flagStoredClaim('fact-review').state,'queued','a closed saved-fact review can be explicitly requested again');
});

test('punctuation review receives minimal-edit instructions and preserves the full fact until approval',async t=>{
  const original=', In 2007 and 2008, they played gigs and festivals across the UK and Europe, and signed to a new management company in 2008.';
  const corrected=original.slice(2);
  db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
    VALUES ('punctuation-source','artist','artist','wikipedia','https://example.test/punctuation','punctuation-hash','bounded-text',?,'Source',?)`).run(original,at);
  db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
    VALUES ('punctuation-claim','artist','artist','artist-stories','touring',?,'punctuation-source',?,?,?)`).run(original,original,at,at);
  const flag=flagStoredClaim('punctuation-claim');
  const calls=model(t,{...result,finding:'spark',summary:'Remove the stray leading comma.',
    explanation:'The punctuation is defective; the factual details stay unchanged.',suggestedSpeech:'',proposedGuidance:null,
    sparkCorrection:{claimId:'punctuation-claim',wording:corrected,evidence:original}},request=>{
      const sent=JSON.stringify(request);
      assert.match(sent,/Check the stored Spark for punctuation, grammar and extraction artefacts/);
      assert.match(sent,/For punctuation-only fixes, preserve all dates, names, places and factual clauses/);
      assert.match(sent,/supplied source explicitly contradicts that particular fact/);
      assert.match(sent,/Check that the proposed correction actually removes the diagnosed defect/);
      assert.ok(sent.includes(original),'review receives the unchanged saved wording and evidence');
    });
  await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  assert.equal(calls(),1);
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.result?.sparkCorrection?.wording,corrected);
  assert.equal((db.prepare("SELECT wording FROM sleeve_claims WHERE id='punctuation-claim'").get() as {wording:string}).wording,original);
  decideAiringReview(flag.id,'apply-correction');
  assert.equal((db.prepare("SELECT wording FROM sleeve_claims WHERE id='punctuation-claim'").get() as {wording:string}).wording,corrected);
});

test('saved-fact review can restore a relative date from preceding source context',async t=>{
  const original="The following month, it was confirmed that the band would play Open’er Festival in Poland.";
  const source='In January 2010, the band announced a tour. '+original;
  const corrected="In February 2010, it was confirmed that the band would play Open’er Festival in Poland.";
  db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
    VALUES ('date-source','artist','artist','wikipedia','https://example.test/date','date-hash','bounded-text',?,'Source',?)`).run(source,at);
  db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
    VALUES ('date-claim','artist','artist','artist-stories','festival',?,'date-source',?,?,?)`).run(original,original,at,at);
  const flag=flagStoredClaim('date-claim');
  model(t,{...result,finding:'spark',summary:'Restore the missing date context.',explanation:'The preceding January 2010 reference places the announcement in February 2010.',
    suggestedSpeech:'',proposedGuidance:null,sparkCorrection:{claimId:'date-claim',wording:corrected,evidence:source}},request=>{
      const sent=JSON.stringify(request);
      assert.match(sent,/Restoring a missing time anchor is a context repair/);
      assert.match(sent,/Distinguish the date of an announcement from the date of the performance or release/);
      assert.match(sent,/choose unclear rather than guessing a date/);
      assert.match(sent,/An explicit day\/month\/year already anchors an event/);
      assert.match(sent,/actually provide the replacement wording in sparkCorrection/);
      assert.match(sent,/If no safe repair is supported, choose unclear/);
      assert.ok(sent.includes(source),'review includes the preceding source sentence');
    });
  await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  assert.equal(listAiringReviews().items.find(item=>item.id===flag.id)?.result?.sparkCorrection?.wording,corrected);
  decideAiringReview(flag.id,'apply-correction');
  assert.equal((db.prepare("SELECT wording FROM sleeve_claims WHERE id='date-claim'").get() as {wording:string}).wording,corrected);
});

test('correct and restore is explicit, while deleting a withdrawn fact keeps replay suppression',async t=>{
  const {setClaimAvailability}=await import('../src/sleeve-notes/moderation.js');
  const {retainResearchClaims}=await import('../src/sleeve-notes/research-repository.js');
  fact('fact-correct');setClaimAvailability('fact-correct','withdraw');
  const flag=flagStoredClaim('fact-correct');
  const corrected='After Raven’s death in 2007, all four founding members returned the following year.';
  model(t,{...result,finding:'spark',sparkCorrection:{claimId:'fact-correct',wording:corrected,evidence:wording}});
  await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='fact-correct'").get() as {enabled:number}).enabled,0);
  decideAiringReview(flag.id,'apply-correction');
  assert.deepEqual(db.prepare("SELECT enabled,wording FROM sleeve_claims WHERE id='fact-correct'").get(),{enabled:1,wording:corrected});
  assert.deepEqual(storedClaimReviews(['fact-correct']),{},'an old snapshot does not label corrected wording as reviewed');
  assert.notEqual(flagStoredClaim('fact-correct').id,flag.id,'changed facts receive a fresh snapshot');
  fact('fact-delete');setClaimAvailability('fact-delete','withdraw');
  const deleted=flagStoredClaim('fact-delete');await runAiringReview(jobFor(deleted.id),{isQuiet:()=>true});
  decideAiringReview(deleted.id,'delete-fact');
  retainResearchClaims({entityType:'artist',entityId:'artist',sourceDocumentId:'source',candidates:[{category:'artist-stories',topic:'fact-delete',wording,evidence:wording}]});
  assert.deepEqual(db.prepare("SELECT enabled,operator_state FROM sleeve_claims WHERE id='fact-delete'").get(),{enabled:0,operator_state:'deleted'});
  assert.throws(()=>setClaimAvailability('fact-delete','restore'),/already been deleted/);
  assert.throws(()=>flagStoredClaim('fact-delete'),/already been deleted/);
});

test('a stale saved-fact finding cannot restore or delete a later operator edit',async t=>{
  const {setClaimAvailability}=await import('../src/sleeve-notes/moderation.js');
  fact('fact-stale');setClaimAvailability('fact-stale','withdraw');const flag=flagStoredClaim('fact-stale');
  model(t,{...result,finding:'no-issue',proposedGuidance:null});await runAiringReview(jobFor(flag.id),{isQuiet:()=>true});
  db.prepare("UPDATE sleeve_claims SET wording='A later operator edit.' WHERE id='fact-stale'").run();
  assert.throws(()=>decideAiringReview(flag.id,'restore-fact'),/changed or was removed/);
  assert.throws(()=>decideAiringReview(flag.id,'delete-fact'),/changed or was removed/);
  db.prepare("UPDATE sleeve_claims SET wording=?,evidence='A later evidence edit.' WHERE id='fact-stale'").run(wording);
  assert.throws(()=>decideAiringReview(flag.id,'restore-fact'),/changed or was removed/);
  decideAiringReview(flag.id,'dismiss');
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='fact-stale'").get() as {enabled:number}).enabled,0);
});

test('automatic recycle-bin expiry cannot erase a withdrawn or flagged fact',async()=>{
  const {sendClaimToReview,setClaimAvailability,expireRecycleBin}=await import('../src/sleeve-notes/moderation.js');
  for (const id of ['fact-held-expiry','fact-flagged-expiry']) {
    fact(id);sendClaimToReview(id);
    db.prepare("UPDATE sleeve_moderation_candidates SET rejection_origin='dj-quality',bin_entered_at='2000-01-01' WHERE claim_id=?").run(id);
  }
  setClaimAvailability('fact-held-expiry','withdraw');
  flagStoredClaim('fact-flagged-expiry');
  db.prepare("UPDATE sleeve_claims SET feedback_hold=0 WHERE id='fact-flagged-expiry'").run();
  assert.equal(expireRecycleBin(),0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sleeve_claims WHERE id IN ('fact-held-expiry','fact-flagged-expiry')").get() as {n:number}).n,2);
});

test('disabled reads do not create or migrate a cache',()=>{
  assert.deepEqual(withCachedRead(()=>listAiringReviews(),'nonexistent-airing-review-cache.db'),{items:[],total:0});
  assert.equal(withCachedRead(reviewReadyCount,'nonexistent-airing-review-cache.db'),0);
  assert.deepEqual(withCachedRead(()=>storedClaimReviews(['missing']),'nonexistent-airing-review-cache.db'),{});
});

test.after(async ()=>{close();store.setCache(null);await removeTempDir(root);});
