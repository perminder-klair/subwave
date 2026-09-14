import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchAnalysis, type DispatchOutcome } from '../src/music/analyze-dispatch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('bounded analysis dispatch admits in order and waits for capacity', async () => {
  const jobs = [deferred<string>(), deferred<string>(), deferred<string>()];
  const starts: string[] = [];
  let active = 0;
  let maxActive = 0;

  const dispatch = dispatchAnalysis(['a', 'b', 'c'], {
    concurrency: 2,
    beforeStart: async () => {},
    run: async (id, index) => {
      starts.push(id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await jobs[index].promise;
      } finally {
        active -= 1;
      }
    },
    onOutcome: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['a', 'b']);
  assert.equal(maxActive, 2);

  jobs[1].resolve('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['a', 'b', 'c'], 'the third job starts only after a live slot frees');
  assert.equal(maxActive, 2);

  jobs[0].resolve('first');
  jobs[2].resolve('third');
  await dispatch;
});

test('beforeStart gates each newly available slot before run begins', async () => {
  const gate = deferred<void>();
  const starts: string[] = [];
  const dispatch = dispatchAnalysis(['a', 'b'], {
    concurrency: 1,
    beforeStart: async (index) => {
      if (index === 1) await gate.promise;
    },
    run: async (id) => {
      starts.push(id);
      return id;
    },
    onOutcome: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['a']);
  gate.resolve();
  await dispatch;
  assert.deepEqual(starts, ['a', 'b']);
});

test('outcomes are reported in input order even when jobs settle out of order', async () => {
  const jobs = [deferred<string>(), deferred<string>(), deferred<string>()];
  const reported: Array<[string, DispatchOutcome<string>]> = [];
  const dispatch = dispatchAnalysis(['a', 'b', 'c'], {
    concurrency: 3,
    beforeStart: async () => {},
    run: (_id, index) => jobs[index].promise,
    onOutcome: (outcome, id) => {
      reported.push([id, outcome]);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  jobs[2].resolve('third');
  jobs[1].reject(new Error('second failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, [], 'later outcomes wait for the first source item');

  jobs[0].resolve('first');
  await dispatch;
  assert.deepEqual(reported.map(([id]) => id), ['a', 'b', 'c']);
  assert.equal(reported[0][1].status, 'fulfilled');
  assert.equal(reported[1][1].status, 'rejected');
  assert.equal(reported[2][1].status, 'fulfilled');
});

test('a rejected run is owned, reported, and does not prevent the pool draining', async () => {
  const reported: Array<DispatchOutcome<number>> = [];
  await dispatchAnalysis(['a', 'b'], {
    concurrency: 2,
    beforeStart: async () => {},
    run: async (_id, index) => {
      if (index === 0) throw new Error('broken');
      return 2;
    },
    onOutcome: (outcome) => {
      reported.push(outcome);
    },
  });
  assert.deepEqual(reported.map((outcome) => outcome.status), ['rejected', 'fulfilled']);
});
