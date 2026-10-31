import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
const root=createTempDir(join(tmpdir(),'notes-backup-'));
process.env.STATE_DIR=root;delete process.env.ADMIN_USER;delete process.env.ADMIN_PASS;
const notes=await import('../src/sleeve-notes/db.js');
const {buildBackupZip,BACKUP_FORMAT,BACKUP_VERSION}=await import('../src/backup/zip.js');
const {router}=await import('../src/routes/backup.js');
const {listen}=await import('./test-utils/http.js');
const app=express();app.use(router);const {server,url}=await listen(app);server.unref();
const restore=async(zip:AdmZip)=>{
 const response=await fetch(url+'/backup/import',{method:'POST',body:new Uint8Array(zip.toBuffer())});
 return {status:response.status,body:await response.json() as {restored:string[]}};
};
const archive=()=>{const zip=new AdmZip();zip.addFile('manifest.json',Buffer.from(JSON.stringify({format:BACKUP_FORMAT,version:BACKUP_VERSION})));return zip;};

test('disabled research is included as a WAL-safe snapshot and restores corrections, feedback, conversations and jobs',async()=>{
 const db=notes.open();db.pragma('wal_autocheckpoint=0');const at='2026-10-16T10:00:00Z';
 db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
  VALUES ('s','artist','a','wikipedia','https://example.test','hash','bounded-text','Original evidence','Source',?)`).run(at);
 db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,operator_state,created_at,updated_at)
  VALUES ('c','artist','a','artist-stories','origin','Operator correction','s','Original evidence','approved',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_claim_uses(id,claim_id,entity_type,entity_id,category,topic,supplied_at,aired_at,offered_wording,segment_id)
  VALUES ('u','c','artist','a','artist-stories','origin',?,?,'Historic wording','segment')`).run(at,at);
 db.prepare(`INSERT INTO sleeve_spark_feedback(use_id,story,delivery,note,actor,created_at,updated_at)
  VALUES ('u','good','worked','Useful feedback','operator',?,?)`).run(at,at);
 db.prepare(`INSERT INTO sleeve_segment_lines VALUES ('segment',0,1,'host','Host','Confirmed speech',?)`).run(at);
 db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at)
  VALUES ('job','researcher','artist','a','extract-wikipedia','queued',?,?)`).run(at,at);
 assert.ok(existsSync(notes.DB_PATH+'-wal'));
 db.prepare(`INSERT INTO sleeve_airing_reviews(id,airing_key,use_id,state,context_json,created_at,updated_at)
  VALUES ('review','segment:segment','u','queued','{}',?,?)`).run(at,at);
 const tables=['sleeve_airing_reviews','sleeve_source_documents','sleeve_claims','sleeve_claim_uses','sleeve_spark_feedback','sleeve_segment_lines','sleeve_research_jobs'];
 const before=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
 const zip=await buildBackupZip();assert.ok(zip.getEntry('sleeve-notes.db'));
 assert.ok(!zip.getEntry('sleeve-notes.db-wal'));
 const snapshot=join(root,'snapshot.db');writeFileSync(snapshot,zip.getEntry('sleeve-notes.db')!.getData());
 const reader=new Database(snapshot,{readonly:true});assert.equal((reader.prepare('SELECT wording FROM sleeve_claims').get() as {wording:string}).wording,'Operator correction');reader.close();
 db.prepare("UPDATE sleeve_claims SET wording='Changed later'").run();
 db.prepare('DELETE FROM sleeve_spark_feedback').run();
 const result=await restore(zip);assert.equal(result.status,200);assert.ok(result.body.restored.includes('sleeve-notes.db'));
 assert.deepEqual(tables.map(table=>notes.open().prepare(`SELECT * FROM ${table}`).all()),before);
 assert.deepEqual(notes.open().pragma('foreign_key_check'),[]);
});

test('older archives without research leave the current collection intact',async()=>{
 const result=await restore(archive());assert.equal(result.status,200);
 assert.ok(!result.body.restored.includes('sleeve-notes.db'));
 assert.equal((notes.open().prepare('SELECT COUNT(*) AS n FROM sleeve_claims').get() as {n:number}).n,1);
});

test('invalid and future research databases refuse the restore before changing media or settings',async()=>{
 for(const future of [false,true]) {
  const zip=archive();let bytes=Buffer.from('not sqlite');
  if(future){const path=join(root,'future.db');const db=new Database(path);db.exec('CREATE TABLE entities(id TEXT)');db.pragma('user_version=999');db.close();bytes=readFileSync(path);}
  zip.addFile('sleeve-notes.db',bytes);zip.addFile('voices/should-not-land.wav',Buffer.from('audio'));
  const result=await restore(zip);assert.equal(result.status,400);
  assert.equal(existsSync(join(root,'voices/should-not-land.wav')),false);
  assert.equal((notes.open().prepare('SELECT wording FROM sleeve_claims').get() as {wording:string}).wording,'Operator correction');
 }
});

test('restore refuses active research before applying media and prevents new jobs during the swap',async()=>{
 let finish!:(value:boolean)=>void;
 const work=notes.runResearchDatabaseWork(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
 try {
  const zip=await buildBackupZip();zip.addFile('voices/busy-restore.wav',Buffer.from('audio'));
  assert.equal((await restore(zip)).status,409);
  assert.equal(existsSync(join(root,'voices/busy-restore.wav')),false);
 } finally {finish(true);await work;}
 const release=notes.acquireResearchRestore();assert.ok(release);
 let ran=false;
 try {assert.equal(await notes.runResearchDatabaseWork(async()=>{ran=true;return true;}),false);assert.equal(ran,false);}
 finally {release();}
});

test('restored running jobs return to the queue instead of remaining stranded',async()=>{
 notes.open().prepare("UPDATE sleeve_research_jobs SET state='running' WHERE id='job'").run();
 notes.open().prepare("UPDATE sleeve_airing_reviews SET state='running',lease_token='interrupted' WHERE id='review'").run();
 const result=await restore(await buildBackupZip());assert.equal(result.status,200);
 assert.deepEqual(notes.open().prepare("SELECT state,lease_token FROM sleeve_airing_reviews WHERE id='review'").get(),{state:'queued',lease_token:null});
 assert.equal((notes.open().prepare("SELECT state FROM sleeve_research_jobs WHERE id='job'").get() as {state:string}).state,'queued');
});

test('exporting an older disabled cache never migrates the source database',async()=>{
 notes.close();
 const old=new Database(notes.DB_PATH);old.exec('DROP TABLE sleeve_segment_lines');old.pragma('user_version=52');old.close();
 const zip=await buildBackupZip();
 const unchanged=new Database(notes.DB_PATH,{readonly:true});
 assert.equal(unchanged.pragma('user_version',{simple:true}),52);
 assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_segment_lines'").get(),undefined);unchanged.close();
 assert.equal((await restore(zip)).status,400, 'an experimental export is preserved but cannot be restored into the public schema');
});

test.after(async ()=>{server.closeAllConnections();server.close();notes.close();await removeTempDir(root);});
