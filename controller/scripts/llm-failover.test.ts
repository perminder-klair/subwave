// Exercise real leg selection/settings/telemetry, with generation callbacks
// replacing only the provider boundary. No provider traffic or credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const previousStateDir = process.env.STATE_DIR;
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-llm-failover-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { withFailover } = await import('../src/llm/internal/core/failover.js');
const { withTransientRetry } = await import('../src/llm/internal/core/retry.js');
const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');
const previousCache = store.peek();
const primaryLabel = 'ollama:qwen3.5:397b';
const backupLabel = 'ollama:llama3.1:8b';
const fallback = { enabled: true, provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://127.0.0.1:11434' };

async function configure(backup: Record<string, unknown> = fallback) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: {
    provider: 'ollama', model: 'qwen3.5:397b', baseUrl: 'http://127.0.0.1:11434', fallback: backup,
  } }));
  store.setCache(null);
  await settings.load();
  recentCalls.length = 0;
}

function retired() {
  return Object.assign(new Error('model qwen3.5 has been retired'), {
    statusCode: 503, data: { error: { code: 'model_terminated' } }, __via: 'test-primary',
  });
}

const failExtra = (err: Error) => ({ diagnostic: err.message });

after(() => {
  store.setCache(previousCache);
  recentCalls.length = 0;
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  rmSync(stateRoot, { recursive: true, force: true });
});

test('a permanent primary failure returns the backup result without controller retries and records both legs', async () => {
  await configure();
  const error = retired();
  // Permanent reason must win even when the provider also says overloaded.
  error.message += ' (upstream overloaded, retry later)';
  const attempts: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try {
    const result = await withFailover('retirement-test', failExtra, (leg) => withTransientRetry('retirement-test', async () => {
      attempts.push(leg.label);
      if (leg.label === primaryLabel) throw error;
      return { value: 'backup speech', via: 'test-backup', usage: { input: 2, output: 3, total: 5 }, extra: { response: 'backup speech' } };
    }));
    assert.equal(result, 'backup speech');
    assert.deepEqual(attempts, [primaryLabel, backupLabel]);
    assert.ok(logs.some((line) => line.includes('model unavailable (503) — failing over')));
    assert.ok(!logs.some((line) => line.includes('retrying in')));
    assert.equal(recentCalls.length, 2);
    const [success, failure] = recentCalls;
    assert.equal(failure.ok, false);
    assert.equal(failure.model, primaryLabel);
    assert.equal(failure.via, `test-primary:failover→${backupLabel}`);
    assert.equal(failure.error, error.message);
    assert.equal(failure.diagnostic, error.message);
    assert.equal(success.ok, true);
    assert.equal(success.model, backupLabel);
    assert.equal(success.via, 'test-backup');
    assert.equal(success.response, 'backup speech');
    assert.deepEqual(success.usage, { input: 2, output: 3, total: 5 });
  } finally {
    console.log = originalLog;
  }
});

for (const [name, backup] of [
  ['disabled', { ...fallback, enabled: false }],
  ['unusable', { enabled: true, provider: 'openai-compatible', model: 'missing', baseUrl: '' }],
] as const) {
  test(`${name} fallback preserves the original primary error`, async () => {
    await configure(backup);
    const error = retired();
    const attempts: string[] = [];
    await assert.rejects(withFailover('no-backup-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      throw error;
    }), (err) => err === error);
    assert.deepEqual(attempts, [primaryLabel]);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].via, 'test-primary');
    assert.equal(recentCalls[0].model, primaryLabel);
    assert.equal(recentCalls[0].ok, false);
  });
}

for (const pin of ['primary', 'fallback'] as const) {
  test(`pinned ${pin} never switches legs on a permanent model failure`, async () => {
    await configure();
    const error = retired();
    const attempts: string[] = [];
    const label = pin === 'primary' ? primaryLabel : backupLabel;
    await assert.rejects(withFailover('pinned-test', failExtra, async (leg) => {
      attempts.push(leg.label);
      throw error;
    }, pin), (err) => err === error);
    assert.deepEqual(attempts, [label]);
    assert.equal(recentCalls.length, 1);
    assert.equal(recentCalls[0].model, label);
    assert.equal(recentCalls[0].via, 'test-primary:pinned');
  });
}

test('a failed backup propagates its own error and does not return to the primary', async () => {
  await configure();
  const primaryError = retired();
  const backupError = Object.assign(new Error('model llama3.1:8b not found'), { __via: 'test-backup' });
  const attempts: string[] = [];
  await assert.rejects(withFailover('failed-backup-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    throw leg.label === primaryLabel ? primaryError : backupError;
  }), (err) => err === backupError);
  assert.deepEqual(attempts, [primaryLabel, backupLabel]);
  assert.equal(recentCalls.length, 2);
  assert.deepEqual(recentCalls.map((call) => [call.model, call.ok, call.error]), [
    [backupLabel, false, backupError.message], [primaryLabel, false, primaryError.message],
  ]);
  assert.equal(recentCalls[0].via, 'test-backup');
});

test('an unrelated removed endpoint does not select an otherwise healthy backup', async () => {
  await configure();
  const error = new Error('The requested API endpoint has been removed');
  const attempts: string[] = [];
  await assert.rejects(withFailover('endpoint-test', failExtra, async (leg) => {
    attempts.push(leg.label);
    if (leg.label === primaryLabel) throw error;
    return { value: 'must not use backup', via: 'test-backup' };
  }), (err) => err === error);
  assert.deepEqual(attempts, [primaryLabel]);
  assert.equal(recentCalls.length, 1);
  assert.equal(recentCalls[0].model, primaryLabel);
});
