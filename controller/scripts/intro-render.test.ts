// Intro pre-render lifecycle (#1409 follow-up).
//
// A render that outlives the drain budget must stay reusable at track start:
// starting the same TTS job again doubles local-worker latency and cloud cost.
// A render that fails before the budget expires is a failure, not an overrun.

import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitIntroRender, IntroRenderTracker } from '../src/broadcast/queue/intro-render.js';

test('a timed-out pre-render remains available at air time without a second render', async () => {
  const tracker = new IntroRenderTracker<object>();
  const item = {};
  let calls = 0;
  let finish!: (wav: string) => void;

  const pending = tracker.start(item, () => {
    calls += 1;
    return new Promise<string>(resolve => { finish = resolve; });
  });

  const drainResult = await awaitIntroRender(pending, 5);
  assert.deepEqual(drainResult, { status: 'timed-out' });

  // onTrackStarted spreads the queued item into a new `current` object before
  // calling airIntro, so the lifecycle must follow that identity hand-off.
  const current = { ...item };
  tracker.transfer(item, current);
  const atAir = tracker.get(current);
  assert.equal(atAir, pending, 'air time reuses the render that exceeded the drain budget');

  finish('/tmp/intro.wav');
  assert.deepEqual(await atAir, { status: 'rendered', wav: '/tmp/intro.wav' });
  assert.equal(calls, 1, 'the script is rendered exactly once');
  assert.equal(tracker.busy(), false);
});

test('a render rejection is reported as failure rather than timeout', async () => {
  const tracker = new IntroRenderTracker<object>();
  const failure = new Error('engine unavailable');
  const pending = tracker.start({}, async () => { throw failure; });

  const result = await awaitIntroRender(pending, 50);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.error, failure);
  assert.equal(tracker.busy(), false);
});


test('invalidating a render detaches it so a replacement job cannot be overwritten', async () => {
  const tracker = new IntroRenderTracker<object>();
  const item = {};
  let finishOld!: (wav: string) => void;
  const old = tracker.start(item, () => new Promise<string>(resolve => { finishOld = resolve; }));

  tracker.invalidate(item);
  const replacement = tracker.start(item, async () => '/tmp/new.wav');
  assert.notEqual(replacement, old);
  assert.deepEqual(await replacement, { status: 'rendered', wav: '/tmp/new.wav' });

  finishOld('/tmp/old.wav');
  assert.deepEqual(await old, { status: 'rendered', wav: '/tmp/old.wav' });
  assert.equal(tracker.get(item), null, 'the old completion cannot restore itself over the replacement');
  assert.equal(tracker.busy(), false);
});

// Detaching/overwriting an address must never strand the broadcast quiet gate.
test('invalidated renders stay busy only until actual TTS completion', async () => {
  const tracker = new IntroRenderTracker<object>();
  const item = {};
  let finish!: (wav: string) => void;
  const pending = tracker.start(item, () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve();
  tracker.invalidate(item);
  tracker.invalidate(item);
  assert.equal(tracker.busy(), true);
  finish('/tmp/detached.wav');
  await pending;
  assert.equal(tracker.busy(), false);
});

test('transfers over another active render track both promises through settlement', async () => {
  const tracker = new IntroRenderTracker<object>();
  const from = {}, to = {};
  let finishFirst!: (wav: string) => void, finishSecond!: (wav: string) => void;
  const first = tracker.start(from, () => new Promise<string>(resolve => { finishFirst = resolve; }));
  const second = tracker.start(to, () => new Promise<string>(resolve => { finishSecond = resolve; }));
  await Promise.resolve();
  tracker.transfer(from, to);
  tracker.transfer(to, to);
  assert.equal(tracker.get(to), first);
  finishFirst('/tmp/first.wav'); await first;
  assert.equal(tracker.busy(), true);
  finishSecond('/tmp/second.wav'); await second;
  assert.equal(tracker.busy(), false);
});


test('research gate resumes after an invalidated render settles, including the identity handoff', async () => {
  const {researchRunAllowed} = await import('../src/sleeve-notes/research-policy.js');
  const tracker = new IntroRenderTracker<object>();
  const original = {}, current = {};
  let finish!: (wav: string) => void;
  const task = tracker.start(original, () => new Promise<string>(resolve => {finish = resolve;}));
  await Promise.resolve();
  const allowed = () => researchRunAllowed({playbackCriticalBusy:tracker.busy(),agentWorkActive:false,
    djCallsAllowed:true,pauseWhenEmpty:false,maintenanceWhenEmpty:false,listenerCount:1});
  assert.equal(allowed(),false);
  tracker.transfer(original,current);tracker.invalidate(current);
  assert.equal(allowed(),false);
  finish('/tmp/settled.wav');await task;
  assert.equal(allowed(),true);
});
