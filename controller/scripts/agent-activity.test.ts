import assert from 'node:assert/strict';
import test from 'node:test';
import { agentWorkActive, interactiveAgentWorkActive, withAgentActivity } from '../src/llm/agent-activity.js';

test('named Agent work holds the background-research gate until it settles', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const run = withAgentActivity(async () => {
    assert.equal(agentWorkActive(), true);
    await waiting;
  });
  assert.equal(agentWorkActive(), true);
  release();
  await run;
  assert.equal(agentWorkActive(), false);
});

test('a failed Agent run releases the background-research gate', async () => {
  await assert.rejects(withAgentActivity(async () => { throw new Error('agent failure'); }));
  assert.equal(agentWorkActive(), false);
});

test('background research does not block itself, while overlapping interactive work retains priority until the last run ends',async()=>{
  const {researchRunAllowed}=await import('../src/sleeve-notes/research-policy.js');
  let finishBackground!:()=>void,finishFirst!:()=>void,finishSecond!:()=>void;
  const background=withAgentActivity(()=>new Promise<void>(resolve=>{finishBackground=resolve;}),'background');
  const allowed=()=>researchRunAllowed({playbackCriticalBusy:false,agentWorkActive:interactiveAgentWorkActive(),
    djCallsAllowed:true,pauseWhenEmpty:true,maintenanceWhenEmpty:false,listenerCount:1});
  let first:Promise<void>|undefined,second:Promise<void>|undefined;
  try {
    assert.equal(agentWorkActive(),true);assert.equal(interactiveAgentWorkActive(),false);assert.equal(allowed(),true);
    first=withAgentActivity(()=>new Promise<void>(resolve=>{finishFirst=resolve;}));
    second=withAgentActivity(()=>new Promise<void>(resolve=>{finishSecond=resolve;}));
    assert.equal(allowed(),false);
    finishFirst();await first;assert.equal(allowed(),false,'one completed pick must not release another active run');
    finishSecond();await second;assert.equal(allowed(),true);
    await assert.rejects(withAgentActivity(async()=>{assert.equal(allowed(),false);throw new Error('interactive failure');}));
    assert.equal(allowed(),true,'failure releases priority without clearing the still-active background run');
    assert.equal(agentWorkActive(),true);
  } finally {finishBackground();finishFirst?.();finishSecond?.();await Promise.all([background,first,second]);}
  assert.equal(agentWorkActive(),false);assert.equal(interactiveAgentWorkActive(),false);
});
