import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spokenWordCount,ttsMeasurements} from '../src/audio/tts-measurements.js';
import {summarizeTts,summarizeTtsRates} from '../src/stats.js';

const root=mkdtempSync(join(tmpdir(),'subwave-tts-measure-'));
const wav=join(root,'speech.wav');
const pcm=Buffer.alloc(44+32000);
pcm.write('RIFF',0);pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);
pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);
pcm.writeUInt32LE(16000,24);pcm.writeUInt32LE(32000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);
pcm.write('data',36);pcm.writeUInt32LE(32000,40);writeFileSync(wav,pcm);

test('TTS measurements count the full script without control tags and use actual audio length',()=>{
 assert.equal(spokenWordCount("[Tone: friendly] Don't stop. (sigh) Keep going!"),4);
 const text='word '.repeat(100);
 assert.ok(text.length>240);
 assert.deepEqual(ttsMeasurements(wav,text),{words:100,audioMs:1000});
 assert.deepEqual(ttsMeasurements(null,text),{words:null,audioMs:null});
 assert.deepEqual(ttsMeasurements(join(root,'missing.wav'),text),{words:100,audioMs:null},'unmeasured files must never seed a guessed speaking rate');
});

test('recent rates divide total words by total time and exclude failed, legacy and invalid samples',()=>{
 const calls=[{ok:true,words:10,ms:1000,audioMs:5000},{ok:true,words:90,ms:9000,audioMs:30000},
  {ok:false,words:1000,ms:10,audioMs:10},{ok:true,ms:2000},
  {ok:true,words:100,ms:0,audioMs:1000},{ok:true,words:NaN,ms:1000},
  {ok:true,words:20,ms:2000,audioMs:null}];
 const result=summarizeTtsRates(calls);
 assert.equal(result.samples,3);assert.equal(result.audioSamples,2);
 assert.equal(result.generationWordsPerSecond,10);
 assert.equal(result.spokenWordsPerSecond,100/35);
 assert.equal(summarizeTtsRates([]).generationWordsPerSecond,null);
 assert.equal(summarizeTtsRates([{ok:true,words:10,ms:1000}]).spokenWordsPerSecond,null);
});

test('rates use the latest 20 successful samples and keep engine/presenter histories separate',()=>{
 const recent=Array.from({length:20},()=>({ok:true,engine:'remote',persona:'Chris',words:20,ms:1000,audioMs:10000}));
 const calls=[...recent,{ok:true,engine:'remote',persona:'Carrie',words:10,ms:2000,audioMs:10000}];
 const summary=summarizeTts(calls);
 assert.equal(summary.recentPace.samples,20);assert.equal(summary.recentPace.generationWordsPerSecond,20);
 assert.equal(summary.paceByVoice.length,2);
 assert.equal(summary.paceByVoice.find(row=>row.persona==='Carrie')?.generationWordsPerSecond,5);
 assert.equal(summary.paceByVoice.find(row=>row.persona==='Chris')?.spokenWordsPerSecond,2);
});

test.after(()=>rmSync(root,{recursive:true,force:true}));
