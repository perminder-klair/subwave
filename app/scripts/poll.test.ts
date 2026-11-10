import assert from 'node:assert/strict';
import test from 'node:test';
import { pollAsync } from '../src/lib/poll.ts';

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('slow requests cannot overlap, and polling resumes after they settle', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const requests: { signal: AbortSignal; resolve: () => void }[] = [];
  const stop = pollAsync(signal => new Promise<void>(resolve => {
    requests.push({ signal, resolve });
  }), 5000);
  t.after(stop);

  assert.equal(requests.length, 1, 'first poll runs immediately');
  t.mock.timers.tick(10_000);
  assert.equal(requests.length, 1, 'slow requests skip interval ticks');
  requests[0]?.resolve();
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(requests.length, 2);
  requests[1]?.resolve();
  await settle();
});

test('cleanup aborts requests and prevents a late response from publishing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let finish = () => {};
  let requestSignal: AbortSignal | undefined;
  const published: string[] = [];
  const stop = pollAsync(async signal => {
    requestSignal = signal;
    await new Promise<void>(resolve => { finish = resolve; });
    if (!signal.aborted) published.push('old station');
  }, 5000);
  t.after(stop);

  stop();
  assert.equal(requestSignal?.aborted, true);
  finish();
  await settle();
  t.mock.timers.tick(20_000);
  assert.deepEqual(published, []);
});

test('a failed request releases the poll for a later retry', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = pollAsync(async () => {
    calls++;
    throw new Error('offline');
  }, 5000);
  t.after(stop);

  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2);
});

test('switching to background cadence cancels the old poll and starts immediately', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let foregroundCalls = 0;
  let foregroundSignal: AbortSignal | undefined;
  const foreground = pollAsync(async signal => {
    foregroundSignal = signal;
    foregroundCalls++;
  }, 5000);
  t.after(foreground);
  await settle();
  foreground();

  let backgroundCalls = 0;
  const background = pollAsync(async () => { backgroundCalls++; }, 30_000);
  t.after(background);
  await settle();
  assert.equal(foregroundSignal?.aborted, true);
  assert.equal(backgroundCalls, 1);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(foregroundCalls, 1);
  assert.equal(backgroundCalls, 1);
  t.mock.timers.tick(25_000);
  await settle();
  assert.equal(backgroundCalls, 2);
});
