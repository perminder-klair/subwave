import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=createTempDir(join(tmpdir(),'subwave-notes-medium-'));
process.env.STATE_DIR=root;
const settings=await import('../src/settings.js');
const store=await import('../src/settings/store.js');
const {open,close}=await import('../src/sleeve-notes/db.js');
const {searchResearchStoriesInDatabase,researchStoreReadoutInDatabase,researchStoreSummaryInDatabase}=await import('../src/sleeve-notes/research-repository.js');
const {heardOnAir}=await import('../src/sleeve-notes/heard-on-air.js');
const db=open();
const at='2026-10-16T10:00:00.000Z';
db.prepare(`INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('artist','Example Band',?,?)`).run(at,at);
db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
 VALUES ('source','artist','artist','wikipedia','https://example.test','hash','bounded-text','Source','Wikipedia',?)`).run(at);
const claim=db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,created_at,updated_at)
 VALUES (?,'artist','artist','artist-stories',?,?,'source','Evidence',?,?)`);
for(let i=0;i<105;i++)claim.run(`claim-${String(i).padStart(3,'0')}`,`topic-${i}`,i===0?'A forgotten converted barn recording.':`Saved story ${i}`,at,new Date(Date.parse(at)+i*1000).toISOString());

test('search finds older stories outside the recent window and pages the full collection',()=>{
 assert.equal(searchResearchStoriesInDatabase(db,{search:'converted barn'}).total,1);
 assert.equal(searchResearchStoriesInDatabase(db,{search:'converted barn',recent:true}).total,0);
 const first=searchResearchStoriesInDatabase(db,{search:'Example Band',limit:30});
 const next=searchResearchStoriesInDatabase(db,{search:'Example Band',limit:30,offset:30});
 assert.equal(first.total,105);assert.equal(first.claims.length,30);assert.equal(next.claims.length,30);
 assert.equal(new Set([...first.claims,...next.claims].map(row=>row.id)).size,60);
 assert.equal(searchResearchStoriesInDatabase(db,{category:'credits'}).total,0);
 assert.equal(searchResearchStoriesInDatabase(db,{search:"%' OR 1=1"}).total,0);
});

test('saved knowledge counts and filters separate stories, connections and credits',()=>{
 db.exec('SAVEPOINT knowledge_counts');
 try {
  db.prepare("UPDATE sleeve_claims SET category='musical-connections' WHERE id='claim-001'").run();
  db.prepare("UPDATE sleeve_claims SET category='credits' WHERE id='claim-002'").run();
  db.prepare("UPDATE sleeve_claims SET enabled=0 WHERE id='claim-003'").run();
  const summary=researchStoreSummaryInDatabase(db);
  assert.equal(summary.storyClaims,102);
  assert.equal(summary.connectionClaims,1);
  assert.equal(summary.creditClaims,1);
  assert.equal(summary.retainedClaims,104);
  const stories=searchResearchStoriesInDatabase(db,{category:'stories-only'});
  assert.equal(stories.total,102);
  assert.ok(stories.claims.every(row=>!['credits','musical-connections'].includes(row.category)));
  assert.equal(searchResearchStoriesInDatabase(db,{category:'musical-connections'}).total,1);
  assert.equal(searchResearchStoriesInDatabase(db,{category:'credits'}).total,1);
 } finally { db.exec('ROLLBACK TO knowledge_counts; RELEASE knowledge_counts'); }
});

test('conversation pagination includes all its stories once and preserves independent feedback IDs',()=>{
 const insert=db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,supplied_at,offered_wording,
 detection_status,aired_at,tts_text,tts_rendered_at,speech_signal,segment_id,consumer)
 VALUES (?,?,'artist','artist','artist-stories','topic',?,'Offered','detected',?,'Spoken',?, ?,?,'sleeveNotesSegment')`);
 const signal=JSON.stringify({version:2,status:'detected'});
 for(let i=0;i<3;i++)for(let j=0;j<4;j++)insert.run(`use-${i}-${j}`,`claim-00${j}`,at,new Date(Date.parse(at)+i*1000).toISOString(),at,signal,`segment-${i}`);
 const first=heardOnAir(1,0,true),next=heardOnAir(1,1,true);
 assert.equal(first.total,12);assert.equal(first.conversationTotal,3);assert.equal(first.items.length,4);
 assert.deepEqual(new Set(first.items.map(item=>item.segmentId)),new Set(['segment-2']));
 assert.deepEqual(new Set(next.items.map(item=>item.segmentId)),new Set(['segment-1']));
 assert.equal(new Set(first.items.map(item=>item.id)).size,4);
 const readout=researchStoreReadoutInDatabase(db);
 assert.equal(readout.recentSparks.length,12,'recent activity must not truncate a conversation at ten individual offers');
 assert.equal(new Set(readout.recentSparks.map(spark=>spark.segmentId)).size,3);
});

test('collection pause survives a cold load, blocks workers and leaves on-air use enabled',async()=>{
 await settings.load();
 await settings.update({djBehaviour:{extendedSleeveNotes:true,sleeveNotesCollectionPaused:true}});
 store.setCache(null);await settings.load();
 assert.equal(settings.get().djBehaviour.extendedSleeveNotes,true);
 assert.equal(settings.get().djBehaviour.sleeveNotesCollectionPaused,true);
 const {MusicBrainzMatchWorker}=await import('../src/sleeve-notes/musicbrainz-worker.js');
 let checkedQuiet=false;
 const worker=new MusicBrainzMatchWorker({isQuiet:()=>{checkedQuiet=true;return true;}},{lookup:async()=>{throw new Error('Paused worker must not call provider');}});
 assert.equal(await worker.runOnce(),false);assert.equal(checkedQuiet,false,'pause is checked before scheduling work');
 assert.equal(searchResearchStoriesInDatabase(db).total,105,'the saved collection remains readable');
 db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES ('recording','Song','artist','matched',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,recording_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
 VALUES ('local','recording','Song','Example Band','matched',?,?,?)`).run(at,at,at);
 const {eligibleSleeveNotesForSegmentInDatabase}=await import('../src/sleeve-notes/link-selection.js');
 assert.ok(eligibleSleeveNotesForSegmentInDatabase(db,'local','Example Band',Date.now(),true).length>0,'cached Sparks remain eligible while collection is paused');
 await settings.update({djBehaviour:{sleeveNotesCollectionPaused:false}});
 assert.equal(settings.get().djBehaviour.extendedSleeveNotes,true);
 assert.equal(settings.get().djBehaviour.sleeveNotesCollectionPaused,false);
});

test.after(async ()=>{close();await removeTempDir(root);});
