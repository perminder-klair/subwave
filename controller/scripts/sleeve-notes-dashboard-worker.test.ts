// Run: npm test -- sleeve-notes-dashboard-worker
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { migrate } from '../src/sleeve-notes/db.js';
import { cachedDashboardRead, clearConnectionComputeCache } from '../src/sleeve-notes/connection-compute.js';
import { dashboardReadInDatabase, type DashboardRead } from '../src/sleeve-notes/dashboard-reads.js';

const root = createTempDir(join(tmpdir(), 'sleeve-dashboard-worker-'));
const path = join(root, 'notes.db');
const db = new Database(path);
migrate(db);
const now = new Date().toISOString();
db.prepare(`INSERT INTO sleeve_artists (id,name,created_at,updated_at) VALUES ('artist','Band',?,?)`).run(now,now);
for (let i=0;i<3;i++) db.prepare(`INSERT INTO sleeve_source_documents
  (id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
  VALUES (?,'artist','artist','wikipedia',?,'hash','bounded-text','A story.','Wiki',?)`).run(`source${i}`,`https://example.test/${i}`,now);
for (let i=0;i<5;i++) db.prepare(`INSERT INTO sleeve_claims
  (id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,enabled,created_at,updated_at)
  VALUES (?,'artist','artist','artist-stories',?,'A story.','source0','A story.',?,?,?)`).run(`claim${i}`,`topic${i}`,i===4?0:1,now,now);

test.after(async () => { clearConnectionComputeCache(); db.close(); await removeTempDir(root); });

test('worker reads match direct results, count sources/facts independently, and do not write', async () => {
  const before = readFileSync(path);
  const inputs: DashboardRead[] = [
    {kind:'readout'}, {kind:'readout',queue:false}, {kind:'live-summary',args:[{subsonic_id:'track',title:'Song',artist:'Band'},null,null]},
    {kind:'heard-on-air',offset:0,filters:{usage:'sleeve-notes'}},
  ];
  for(const input of inputs) {
    assert.deepEqual(JSON.parse(await cachedDashboardRead(input,db)),dashboardReadInDatabase(db,input));
  }
  const result=JSON.parse(await cachedDashboardRead({kind:'readout'},db));
  assert.deepEqual(result.artists,[{name:'Band',musicbrainzId:null,sources:3,claims:4}]);
  assert.deepEqual(readFileSync(path),before);
});

test('concurrent tabs share one calculation, own writes invalidate, and reads yield to timers', async () => {
  clearConnectionComputeCache();
  const first=cachedDashboardRead({kind:'readout'},db);
  assert.equal(cachedDashboardRead({kind:'readout'},db),first);
  let timerRan=false;
  const timer=setTimeout(()=>{timerRan=true;},0);
  const old=JSON.parse(await first);
  clearTimeout(timer);
  assert.equal(timerRan,true,'controller timers must run while the worker calculates');
  db.prepare("UPDATE sleeve_claims SET enabled=1 WHERE id='claim4'").run();
  const fresh=JSON.parse(await cachedDashboardRead({kind:'readout'},db));
  assert.equal(old.artists[0].claims,4);
  assert.equal(fresh.artists[0].claims,5);
});

test('a missing worker database fails without being created and later reads can recover', async () => {
  clearConnectionComputeCache();
  const gone=new Database(join(root,'gone.db'));
  migrate(gone);
  unlinkSync(gone.name);
  try {
    await assert.rejects(cachedDashboardRead({kind:'readout'},gone), /exist|open/i);
    assert.equal(existsSync(gone.name),false);
  } finally { gone.close(); }
  assert.equal(JSON.parse(await cachedDashboardRead({kind:'readout'},db)).artists[0].claims,5);
});

test('external changes expire after three seconds and restore clears display caches', async (t) => {
  clearConnectionComputeCache();
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const input={kind:'readout'} as const;
  const old=await cachedDashboardRead(input,db);
  const other=new Database(path);
  try { other.prepare("UPDATE sleeve_artists SET name='Renamed' WHERE id='artist'").run(); }
  finally { other.close(); }
  assert.equal(await cachedDashboardRead(input,db),old);
  t.mock.timers.tick(3_001);
  assert.equal(JSON.parse(await cachedDashboardRead(input,db)).artists[0].name,'Renamed');
  clearConnectionComputeCache();
  assert.equal(JSON.parse(await cachedDashboardRead(input,db)).artists[0].name,'Renamed');
});

test('live reads send only required fields, excluding unrelated queue data and callbacks', async () => {
  clearConnectionComputeCache();
  const track={id:'track',title:'Song',artist:'Band',unrelated:()=>{throw new Error('not display data');}};
  const current={track,introScript:'A DJ line.',unrelated:()=>{throw new Error('not display data');}};
  const input={kind:'live-summary',args:[track,current,null]} satisfies DashboardRead;
  const read=cachedDashboardRead(input,db);
  assert.equal(cachedDashboardRead({kind:'live-summary',args:[{id:'track',title:'Song',artist:'Band'},{track:{id:'track',title:'Song',artist:'Band'},introScript:'A DJ line.'},null]},db),read);
  assert.equal(JSON.parse(await read).onAir.djLine,'A DJ line.');
});
