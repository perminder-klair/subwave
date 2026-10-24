import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=createTempDir(join(tmpdir(),'subwave-connection-process-'));process.env.STATE_DIR=root;
const {open,close}=await import('../src/sleeve-notes/db.js');
const {cachedConnectionsOverview,clearConnectionComputeCache,stopConnectionCompute,reconcileConnectionsInBackground}=await import('../src/sleeve-notes/connection-compute.js');
const {buildConnectionLibraryPatch,publishConnectionLibraryPatch}=await import('../src/sleeve-notes/library-connections.js');
const db=open();const at='2026-10-20T10:00:00Z';
db.prepare(`INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES ('artist','Original name',?,?)`).run(at,at);
db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES ('recording','Song','artist','matched',?,?)`).run(at,at);
db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,recording_id,title,artist,match_state,first_encountered_at,last_encountered_at,updated_at)
 VALUES ('local','recording','Song','Original name','matched',?,?,?)`).run(at,at,at);

test('the real read-only child shares reads, uses WAL snapshots and invalidates restored equal revisions',async()=>{
 const before=db.prepare('SELECT * FROM sleeve_connection_revisions').get();
 const first=cachedConnectionsOverview([], 'overview',true,db);
 assert.equal(cachedConnectionsOverview([], 'overview',false,db),first,'identical readers share one IPC request');
 const json=await first;assert.match(json,/Original name/);
 assert.deepEqual(db.prepare('SELECT * FROM sleeve_connection_revisions').get(),before,'the child must not write');
 assert.equal(await cachedConnectionsOverview([], 'overview',false,db),json);
 const revision=db.prepare('SELECT * FROM sleeve_connection_revisions').get() as {facts:number;overview:number};
 db.prepare("UPDATE sleeve_artists SET name='Restored name'").run();
 db.prepare('UPDATE sleeve_connection_revisions SET facts=?,overview=?').run(revision.facts,revision.overview);
 clearConnectionComputeCache();
 const restored=await cachedConnectionsOverview([], 'overview',false,db);
 assert.match(restored,/Restored name/);assert.doesNotMatch(restored,/Original name.*Original name/);
 assert.ok(await cachedConnectionsOverview([], 'discoveries',true,db));
});

test('stopping an outstanding child rejects readers and the next calculation recovers',async()=>{
 clearConnectionComputeCache();
 const pending=cachedConnectionsOverview([], 'overview',true,db);
 const rejected=assert.rejects(pending,/stopped/);stopConnectionCompute();await rejected;
 assert.match(await cachedConnectionsOverview([], 'overview',true,db),/Restored name/);
});

test('a patch calculated before a facts change cannot overwrite current matches',async()=>{
 const stale=buildConnectionLibraryPatch(db);
 db.prepare("UPDATE sleeve_recordings SET title='New title'").run();
 assert.equal(publishConnectionLibraryPatch(db,stale),false);
 assert.equal(typeof await reconcileConnectionsInBackground(db),'number');
});

test.after(async ()=>{clearConnectionComputeCache();close();await removeTempDir(root);});
