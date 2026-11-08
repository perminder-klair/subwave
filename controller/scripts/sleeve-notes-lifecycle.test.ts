import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, {after,beforeEach,type TestContext} from 'node:test';
import {rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';

const state=createTempDir(join(tmpdir(),'subwave-brain-queue-'));
process.env.STATE_DIR=state;
process.env.NAVIDROME_URL='http://brain-library.invalid';
delete process.env.ADMIN_USER;delete process.env.ADMIN_PASS;
const express=(await import('express')).default;
const {router}=await import('../src/routes/dj.js');
const {queue}=await import('../src/broadcast/queue.js');
const library=await import('../src/music/library.js');
const blocklist=await import('../src/music/blocklist.js');
const settings=await import('../src/settings.js');
const sleeveDb=await import('../src/sleeve-notes/db.js');
const app=express();app.use(express.json());app.use(router);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch=globalThis.fetch;
const slow={id:'slow',title:'Slow song',artist:'Pink Floyd',artistId:'floyd',album:'Album',albumId:'album',bpm:70,duration:200,isDir:false};
const fast={...slow,id:'fast',title:'Fast song',bpm:155};
let songs=[slow,fast];
let pauseLookup=false; let releaseLookup:()=>void; let lookupStarted:()=>void;
const quietQueue=queue as unknown as {persist:()=>void;drainToLiquidsoap:()=>Promise<void>};
quietQueue.persist=()=>{};
quietQueue.drainToLiquidsoap=async()=>{};

beforeEach(async context=>{
  const t=context as TestContext;
  await settings.load();await settings.update({tts:{enabled:false},djBehaviour:{extendedSleeveNotes:true}} as never);
  await library.load();await blocklist.load();
  for(const entry of blocklist.list())await blocklist.remove(entry.type,entry.id);
  queue.upcoming=[];queue.history=[];queue.current={track:{...fast,id:'on-air'}} as never;
  songs=[slow,fast];
  library.set(slow.id,{...slow,moods:[]});library.set(fast.id,{...fast,moods:[]});
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.origin===base)return realFetch(input,init);
    if(url.hostname!=='brain-library.invalid')throw new Error('No live network in queue tests');
    const endpoint=url.pathname.split('/').at(-1);
    if(endpoint==='getSong' && pauseLookup){lookupStarted();await new Promise<void>(resolve=>{releaseLookup=resolve;});}
    const body=endpoint==='search3'?{searchResult3:{artist:[{id:'floyd',name:'Pink Floyd'}]}}:endpoint==='getArtist'?{artist:{id:'floyd',name:'Pink Floyd',album:[{id:'album'}]}}
      :endpoint==='getAlbum'?{album:{id:'album',name:'Album',song:songs}}
        :endpoint==='getSong'?{song:[slow,fast].find(song=>song.id===url.searchParams.get('id'))}:{};
    return Response.json({'subsonic-response':{status:'ok',version:'1.16.1',...body}});
  });
});
after(async ()=>{server.close();library.shutdown();sleeveDb.close();await removeTempDir(state);});
async function submit(selection:unknown){
  const response=await realFetch(`${base}/dj/queue-track`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selection})});
  return {status:response.status,body:await response.json()};
}


test('disabling Sleeve Notes during selection prevents final queue insertion',async()=>{
  const started=new Promise<void>(resolve=>{lookupStarted=resolve;});pauseLookup=true;
  const request=submit({entityType:'library-track',entityId:slow.id});await started;
  const store=await import('../src/settings/store.js');const current=settings.get();
  store.setCache({...current,djBehaviour:{...current.djBehaviour,extendedSleeveNotes:false}});
  releaseLookup();const response=await request;pauseLookup=false;
  assert.equal(response.status,409);assert.equal(queue.upcoming.length,0);
});
test('hourly cleanup must not create a research database while disabled',async t=>{
  const store=await import('../src/settings/store.js');const current=settings.get();
  store.setCache({...current,djBehaviour:{...current.djBehaviour,extendedSleeveNotes:false}});
  sleeveDb.close();rmSync(sleeveDb.DB_PATH,{force:true});let cleanup:(()=>void)|undefined;let quiet=false;
  t.mock.method(globalThis,'setInterval',((callback:()=>void,delay:number)=>{
    if(delay===60*60*1000)cleanup=callback;return {unref(){return this;}};
  }) as unknown as typeof setInterval);
  const {startResearchWorker}=await import('../src/sleeve-notes/research-worker.js');startResearchWorker({isQuiet:()=>quiet});
  assert.ok(cleanup);assert.equal(existsSync(sleeveDb.DB_PATH),false);cleanup();
  assert.equal(existsSync(sleeveDb.DB_PATH),false);
  const {default:Database}=await import('better-sqlite3');
  const old=new Database(sleeveDb.DB_PATH);sleeveDb.migrate(old);old.pragma('user_version=45');old.close();
  const {readFileSync}=await import('node:fs');const before=readFileSync(sleeveDb.DB_PATH);
  cleanup();assert.deepEqual(readFileSync(sleeveDb.DB_PATH),before,'disabled cleanup must not migrate an older cache');
  const restored=sleeveDb.acquireResearchRestore();assert.ok(restored);
  try {
    store.setCache({...current,djBehaviour:{...current.djBehaviour,extendedSleeveNotes:true}});quiet=true;
    cleanup();assert.deepEqual(readFileSync(sleeveDb.DB_PATH),before,'restore must prevent maintenance from opening the cache');
  }finally{restored();}
  rmSync(sleeveDb.DB_PATH, {force:true});
});
test('different Japanese recording titles must not match',async()=>{
  const {selectGeniusSearchHit}=await import('../src/sleeve-notes/genius.js');
  const result=selectGeniusSearchHit({response:{hits:[{result:{id:99,title:'夏',url:'https://genius.test/99',primary_artist:{name:'Band'}}}]}},{kind:'track',title:'春',artist:'Band'});
  assert.equal(result,null);
});
test('artist population prevents restore while library HTTP is in flight',async t=>{
  let releaseIndex:()=>void=()=>{};let markStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{markStarted=resolve;});
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0])=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.hostname!=='brain-library.invalid')throw new Error('No live network');
    const endpoint=url.pathname.split('/').at(-1);
    if(endpoint==='getArtists'){markStarted();await new Promise<void>(resolve=>{releaseIndex=resolve;});}
    return Response.json({'subsonic-response':{status:'ok',version:'1.16.1',...(endpoint==='getScanStatus'?{scanStatus:{scanning:false}}:{artists:{index:[{artist:[{id:'old-library',name:'Old library artist'}]}]}})}});
  });
  const {populateBrainArtists}=await import('../src/sleeve-notes/brain-library.js');
  const population=populateBrainArtists();await started;
  const releaseRestore=sleeveDb.acquireResearchRestore();
  try {assert.equal(releaseRestore,null);}finally{releaseRestore?.();releaseIndex();await population;}
});

test('artist population discards a response after disable and re-enable, then permits a fresh attempt',async t=>{
  const store=await import('../src/settings/store.js');
  const {populateBrainArtists}=await import('../src/sleeve-notes/brain-library.js');
  let release:()=>void=()=>{};let entered:()=>void=()=>{};let wait=true;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0])=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.hostname!=='brain-library.invalid')throw new Error('Unexpected network');
    if(url.pathname.endsWith('/getArtists')&&wait){entered();await new Promise<void>(resolve=>{release=resolve;});}
    return Response.json({'subsonic-response':{status:'ok',scanStatus:{scanning:false},artists:{index:[{artist:[{id:'fresh',name:'Fresh artist'}]}]}}});
  });
  const before=sleeveDb.open().prepare('SELECT * FROM sleeve_connection_library_artists').all();
  const result=populateBrainArtists();const rejected=assert.rejects(result,/interrupted/);await started;
  const current=settings.get();
  store.setCache({...current,djBehaviour:{...current.djBehaviour,extendedSleeveNotes:false}});
  store.setCache(current);release();await rejected;
  assert.deepEqual(sleeveDb.open().prepare('SELECT * FROM sleeve_connection_library_artists').all(),before);
  wait=false;assert.equal((await populateBrainArtists()).artists,1);
  const unlock=sleeveDb.acquireResearchRestore();assert.ok(unlock);
  try {await assert.rejects(populateBrainArtists(),/restore/);}finally{unlock();}
});

test('automatic population does not open the cache during restore or busy broadcast work',async t=>{
 sleeveDb.close();rmSync(sleeveDb.DB_PATH,{force:true});
 const {startBrainArtistPopulation}=await import('../src/sleeve-notes/brain-library.js');
 let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw new Error('No catalogue calls expected');});
 t.mock.method(globalThis,'setInterval',(()=>({unref(){return this;}})) as unknown as typeof setInterval);
 startBrainArtistPopulation({isQuiet:()=>false});
 const unlock=sleeveDb.acquireResearchRestore();assert.ok(unlock);
 try {
  startBrainArtistPopulation({isQuiet:()=>true});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(existsSync(sleeveDb.DB_PATH),false);assert.equal(requests,0);
 }finally{unlock();}
});

test('a blocklist change during Station Brain lookup is enforced by the final queue boundary',async()=>{
 const started=new Promise<void>(resolve=>{lookupStarted=resolve;});pauseLookup=true;
 const request=submit({entityType:'library-track',entityId:slow.id});await started;
 try {
  await blocklist.add({type:'track',id:slow.id,name:slow.title});releaseLookup();
  assert.equal((await request).status,409);assert.equal(queue.upcoming.length,0);
 }finally{releaseLookup();pauseLookup=false;}
});

test('master off refuses Station Brain selection while ordinary Library queueing still works',async()=>{
 await settings.update({djBehaviour:{extendedSleeveNotes:false}});
 assert.equal((await submit({entityType:'library-track',entityId:slow.id})).status,409);
 assert.equal(queue.upcoming.length,0);
 const response=await realFetch(`${base}/dj/queue-track`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(slow)});
 assert.equal(response.status,200);assert.equal(queue.upcoming.at(-1)?.track.id,slow.id);
 assert.equal(queue.pendingListenerRequests(),0);
});
