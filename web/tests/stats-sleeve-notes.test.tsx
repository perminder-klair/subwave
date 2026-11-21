import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {EngineRoom} from '../components/admin/stats/EngineRoom';
import type {LlmStats, TtsStats} from '../components/admin/stats/types';

const llm: LlmStats = {window:120,count:2,ok:1,failed:0,deferred:1,successRate:1,
  latency:{},agent:{calls:0},byModel:[],byKind:[{kind:'sleeveNotesWikipediaExtract',count:2,ok:1,deferred:1}]};
const pace={window:20,samples:1,audioSamples:1,generationWordsPerSecond:3,spokenWordsPerSecond:2};
const tts: TtsStats = {window:120,count:1,ok:1,failed:0,fellBack:0,latency:{max:4000},
  slowest:{ms:4000,kind:'link'},byEngine:[],byKind:[],recentPace:pace,
  paceByVoice:[{...pace,engine:'piper',persona:'Host'}]};

test('new Stats layout retains deferred research and voice pace beside upstream slowest-render details', () => {
  const html=renderToStaticMarkup(<EngineRoom llm={llm} tts={tts}/>);
  assert.match(html,/Engine room/);assert.match(html,/1 deferred/);
  assert.doesNotMatch(html,/1 failed/);
  assert.match(html,/Generation speed/);assert.match(html,/3\.00 words\/s/);
  assert.match(html,/Speaking pace/);assert.match(html,/2\.00 words\/s/);
  assert.match(html,/Host/);assert.match(html,/piper/);assert.match(html,/a link segment/);
});

test('Stats still renders responses from controllers without optional pace or deferred fields', () => {
  const {recentPace,paceByVoice,...olderTts}=tts;
  void recentPace;void paceByVoice;
  const html=renderToStaticMarkup(<EngineRoom llm={{...llm,deferred:undefined,byKind:[]}} tts={olderTts}/>);
  assert.match(html,/Voice \/ TTS/);assert.match(html,/a link segment/);
  assert.doesNotMatch(html,/undefined|NaN|Recent pace by engine/);
});
