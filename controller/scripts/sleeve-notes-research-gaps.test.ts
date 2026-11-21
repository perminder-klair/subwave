import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate } from '../src/sleeve-notes/db.js';
import type { ResearchGapSnapshot } from '../src/schemas/sleeve-notes-research-gaps.js';
import { researchGapsInDatabase } from '../src/sleeve-notes/research-gaps.js';
const now = '2026-10-25T12:00:00.000Z';
function fixture() { const db = new Database(':memory:'); migrate(db); return db; }
function artist(db: Database.Database,id: string,name='Example Artist') {
  db.prepare('INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,name,id,now,now);
}
function library(db: Database.Database,name='Example Artist') {
  db.prepare('INSERT INTO sleeve_connection_library_artists(local_artist_id,name,name_key) VALUES(?,?,?)').run('local-'+name,name,name.toLowerCase());
}
function job(db: Database.Database,id: string,state: string,provider='wikipedia') {
  db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at)
    VALUES(?,?,'artist',?,?,?,?,?)`).run(id+provider,provider,id,provider==='wikipedia'?'biography':'extract-wikipedia',state,now,now);
}
function source(db: Database.Database,id: string) {
  db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
    VALUES(?,'artist',?,'wikipedia','https://en.wikipedia.org/wiki/Example',?,'bounded-text','Source passage about the artist.','Wikipedia',?)`).run(id+'source',id,id,now);
}
function story(db: Database.Database,id: string,category='artist-stories') {
  db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,evidence,source_document_id,created_at,updated_at)
    VALUES(?,'artist',?,?,'recording','The artist recorded an album in a barn.','The artist recorded an album in a barn.',?,?,?)`).run(id+'claim',id,category,id+'source',now,now);
}
function track(db: Database.Database,id: string,artistId: string,name='Example Artist') {
  db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES(?,'Song',?,'matched',?,?)`).run(id,artistId,now,now);
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,recording_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES(?,?,'Song',?,'matched',?,?,?)`).run(id,id,name,now,now,now);
}
function item(db: Database.Database) { return researchGapsInDatabase(db).items.find(i=>i.name==='Example Artist')!; }

test('a fresh library is unexplored, not a research error; scanning writes nothing',()=>{
  const db=fixture();library(db);
  const before=db.prepare('SELECT total_changes() n').get();
  const result=researchGapsInDatabase(db);
  assert.equal(result.counts.unexplored,1);assert.equal(result.counts.attention,0);
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(),before);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sleeve_research_jobs').get() as {n:number}).n,0);
  db.close();
});
test('a failed same-name duplicate does not hide a researched identity',()=>{
  const db=fixture();library(db);artist(db,'good');artist(db,'duplicate');source(db,'good');story(db,'good');track(db,'local','good');job(db,'duplicate','failed');
  assert.equal(item(db).status,'covered');assert.equal(item(db).storyCount,1);
  assert.equal(researchGapsInDatabase(db).counts.attention,0);db.close();
});
test('partially matched recordings expose an identity gap while preserving saved stories',()=>{
  const db=fixture();library(db);artist(db,'good');artist(db,'other');source(db,'good');story(db,'good');track(db,'local','good');track(db,'other-track','other');job(db,'other','failed');
  assert.equal(item(db).status,'partial-coverage');assert.equal(item(db).storyCount,1);
  assert.equal(item(db).identities.find(a=>a.id==='other')?.matchedTracks,1);
  assert.equal(item(db).identities.find(a=>a.id==='good')?.canRetry,false);
  assert.equal(item(db).identities.find(a=>a.id==='other')?.canRetry,true);db.close();
});
test('a failed biography remains a gap when album or track stories exist',()=>{
  const db=fixture();library(db);artist(db,'a');source(db,'a');story(db,'a','release-stories');
  // A release/recording source is not an artist biography.
  db.prepare("UPDATE sleeve_source_documents SET entity_type='recording'").run();job(db,'a','failed');
  assert.equal(item(db).status,'source-not-found');assert.equal(item(db).storyCount,1);db.close();
});
test('pending work is not an alert and resolved findings disappear on the next scan',()=>{
  const db=fixture();library(db);artist(db,'a');job(db,'a','failed');
  assert.equal(item(db).status,'source-not-found');
  db.prepare("UPDATE sleeve_research_jobs SET state='queued'").run();assert.equal(item(db).status,'pending');
  source(db,'a');story(db,'a');db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();
  assert.equal(item(db).status,'covered');assert.equal(researchGapsInDatabase(db).counts.attention,0);db.close();
});
test('saved articles with failed extraction differ from completed empty research',()=>{
  const db=fixture();library(db);artist(db,'a');source(db,'a');job(db,'a','failed','researcher');
  assert.equal(item(db).status,'extraction-failed');
  db.prepare("UPDATE sleeve_research_jobs SET state='complete'").run();assert.equal(item(db).status,'empty');
  assert.equal(researchGapsInDatabase(db).counts.attention,0);db.close();
});
test('operator-cancelled extraction is stopped, not pending or an alert',()=>{
  const db=fixture();library(db);artist(db,'a');source(db,'a');job(db,'a','cancelled','researcher');
  assert.equal(item(db).status,'stopped');assert.equal(researchGapsInDatabase(db).counts.attention,0);db.close();
});
test('withdrawn, deleted, held, credit and connection facts do not count as active narratives',()=>{
  for (const [column,value] of [['enabled',0],['operator_state','deleted'],['feedback_hold',1]] as const) {
    const db=fixture();library(db);artist(db,'a');source(db,'a');story(db,'a');db.prepare(`UPDATE sleeve_claims SET ${column}=?`).run(value);
    if(column==='feedback_hold') db.prepare('UPDATE sleeve_claims SET enabled=0,feedback_hold=1').run();
    assert.equal(item(db).storyCount,0,column);db.close();
  }
  for(const category of ['credits','musical-connections']) {
    const db=fixture();library(db);artist(db,'a');source(db,'a');story(db,'a',category);
    assert.equal(item(db).storyCount,0);db.close();
  }
});
test('performers on composer-filed tracks are included without merging their identities',()=>{
  const db=fixture();library(db,'Example Composer');artist(db,'performer','Example Performer');track(db,'local','performer','Example Composer');job(db,'performer','failed');
  const result=researchGapsInDatabase(db);
  assert.equal(result.items.find(i=>i.name==='Example Performer')?.status,'source-not-found');
  assert.equal(result.items.find(i=>i.name==='Example Composer')?.identities[0].name,'Example Performer');
  assert.equal(result.items.find(i=>i.name==='Example Composer')?.status,'related-credit');
  assert.equal(result.counts.attention,1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sleeve_artists').get() as {n:number}).n,1);db.close();
});
test('a performer failure cannot turn a saved composer biography into a partial identity error',()=>{
  const db=fixture();library(db,'Example Composer');artist(db,'composer','Example Composer');source(db,'composer');story(db,'composer');
  artist(db,'performer','Example Performer');track(db,'local','performer','Example Composer');job(db,'performer','failed');
  const result=researchGapsInDatabase(db);
  assert.equal(result.items.find(i=>i.name==='Example Composer')?.status,'covered');
  assert.equal(result.counts.attention,1);db.close();
});
test('a recording match can bridge an alias but a similar name cannot claim another biography',()=>{
  const db=fixture();library(db,'Stage Name');artist(db,'person','Personal Name');source(db,'person');story(db,'person');track(db,'local','person','Stage Name');
  assert.equal(researchGapsInDatabase(db).items.find(i=>i.name==='Stage Name')?.status,'covered');
  library(db,'Stage Names');assert.equal(researchGapsInDatabase(db).items.find(i=>i.name==='Stage Names')?.status,'unexplored');db.close();
});

test('Genius story links count through trusted local links even when the provider artist spelling differs',()=>{
  const db=fixture();library(db);artist(db,'canonical');artist(db,'provider','The Example Artist');track(db,'local','canonical');
  db.prepare("INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES('provider-recording','Song','provider','matched',?,?)").run(now,now);
  source(db,'provider');story(db,'provider');
  db.prepare("UPDATE sleeve_source_documents SET provider='genius',entity_type='recording',entity_id='provider-recording'").run();
  db.prepare("UPDATE sleeve_claims SET entity_type='recording',entity_id='provider-recording'").run();
  db.prepare("INSERT INTO sleeve_genius_local_tracks(local_track_id,recording_id) VALUES('local','provider-recording')").run();
  assert.equal(item(db).storyCount,1);assert.equal(item(db).status,'covered');
  db.prepare("UPDATE sleeve_local_attachments SET recording_id=NULL,match_state='unmatched'").run();
  assert.equal(item(db).storyCount,1,'a Genius story does not require a completed MusicBrainz match');db.close();
});

test('review API protects verification and preserves feature-off read-only browsing',async()=>{
  process.env.ADMIN_USER='coverage-test';process.env.ADMIN_PASS='coverage-password';
  const settings=await import('../src/settings.js');
  const store=await import('../src/sleeve-notes/db.js');
  const {clearConnectionComputeCache}=await import('../src/sleeve-notes/connection-compute.js');
  const {router}=await import('../src/routes/sleeve-notes.js');
  const {default:express}=await import('express');
  await settings.load();await settings.update({djBehaviour:{extendedSleeveNotes:true}});
  const db=store.open();library(db);artist(db,'route');job(db,'route','failed');
  const app=express();app.use(express.json(),router);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/sleeve-notes/research-gaps`;
  const headers={Authorization:`Basic ${Buffer.from('coverage-test:coverage-password').toString('base64')}`};
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(`${url}/verify`,{method:'POST'})).status,401);
    const response=await fetch(`${url}/verify`,{method:'POST',headers});assert.equal(response.status,200);
    assert.equal(((await response.json()) as ResearchGapSnapshot).counts.attention,1);
    assert.equal((await fetch(`${url}/scan`,{method:'POST'})).status,401);
    assert.equal((await fetch(`${url}/route/override`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({musicBrainzId:'bad',wikipediaUrl:''})})).status,400);
    assert.equal((await fetch(`${url}/route/override`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({musicBrainzId:'',wikipediaUrl:'https://en.wikipedia.org/wiki/Example'})})).status,200);
    assert.equal((await fetch(`${url}/route/rescan`,{method:'POST',headers})).status,200);
    assert.equal((await fetch(`${url}/scan`,{method:'POST',headers})).status,200);
    assert.equal((await fetch(`${url}/scan`,{method:'DELETE',headers})).status,200);
    await settings.update({djBehaviour:{extendedSleeveNotes:false}});
    assert.equal((await fetch(`${url}/verify`,{method:'POST',headers})).status,409);
    assert.equal((await fetch(`${url}/scan`,{method:'POST',headers})).status,409);
    assert.equal((await fetch(`${url}/scan`,{method:'DELETE',headers})).status,409);
    assert.equal((await fetch(`${url}/route/override`,{method:'PUT',headers})).status,409);
    assert.equal((await fetch(`${url}/route/rescan`,{method:'POST',headers})).status,409);
    assert.equal((await fetch(`${url}/scan`,{headers})).status,200);
    const before=db.prepare('SELECT total_changes() n').get();
    const cached=await fetch(url,{headers});assert.equal(cached.status,200);
    assert.equal(((await cached.json()) as ResearchGapSnapshot).items.length,1);
    assert.deepEqual(db.prepare('SELECT total_changes() n').get(),before);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));clearConnectionComputeCache();store.close();
  }
});
