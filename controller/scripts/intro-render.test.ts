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
});

test('a render rejection is reported as failure rather than timeout', async () => {
  const tracker = new IntroRenderTracker<object>();
  const failure = new Error('engine unavailable');
  const pending = tracker.start({}, async () => { throw failure; });

  const result = await awaitIntroRender(pending, 50);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.error, failure);
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
});
