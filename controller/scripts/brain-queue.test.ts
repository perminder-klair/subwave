import assert from 'node:assert/strict';
import test, {after,beforeEach,type TestContext} from 'node:test';
import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
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
const {getFullContext}=await import('../src/context.js');
const sleeveDb=await import('../src/sleeve-notes/db.js');
const app=express();app.use(express.json());app.use(router);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch=globalThis.fetch;
const slow={id:'slow',title:'Slow song',artist:'Pink Floyd',artistId:'floyd',album:'Album',albumId:'album',bpm:70,duration:200,isDir:false};
const fast={...slow,id:'fast',title:'Fast song',bpm:155};
let songs=[slow,fast];
Object.assign(queue, {persist: () => {}, drainToLiquidsoap: async () => {}});

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
    const body=endpoint==='search3'?{searchResult3:{artist:[{id:'floyd',name:'Pink Floyd'}]}}:endpoint==='getArtist'?{artist:{id:'floyd',name:'Pink Floyd',album:[{id:'album'}]}}
      :endpoint==='getAlbum'?{album:{id:'album',name:'Album',song:songs}}
        :endpoint==='getSong'?{song:[slow,fast].find(song=>song.id===url.searchParams.get('id'))}:{};
    return Response.json({'subsonic-response':{status:'ok',version:'1.16.1',...body}});
  });
});
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));library.shutdown();sleeveDb.close();await removeTempDir(state);});
async function submit(selection:unknown){
  const response=await realFetch(`${base}/dj/queue-track`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selection})});
  return {status:response.status,body:await response.json() as {track: typeof slow; reason: string}};
}

test('an exact track uses the operator path even if already queued and recently played',async()=>{
  await queue.push({track:slow,requestedBy:'studio',operator:true,allowDuplicate:true});
  queue.history=[{track:slow}] as never;
  const result=await submit({entityType:'library-track',entityId:slow.id});
  assert.equal(result.status,200);assert.equal(queue.upcoming.length,2);
  assert.equal(queue.upcoming[1].track.id,slow.id);
  assert.equal(queue.upcoming[1].requestedBy,'studio');assert.equal(queue.upcoming[1].operator,true);
  assert.equal(queue.pendingListenerRequests(),0);
});

test('artist choice follows the queued tail and does not reject a recently heard artist',async()=>{
  queue.upcoming=[{track:{...slow,id:'tail'},requestedBy:'studio'}] as never;
  queue.history=[{track:slow}] as never;
  const result=await submit({entityType:'library-artist',entityId:'floyd'});
  assert.equal(result.status,200);assert.equal(result.body.track.id,slow.id);
  assert.equal(queue.upcoming.at(-1)?.track.artist,'Pink Floyd');
});

test('album choice stays inside that album and gives a current mood preference',async()=>{
  const ctx=await getFullContext();
  library.set(fast.id,{...fast,moods:[ctx.dominantMood]});
  songs=[slow,fast,{...slow,id:'wrong-album',albumId:'other'}];
  const result=await submit({entityType:'library-album',entityId:'album'});
  assert.equal(result.status,200);assert.equal(result.body.track.id,fast.id);
  assert.match(result.body.reason,/Matches the current mood/);
});

test('artist candidates cannot escape to a different credited artist',async()=>{
  songs=[{...fast,artist:'Other artist',artistId:'other'},slow];
  const result=await submit({entityType:'library-artist',entityId:'floyd'});
  assert.equal(result.status,200);assert.equal(result.body.track.id,slow.id);
});

test('never-play tracks are excluded from automatic source choices and refused for exact choices',async()=>{
  await blocklist.add({type:'track',id:slow.id,name:slow.title});
  const exact=await submit({entityType:'library-track',entityId:slow.id});
  assert.equal(exact.status,409);assert.equal(queue.upcoming.length,0);
  const automatic=await submit({entityType:'library-album',entityId:'album'});
  assert.equal(automatic.status,200);assert.equal(automatic.body.track.id,fast.id);
});

test('an empty source cannot silently queue unrelated music',async()=>{
  songs=[];
  const result=await submit({entityType:'library-album',entityId:'album'});
  assert.equal(result.status,404);assert.equal(queue.upcoming.length,0);
});

test('external entities and malformed source requests are refused',async()=>{
  const result=await submit({entityType:'external-recording',entityId:'outside'});
  assert.equal(result.status,400);assert.equal(queue.upcoming.length,0);
});


test('a saved canonical artist resolves to the same library artist',async()=>{
  const db=sleeveDb.open(),now=new Date().toISOString();
  db.prepare('INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES (?,?,?,?)').run('canonical-floyd','Pink Floyd',now,now);
  const result=await submit({entityType:'artist',entityId:'canonical-floyd'});
  assert.equal(result.status,200);assert.equal(queue.upcoming.at(-1)?.track.artistId,'floyd');
});

test('a saved release group resolves through a confirmed library album',async()=>{
  const db=sleeveDb.open(),now=new Date().toISOString();
  db.prepare('INSERT INTO sleeve_recordings(id,title,match_state,created_at,updated_at) VALUES (?,?,?,?,?)').run('brain-queue-fixture-recording',slow.title,'matched',now,now);
  db.prepare('INSERT INTO sleeve_releases(id,title,musicbrainz_release_group_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('brain-queue-fixture-release','Album','group',now,now);
  db.prepare('INSERT INTO sleeve_recording_releases(recording_id,release_id) VALUES (?,?)').run('brain-queue-fixture-recording','brain-queue-fixture-release');
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,recording_id,title,artist,release_title,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(local_track_id) DO UPDATE SET recording_id=excluded.recording_id,release_title=excluded.release_title,match_state=excluded.match_state`).run(slow.id,'brain-queue-fixture-recording',slow.title,slow.artist,'Album','matched',now,now,now);
  const result=await submit({entityType:'release-group',entityId:'group'});
  assert.equal(result.status,200);assert.equal(queue.upcoming.at(-1)?.track.albumId,'album');
  db.prepare("UPDATE sleeve_local_attachments SET release_title='Different album' WHERE local_track_id=?").run(slow.id);
  queue.upcoming=[];
  const wrongAlbum=await submit({entityType:'release-group',entityId:'group'});
  assert.equal(wrongAlbum.status,404);assert.equal(queue.upcoming.length,0);
});


test('a canonical recording can queue its confirmed attachment without a relationship match',async()=>{
  const result=await submit({entityType:'recording',entityId:'brain-queue-fixture-recording'});
  assert.equal(result.status,200);assert.equal(queue.upcoming.at(-1)?.track.id,slow.id);
});
