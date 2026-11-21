import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-manual-review-'));
process.env.STATE_DIR = root;
process.env.ADMIN_USER = 'operator'; process.env.ADMIN_PASS = 'secret';
const { open, close } = await import('../src/sleeve-notes/db.js');
const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');
const { router } = await import('../src/routes/sleeve-notes.js');
const { expireRecycleBin, moderateCandidate, sendClaimToReview, setClaimAvailability, moderateExistingClaim } = await import('../src/sleeve-notes/moderation.js');
const { retainResearchClaims } = await import('../src/sleeve-notes/research-repository.js');
const db = open();
await settings.load();
const defaults = settings.get();
const configure = (enabled: boolean) => store.setCache({ ...defaults, djBehaviour: { ...defaults.djBehaviour, extendedSleeveNotes: enabled } });
configure(true);
const now = new Date().toISOString();
const wording = 'Nick Mason later worked with Alan Parsons to recreate the drum sound of Dark Side of the Moon.';
const candidate = { category: 'artist-stories' as const, topic: 'drum-recreation', wording, evidence: wording };
db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url, content_hash, content_kind, content, attribution, retrieved_at)
  VALUES ('source', 'artist', 'artist', 'web-operator', 'https://example.test/article', 'hash', 'bounded-text', ?, 'Article', ?)`).run(wording, now);
function seed(id: string) {
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording, source_document_id, evidence, created_at, updated_at)
    VALUES (?, 'artist', 'artist', 'artist-stories', ?, ?, 'source', ?, ?, ?)`).run(id, id, wording, wording, now, now);
}
const app = express(); app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
const base = `http://127.0.0.1:${address.port}/sleeve-notes`;
const post = (id: string) => fetch(`${base}/claims/${id}/review`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('operator:secret').toString('base64')}` } });

test('unaired saved facts are flagged through the AI route without being withdrawn', async () => {
  seed('claim');
  const response=await post('claim');assert.equal(response.status,200);
  const flag=await response.json() as {id:string;state:string};
  assert.deepEqual(await (await post('claim')).json(),flag);
  assert.equal(flag.state,'queued');
  assert.deepEqual(db.prepare('SELECT enabled,feedback_hold FROM sleeve_claims WHERE id=?').get('claim'),{enabled:1,feedback_hold:0});
  const review=db.prepare('SELECT use_id,context_json AS context FROM sleeve_airing_reviews WHERE id=?').get(flag.id) as {use_id:null;context:string};
  const context=JSON.parse(review.context);assert.equal(review.use_id,null);assert.equal(context.kind,'fact');
  assert.equal(context.sparks[0].wording,wording);assert.equal(context.sparks[0].evidence,wording);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as {n:number}).n,0);
});

test('withdrawal is a separate admin action and survives research until explicit restoration',async()=>{
  const headers={Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`};
  assert.equal((await fetch(`${base}/claims/claim/withdraw`,{method:'POST',headers})).status,200);
  assert.equal(expireRecycleBin(),0);
  retainResearchClaims({entityType:'artist',entityId:'artist',sourceDocumentId:'source',candidates:[{...candidate,topic:'claim'}]});
  assert.deepEqual(db.prepare("SELECT enabled,feedback_hold FROM sleeve_claims WHERE id='claim'").get(),{enabled:0,feedback_hold:1});
  const response=await fetch(`${base}/stories?withdrawn=1`,{headers});
  assert.equal(response.status,200);assert.equal((await response.json() as {claims:Array<{id:string}>}).claims[0].id,'claim');
  assert.equal((await fetch(`${base}/claims/claim/restore`,{method:'POST',headers})).status,200);
  assert.deepEqual(db.prepare("SELECT enabled,feedback_hold,operator_state FROM sleeve_claims WHERE id='claim'").get(),{enabled:1,feedback_hold:0,operator_state:'approved'});
});

test('deleting a fact closes pending fact reviews and prevents automated resurrection',()=>{
  moderateExistingClaim('claim','deleted',null);
  retainResearchClaims({entityType:'artist',entityId:'artist',sourceDocumentId:'source',candidates:[{...candidate,topic:'claim'}]});
  assert.deepEqual(db.prepare("SELECT enabled,operator_state FROM sleeve_claims WHERE id='claim'").get(),{enabled:0,operator_state:'deleted'});
  assert.equal((db.prepare('SELECT state FROM sleeve_airing_reviews').get() as {state:string}).state,'resolved');
  assert.throws(()=>setClaimAvailability('claim','restore'),/already been deleted/);
});

test('missing or explicitly deleted claims are rejected; disabled mode and admin authentication protect writes', async () => {
  assert.equal((await post('missing')).status, 400);
  db.prepare("UPDATE sleeve_claims SET operator_state='deleted' WHERE id='claim'").run();
  assert.throws(() => sendClaimToReview('claim'), /already been deleted/);
  configure(false); assert.equal((await post('claim')).status, 409);
  assert.equal((await fetch(`${base}/claims/claim/withdraw`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`}})).status,409);
  configure(true);
  assert.equal((await fetch(`${base}/claims/claim/review`, { method: 'POST' })).status, 401);
});

test('Review validation keeps invalid edits withheld and still requires an exact source passage', () => {
  seed('validation');
  const item = sendClaimToReview('validation');
  for (const edit of [
    { ...candidate, topic: 'x' },
    { ...candidate, wording: 'A sentence without its ending' },
    { ...candidate, evidence: 'Too short' },
    { ...candidate, evidence: 'This sufficiently long passage does not occur in the saved source.' },
  ]) {
    assert.throws(() => moderateCandidate(item.id, 'approved', edit));
    assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='validation'").get() as { enabled: number }).enabled, 0);
  }
  moderateCandidate(item.id, 'approved', { ...candidate, topic: 'validation' });
  assert.equal((db.prepare("SELECT enabled FROM sleeve_claims WHERE id='validation'").get() as { enabled: number }).enabled, 1);
});


test('edited AI corrections validate source support, stay bound to their proposed fact, and save the operator wording',async()=>{
  const {flagStoredClaim}=await import('../src/sleeve-notes/airing-review.js');
  seed('editable');setClaimAvailability('editable','withdraw');
  const review=flagStoredClaim('editable');
  const proposed='Nick Mason and Alan Parsons recreated the drum sound of Dark Side of the Moon.';
  db.prepare("UPDATE sleeve_airing_reviews SET state='ready',result_json=? WHERE id=?").run(JSON.stringify({
    finding:'spark',summary:'The wording needs a correction.',explanation:'A revised sentence is proposed.',suggestedSpeech:'',proposedGuidance:null,
    sparkCorrection:{claimId:'editable',wording:proposed,evidence:wording}}),review.id);
  const correction={claimId:'editable',wording:'Nick Mason worked with Alan Parsons to recreate the drum sound of Dark Side of the Moon.',evidence:wording};
  const decide=(body:unknown)=>fetch(`${base}/airing-reviews/${review.id}/decision`,{method:'POST',headers:{
    Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await decide({action:'apply-correction',correction:{...correction,claimId:'validation'}})).status,409,'an edit cannot change the proposed target');
  assert.equal((await decide({action:'apply-correction',correction:{...correction,wording:'An unfinished sentence'}})).status,400);
  assert.equal((await decide({action:'resolve',correction})).status,400,'edits are only accepted by Apply correction');
  const invalid=await decide({action:'apply-correction',correction:{...correction,evidence:'This supporting passage is absent from the saved source.'}});
  assert.equal(invalid.status,409);
  assert.deepEqual(db.prepare("SELECT enabled,wording FROM sleeve_claims WHERE id='editable'").get(),{enabled:0,wording});
  assert.equal((db.prepare('SELECT state FROM sleeve_airing_reviews WHERE id=?').get(review.id) as {state:string}).state,'ready');
  assert.equal((await decide({action:'apply-correction',correction})).status,200);
  assert.deepEqual(db.prepare("SELECT enabled,wording,evidence FROM sleeve_claims WHERE id='editable'").get(),{enabled:1,wording:correction.wording,evidence:wording});
  const saved=db.prepare('SELECT state,context_json AS context,result_json AS result FROM sleeve_airing_reviews WHERE id=?').get(review.id) as {state:string;context:string;result:string};
  assert.equal(saved.state,'resolved');assert.deepEqual(JSON.parse(saved.context).appliedCorrection,correction);
  assert.equal(JSON.parse(saved.result).sparkCorrection.wording,proposed,'retain the original model proposal separately');
});

test.after(async () => { server.close(); close(); await removeTempDir(root); });


test('retired direct-edit API rejects stale writes; deleted facts cannot be reapproved internally',async()=>{
 configure(true);seed('retired-editor');
 const headers={Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`,'Content-Type':'application/json'};
 for(const action of ['approved','deleted']) {
  const response=await fetch(`${base}/claims/retired-editor/${action}`,{method:'POST',headers,body:JSON.stringify({...candidate,shortWording:''})});
  assert.equal(response.status,410);
 }
 assert.deepEqual(db.prepare("SELECT enabled,operator_state FROM sleeve_claims WHERE id='retired-editor'").get(),{enabled:1,operator_state:'auto'});
 moderateExistingClaim('retired-editor','deleted',null);
 assert.throws(()=>moderateExistingClaim('retired-editor','approved',candidate),/already been deleted/);
 assert.deepEqual(db.prepare("SELECT enabled,operator_state FROM sleeve_claims WHERE id='retired-editor'").get(),{enabled:0,operator_state:'deleted'});
});

test('a ready review without an AI proposal accepts a bound manual edit with the same source and stale-edit guards',async()=>{
  const {flagStoredClaim}=await import('../src/sleeve-notes/airing-review.js');
  seed('manual-only');setClaimAvailability('manual-only','withdraw');
  const review=flagStoredClaim('manual-only');
  const result={finding:'unclear',summary:'No safe replacement was suggested.',explanation:'The operator can inspect the source.',suggestedSpeech:'',proposedGuidance:null,sparkCorrection:null};
  db.prepare("UPDATE sleeve_airing_reviews SET state='ready',result_json=? WHERE id=?").run(JSON.stringify(result),review.id);
  const correction={claimId:'manual-only',wording:'Nick Mason worked with Alan Parsons to recreate the drum sound of Dark Side of the Moon.',evidence:wording};
  const decide=(body:unknown)=>fetch(`${base}/airing-reviews/${review.id}/decision`,{method:'POST',headers:{
    Authorization:`Basic ${Buffer.from('operator:secret').toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await decide({action:'apply-correction'})).status,409,'missing manual text cannot silently apply anything');
  assert.equal((await decide({action:'apply-correction',correction:{...correction,claimId:'editable'}})).status,409,'manual edits cannot target an unrelated fact');
  assert.equal((await decide({action:'apply-correction',correction:{...correction,evidence:'An invented passage that does not occur in this source.'}})).status,409);
  assert.equal((await decide({action:'apply-correction',correction:{...correction,wording:'An unfinished sentence'}})).status,400);
  assert.deepEqual(db.prepare("SELECT enabled,wording FROM sleeve_claims WHERE id='manual-only'").get(),{enabled:0,wording});
  db.prepare("UPDATE sleeve_claims SET wording='A later operator change.' WHERE id='manual-only'").run();
  assert.equal((await decide({action:'apply-correction',correction})).status,409,'a manual correction must not overwrite a newer edit');
  db.prepare("UPDATE sleeve_claims SET wording=? WHERE id='manual-only'").run(wording);
  assert.equal((await decide({action:'apply-correction',correction})).status,200);
  assert.deepEqual(db.prepare("SELECT enabled,wording,evidence FROM sleeve_claims WHERE id='manual-only'").get(),{enabled:1,wording:correction.wording,evidence:wording});
  const saved=db.prepare('SELECT state,context_json AS context FROM sleeve_airing_reviews WHERE id=?').get(review.id) as {state:string;context:string};
  assert.equal(saved.state,'resolved');assert.deepEqual(JSON.parse(saved.context).appliedCorrection,correction);
});
