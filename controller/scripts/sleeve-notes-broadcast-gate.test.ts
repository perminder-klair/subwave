import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-research-broadcast-gate-'));
process.env.STATE_DIR = root;
const { queue } = await import('../src/broadcast/queue.js');
const { researchRunAllowed } = await import('../src/sleeve-notes/research-policy.js');
after(async () => await removeTempDir(root));

test('rendered speech waiting for a boundary leaves research available while active broadcast work still blocks it', t => {
  // Exercise the real queue methods without starting a watcher, mixer or TTS.
  const waiting = Object.create(Object.getPrototypeOf(queue));
  waiting.senderBusy = false;
  waiting.pickerBusy = false;
  waiting._introRenders = { busy: () => false };
  waiting._pendingVoice = { kind: 'station-id', t: 1234 };
  const allowed = () => researchRunAllowed({ playbackCriticalBusy: waiting.playbackCriticalBusy(),
    agentWorkActive: false, djCallsAllowed: true, pauseWhenEmpty: true,
    maintenanceWhenEmpty: false, listenerCount: 1 });
  assert.equal(allowed(), true, 'a deferred ident must not starve Genius or LLM research');
  assert.deepEqual(waiting.pendingVoiceTalk(), { kind: 'station-id', queuedAt: 1234 }, 'speech remains pending for normal delivery');
  waiting.senderBusy = true; assert.equal(allowed(), false);
  waiting.senderBusy = false; waiting.pickerBusy = true; assert.equal(allowed(), false);
  waiting.pickerBusy = false;
  t.mock.method(waiting._introRenders, 'busy', () => true);
  assert.equal(allowed(), false, 'active TTS rendering retains priority');
});

test('disabled Sleeve Notes drops a waiting segment without touching ordinary station speech',async()=>{
 const settings=await import('../src/settings.js');
 const store=await import('../src/settings/store.js');
 const saved=settings.get();
 store.setCache({...saved,djBehaviour:{...saved.djBehaviour,extendedSleeveNotes:false}});
 try {
  const waiting=Object.create(Object.getPrototypeOf(queue));
  waiting.log=()=>{};
  let result:boolean|undefined;
  waiting._pendingVoice={kind:'sleeve-notes',clips:[],onCompleted:(aired:boolean)=>{result=aired;}};
  await waiting.airPendingVoice();
  assert.equal(waiting._pendingVoice,null);
  assert.equal(result,false);
  assert.equal(waiting.holdForNextTrack('sleeve-notes',[{meta:{}}]),false);
  assert.equal(waiting._pendingVoice,null);
 }finally{store.setCache(saved);}
});
