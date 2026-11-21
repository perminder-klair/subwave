import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planSpeechBudget,fitsSpeechBudget,fitsSpeechDeadline,speechBudgetPrompt} from '../src/broadcast/speech-budget.js';
const root=mkdtempSync(join(tmpdir(),'subwave-speech-budget-'));process.env.STATE_DIR=root;
const input={nowMs:0,remainingSeconds:60,crossfadeSeconds:0,writingSeconds:5,generationWps:3.12,spokenWps:3.49,
 castSize:1,maxWords:140,trackId:'track',startedAt:'start'};

test('word targets account for rendering and speaking sequentially, writing and safety overhead',()=>{
 const budget=planSpeechBudget(input);
 assert.equal(budget.maxWords,74);
 assert.ok(fitsSpeechBudget(budget,74,1,5000));
 assert.equal(fitsSpeechBudget(budget,74,1,10000),false,'slow writing must consume the remaining budget');
 assert.ok(planSpeechBudget({...input,remainingSeconds:120}).maxWords>budget.maxWords);
 assert.equal(planSpeechBudget({...input,remainingSeconds:1000}).maxWords,140,'a long song does not require an oversized discussion');
 assert.match(speechBudgetPrompt(budget),/74 spoken words TOTAL/);
 assert.match(speechBudgetPrompt(budget),/not a quota/);
});

test('crossfade, extra speakers and a late call reduce the word target',()=>{
 const one=planSpeechBudget(input);
 const exchange=planSpeechBudget({...input,castSize:3});
 assert.ok(exchange.maxWords<one.maxWords);
 const late=planSpeechBudget({...input,remainingSeconds:15,crossfadeSeconds:10,castSize:3});
 assert.equal(late.maxWords,0);assert.ok(late.maxWords<late.minWords);
 const cold=planSpeechBudget({...input,generationWps:null,spokenWps:null});
 assert.equal(cold.generationWps,3);assert.equal(cold.spokenWps,2.3);
});

test('rendered audio must fit the deadline and the same play of the same track',()=>{
 const budget=planSpeechBudget(input);
 assert.equal(fitsSpeechDeadline(budget,{track:{id:'track'},startedAt:'start'},20000,10000),true);
 assert.equal(fitsSpeechDeadline(budget,{track:{id:'track'},startedAt:'start'},50000,10000),false);
 assert.equal(fitsSpeechDeadline(budget,{track:{id:'other'},startedAt:'start'},1000,10000),false);
 assert.equal(fitsSpeechDeadline(budget,{track:{id:'track'},startedAt:'replay'},1000,10000),false);
});

test('deferred and unknown clocks retain existing placement, while immediate speech uses measured rates',async t=>{
 const {queue}=await import('../src/broadcast/queue.js');
 const {withTalkAir}=await import('../src/broadcast/talk-air.js');
 const {captureSpeechBudget}=await import('../src/broadcast/speech-timing.js');
 const {ttsCalls}=await import('../src/stats.js');
 const store=await import('../src/settings/store.js');const settings=await import('../src/settings.js');
 const saved=queue.current;const oldSettings=settings.get();
 store.setCache({...oldSettings,crossfadeDuration:0});
 t.mock.method(queue,'remainingSecOnAir',()=>60);
 const at=new Date().toISOString();
 queue.current={track:{id:'track'},startedAt:at} as typeof queue.current;
 ttsCalls.unshift(...Array.from({length:20},()=>({ok:true,words:312,ms:100000,audioMs:312/3.49*1000,persona:'Host'})));
 try {
  const budget=captureSpeechBudget([{name:'Host'}]);assert.ok(budget);assert.equal(budget.generationWps,3.12);
  assert.equal(await withTalkAir('next-track',async()=>captureSpeechBudget([{name:'Host'}])),null);
  queue.current=null;assert.equal(captureSpeechBudget([{name:'Host'}]),null);
 } finally {queue.current=saved;ttsCalls.length=0;store.setCache(oldSettings);}
});

for (const kind of ['banter','sleeve-notes']) for (const outcome of ['deadline','different-track','replayed-track']) {
 test(`${kind}: rendered exchange is rejected before air after ${outcome}`,async t=>{
  const {queue}=await import('../src/broadcast/queue.js');
  const {withTalkAir}=await import('../src/broadcast/talk-air.js');
  const settings=await import('../src/settings.js');
  const store=await import('../src/settings/store.js');
  const savedSettings=settings.get(),savedTrack=queue.current,at=new Date().toISOString();
  store.setCache({...savedSettings,djBehaviour:{...savedSettings.djBehaviour,extendedSleeveNotes:true}});
  queue.current={track:{id:'track'},startedAt:at} as typeof queue.current;
  t.after(()=>{queue.current=savedTrack;store.setCache(savedSettings);});
  const wav=join(root,`${kind}-${outcome}.wav`);
  const pcm=Buffer.alloc(44+32000);pcm.write('RIFF',0);pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);
  pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(16000,24);
  pcm.writeUInt32LE(32000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(32000,40);writeFileSync(wav,pcm);
  const render=t.mock.method(queue,'_speak',async()=>{
   if(outcome==='different-track')queue.current={track:{id:'other'},startedAt:at} as typeof queue.current;
   if(outcome==='replayed-track')queue.current={track:{id:'track'},startedAt:at+'-replay'} as typeof queue.current;
   return wav;
  });
  const air=t.mock.method(queue,'_airVoice',async()=>{throw new Error('Rejected exchange must not be published');});
  assert.equal(await withTalkAir('immediate',()=>queue.announceExchange([
   {persona:{id:'a',name:'Host'},text:'Some words.'},{persona:{id:'b',name:'Guest'},text:'More words.'}],kind,
   {speechDeadline:{finishByMs:Date.now()+(outcome==='deadline'?500:60_000),trackId:'track',startedAt:at}})),false);
  assert.equal(render.mock.callCount(),2,'both voices must render before the deadline/track guard rejects publication');
  assert.equal(air.mock.callCount(),0);
 });
}

test.after(()=>rmSync(root,{recursive:true,force:true}));
