import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { pollAsyncWhileVisible } from './poll';

function browser(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const cleanups: Array<() => void> = [];
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    cleanup: (fn: () => void) => { cleanups.push(fn); },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return document;
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('slow polls share one request, including a foreground refetch', async t => {
  const document = browser(t);
  const requests: Array<{ signal: AbortSignal; resolve: () => void }> = [];
  const stop = pollAsyncWhileVisible(signal => new Promise<void>(resolve => {
    requests.push({ signal, resolve });
  }), 5000);
  document.cleanup(stop);

  t.mock.timers.tick(10_000);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 1);

  requests[0]?.resolve();
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(requests.length, 2);
  stop();
  assert.equal(requests[1]?.signal.aborted, true);
  requests[1]?.resolve();
  await settle();
  t.mock.timers.tick(10_000);
  assert.equal(requests.length, 2);
});

test('teardown prevents a late response from publishing', async t => {
  const document = browser(t);
  let finish = () => {};
  const published: string[] = [];
  const stop = pollAsyncWhileVisible(async signal => {
    await new Promise<void>(resolve => { finish = resolve; });
    if (!signal.aborted) published.push('late response');
  }, 5000);
  document.cleanup(stop);

  stop();
  finish();
  await settle();
  assert.deepEqual(published, []);
});

test('hung requests time out and the following tick retries', async t => {
  const document = browser(t);
  const signals: AbortSignal[] = [];
  const stop = pollAsyncWhileVisible(signal => {
    signals.push(signal);
    return new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }, 5000);
  document.cleanup(stop);

  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(signals[0]?.aborted, true);
  t.mock.timers.tick(5000);
  assert.equal(signals.length, 2);
  stop();
  await settle();
});

test('hidden tabs wait until visible, and a failed request can retry', async t => {
  const document = browser(t);
  document.hidden = true;
  let calls = 0;
  const signals: AbortSignal[] = [];
  const stop = pollAsyncWhileVisible(async signal => {
    signals.push(signal);
    calls++;
    throw new Error('offline');
  }, 5000);
  document.cleanup(stop);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 0);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls, 1);
  assert.equal(signals[0]?.aborted, true, 'failed polls cancel any unfinished sibling requests');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls, 2);
});
