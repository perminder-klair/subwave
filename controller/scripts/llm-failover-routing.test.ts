// N2: the /debug "routed to backup" line reads failoverRoutingSnapshot(). It
// must report every case where an unpinned LLM call went to the backup instead
// of the primary (D5's sticky window AND one-off failovers), and clear as soon
// as the primary answers again. Real settings, legs and failover; only the
// provider boundary is a callback. No network traffic.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { deferred } from './test-utils/async.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-failover-routing-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { withFailover, resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');
// The public barrel /debug imports from, so the export itself is covered too.
const { failoverRoutingSnapshot } = await import('../src/llm/log.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');

const primaryLabel = 'locca:qwen38-27B';
const backupLabel = 'ollama:llama3.1:8b';
const fallback = { enabled: true, provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434' };
const base = { provider: 'locca', model: 'qwen38-27B', baseUrl: 'http://127.0.0.1:8080' };
const failExtra = (err: Error) => ({ diagnostic: err.message });

const bare500 = () => Object.assign(new Error('Internal Server Error'), { statusCode: 500, __via: 'test-primary' });
const retired = () => Object.assign(new Error('model qwen38 has been retired'), {
  statusCode: 503, data: { error: { code: 'model_terminated' } }, __via: 'test-primary',
});
const quota = () => Object.assign(new Error('You exceeded your current quota'), { statusCode: 429, __via: 'test-primary' });

async function configure(llm: Record<string, unknown>) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm }));
  store.setCache(null);
  await settings.load();
  recentCalls.length = 0;
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

// One unpinned call whose primary fails with `err` (or answers when null).
const call = (err: (() => Error) | null, backupFails = false) => quietly(() =>
  withFailover('routing-test', failExtra, async (leg) => {
    if (leg.label === primaryLabel) {
      if (err) throw err();
      return { value: 'primary', via: 'test-primary' };
    }
    if (backupFails) throw Object.assign(new Error('backup down too'), { __via: 'test-backup' });
    return { value: 'backup', via: 'test-backup' };
  }));

after(() => {
  resetFailoverStickyForTest();
  recentCalls.length = 0;
});

test('normal routing reports nothing', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  assert.equal(await call(null), 'primary');
  assert.equal(failoverRoutingSnapshot(), null);
});

test('a one-off failover with no sticky window is reported (a retired model)', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  const before = Date.now();
  assert.equal(await call(retired), 'backup');
  const r = failoverRoutingSnapshot();
  assert.ok(r, 'the call went to the backup, so the line must show');
  assert.equal(r.provider, 'ollama');
  assert.equal(r.model, backupLabel);
  assert.equal(r.reason, 'primary model unavailable');
  assert.equal(r.calls, 1);
  assert.equal(r.lastOk, true);
  assert.ok(r.since >= before && r.lastAt >= r.since);
  assert.equal(r.retryPrimaryAt, undefined, 'no sticky window: the next call tries the primary first');
});

test('a quota refusal is reported too', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  assert.equal(await call(quota), 'backup');
  assert.equal(failoverRoutingSnapshot()?.reason, 'primary refused (quota/auth)');
});

test('the sticky window (#1923) is reported with when the primary is tried again, and counts every routed call', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await call(bare500);
  const first = failoverRoutingSnapshot();
  assert.ok(first);
  assert.equal(first.reason, 'primary cannot serve (5xx after retries)');
  assert.ok(first.retryPrimaryAt && first.retryPrimaryAt - first.since <= 5 * 60_000 + 50);
  // The next call goes straight to the backup through the window.
  assert.equal(await call(bare500), 'backup');
  const second = failoverRoutingSnapshot();
  assert.equal(second?.calls, 2);
  assert.equal(second?.since, first.since, 'one continuous episode');
  assert.equal(second?.reason, 'primary marked down: cannot serve (5xx)');
});

test('the first call the primary answers clears the line', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await call(retired);
  assert.ok(failoverRoutingSnapshot());
  assert.equal(await call(null), 'primary');
  assert.equal(failoverRoutingSnapshot(), null);
});

test('after the sticky window ends the line stays until the primary actually answers', async () => {
  resetFailoverStickyForTest(20);
  await configure({ ...base, fallback });
  await call(bare500);
  await new Promise((r) => setTimeout(r, 40));
  const r = failoverRoutingSnapshot();
  assert.ok(r, 'the last call still went to the backup; nothing has shown the primary is back');
  assert.equal(r.retryPrimaryAt, undefined, 'the window is over, so the next call tries the primary');
  assert.equal(await call(null), 'primary');
  assert.equal(failoverRoutingSnapshot(), null);
});

test('a backup that failed too is flagged on the line', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await assert.rejects(call(retired, true));
  const r = failoverRoutingSnapshot();
  assert.ok(r);
  assert.equal(r.lastOk, false);
});

test('pinned calls never raise the line: an explicit leg choice is routing as intended', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await quietly(() => withFailover('routing-test', failExtra, async () => ({ value: 'tagged', via: 'test-backup' }), 'fallback'));
  assert.equal(failoverRoutingSnapshot(), null);
});

test('switching the primary in Settings ends the line at once', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await call(retired);
  assert.ok(failoverRoutingSnapshot());
  await configure({ ...base, model: 'mistral3-14b', fallback });
  assert.equal(failoverRoutingSnapshot(), null, 'the new primary gets the next call');
});

test('disabling the backup ends the line: there is nowhere to route', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await call(retired);
  assert.ok(failoverRoutingSnapshot());
  await configure({ ...base, fallback: { ...fallback, enabled: false } });
  assert.equal(failoverRoutingSnapshot(), null);
});

test('reading the snapshot never changes routing', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  await call(bare500);
  for (let i = 0; i < 5; i++) failoverRoutingSnapshot();
  const attempts: string[] = [];
  await quietly(() => withFailover('routing-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    return { value: 'still backup', via: 'test-backup' };
  }));
  assert.deepEqual(attempts, [backupLabel], 'the window still holds after repeated reads');
});

test('a pending backup has no successful or failed outcome yet', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  const backup = deferred<{ value: string; via: string }>();
  const pending = withFailover('routing-pending', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw retired();
    return backup.promise;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  const observed = failoverRoutingSnapshot();
  backup.resolve({ value: 'backup', via: 'test-backup' });
  await pending;
  assert.ok(observed);
  assert.equal(observed.lastOk, undefined);
  assert.equal(failoverRoutingSnapshot()?.lastOk, true);
});

test('an older failed backup cannot label the latest successful backup as failed', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  const older = deferred<{ value: string; via: string }>();
  const callOlder = withFailover('routing-older', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw retired();
    return older.promise;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  await call(retired);
  older.reject(new Error('older backup failed'));
  await assert.rejects(callOlder, /older backup failed/);
  assert.equal(failoverRoutingSnapshot()?.calls, 2);
  assert.equal(failoverRoutingSnapshot()?.lastOk, true);
});

test('a cancelled backup does not claim the provider failed', async () => {
  resetFailoverStickyForTest();
  await configure({ ...base, fallback });
  const controller = new AbortController();
  await assert.rejects(withFailover('routing-cancelled', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw bare500();
    controller.abort();
    throw controller.signal.reason;
  }, undefined, controller.signal));
  assert.notEqual(failoverRoutingSnapshot()?.lastOk, false);
  assert.ok(failoverRoutingSnapshot()?.retryPrimaryAt);
});

for (const oldFails of [false, true]) {
  test(`an old primary ${oldFails ? 'failure' : 'success'} cannot hide the current primary's routing record`, async () => {
    resetFailoverStickyForTest();
    await configure({ ...base, fallback });
    const older = deferred<{ value: string; via: string }>();
    const oldCall = withFailover('routing-old-primary', failExtra, (leg) => {
      if (leg.label === primaryLabel) return older.promise;
      return Promise.resolve({ value: 'backup', via: 'test-backup' });
    });
    await configure({ ...base, model: 'new-primary', fallback });
    await quietly(() => withFailover('routing-new-primary', failExtra, async (leg) => {
      if (leg.label !== backupLabel) throw retired();
      return { value: 'backup', via: 'test-backup' };
    }));
    const current = failoverRoutingSnapshot();
    if (oldFails) older.reject(retired());
    else older.resolve({ value: 'old primary', via: 'test-primary' });
    await oldCall;
    assert.ok(current);
    assert.deepEqual(failoverRoutingSnapshot(), current);
  });
}
