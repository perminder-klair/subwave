import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-transcript-history-'));process.env.STATE_DIR=root;
const {migrate,open,close}=await import('../src/sleeve-notes/db.js');
const {recoverLegacySegmentConversations,addLegacySegmentConversations}=await import('../src/sleeve-notes/legacy-segment-transcripts.js');
const at='2026-10-15T20:11:00.000Z',aired='2026-10-15T20:12:00.000Z';
const first='Band recorded the album in a converted barn.';
function fixture(db=new Database(':memory:')) {
 migrate(db);
 db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES('source','artist','artist','wikipedia','https://example.test','hash','bounded-text',?,'Source',?)`).run(first,at);
 for(const id of ['claim','other'])db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
 VALUES(?,'artist','artist','artist-stories',?,?,'source',?,?,?)`).run(id,id,first,first,at,at);
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,local_track_id,consumer,supplied_at,aired_at,tts_text)
 VALUES('use','claim','artist','artist','artist-stories','studio','local','sleeveNotesSegment',?,?,?)`).run(at,aired,first);
 return db;
}
const item=()=>({id:'use',consumer:'sleeveNotesSegment',airedAt:aired,spokenText:first,conversation:null as null|{complete:null;lines:Array<{speakerName:string;text:string}>}});
const turn=(text:string,ids:string[],speaker='Host',time=aired)=>({role:'segment',kind:'sleeve-notes',text,
 meta:{airedAt:time,sleeveNotesSegmentUseIds:ids,personaId:speaker.toLowerCase(),personaName:speaker}});
function session(){return {id:'sess_test',startedAt:at,endedAt:'2026-10-15T21:00:00.000Z',messages:[
 turn(first,['use']),turn('That is an unexpected place to record.',[],'Guest','2026-10-15T20:12:10.000Z'),
 turn('That detail caught my attention too.',[],'Host','2026-10-15T20:12:20.000Z')]};}

test('legacy recovery uses confirmed speaker-labelled turns and never a generated script',()=>{
 const db=fixture(),saved=item();recoverLegacySegmentConversations(db,[saved],[session()]);
 assert.equal(saved.conversation?.lines.length,3);assert.deepEqual(saved.conversation?.lines.map(line=>line.speakerName),['Host','Guest','Host']);
 assert.equal(saved.conversation?.complete,null);
 const unconfirmed=session();delete (unconfirmed.messages[1].meta as {airedAt?:string}).airedAt;
 const partial=item();recoverLegacySegmentConversations(db,[partial],[unconfirmed]);
 assert.equal(partial.conversation?.lines.length,1);assert.equal(partial.conversation?.lines[0].text,first);
 const mismatch=item();mismatch.airedAt='2026-10-15T20:13:00.000Z';recoverLegacySegmentConversations(db,[mismatch],[session()]);assert.equal(mismatch.conversation,null);
 const corrupt={messages:[null,{},turn(first,['missing'])]};const missing=item();recoverLegacySegmentConversations(db,[missing],[corrupt]);assert.equal(missing.conversation,null);db.close();
});

test('legacy recovery refuses adjacent exchanges from different supply batches or repeated use of the same claim',()=>{
 const db=fixture();
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,local_track_id,consumer,supplied_at,aired_at,tts_text)
 VALUES('next','other','artist','artist','artist-stories','next','local','sleeveNotesSegment','2026-10-15T20:14:00.000Z','2026-10-15T20:15:00.000Z','Another exchange.')`).run();
 const combined=session();combined.messages.push(turn('Another exchange.',['next'],'Host','2026-10-15T20:15:00.000Z'));
 let saved=item();recoverLegacySegmentConversations(db,[saved],[combined]);assert.equal(saved.conversation,null);
 db.prepare("UPDATE sleeve_claim_uses SET supplied_at=?,claim_id='claim' WHERE id='next'").run(at);
 saved=item();recoverLegacySegmentConversations(db,[saved],[combined]);assert.equal(saved.conversation,null);db.close();
});

test('read-only compatibility can recover from a saved current session or its archive without modifying the ledger',async()=>{
 const db=fixture(open());const before=db.prepare('SELECT * FROM sleeve_claim_uses').all();
 writeFileSync(join(root,'session.json'),JSON.stringify(session()));
 let shelf=await addLegacySegmentConversations({items:[item()]});assert.equal(shelf.items[0].conversation?.lines.length,3);
 writeFileSync(join(root,'session.json'),JSON.stringify({messages:[]}));mkdirSync(join(root,'sessions'));
 writeFileSync(join(root,'sessions','sess_test.json'),JSON.stringify(session()));
 shelf=await addLegacySegmentConversations({items:[item()]});assert.equal(shelf.items[0].conversation?.lines.length,3);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_claim_uses').all(),before);
});

test.after(async ()=>{close();await removeTempDir(root);});
