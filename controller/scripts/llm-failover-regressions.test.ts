import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';
import { deferred } from './test-utils/async.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-failover-regressions-'));
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { withFailover, resetFailoverStickyForTest } = await import('../src/llm/internal/core/failover.js');
const { withTransientRetry } = await import('../src/llm/internal/core/retry.js');
const { isConnectionRefused } = await import('../src/llm/internal/core/pure.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { djAgent, djText } = await import('../src/llm/sdk.js');
const { generateText } = await import('ai');
const primaryLabel = 'ollama:primary';
const backupLabel = 'ollama:backup';
const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
const exhausted = () => Object.assign(new Error('Internal Server Error'), { statusCode: 500 });
const failExtra = () => ({});
const answer = (value: string) => ({ value, via: 'test' });

function configure(t: TestContext) {
  resetFailoverStickyForTest();
  t.after(() => resetFailoverStickyForTest());
  const defaults = settings.getDefaults();
  setCache({ ...defaults, llm: {
    ...defaults.llm, provider: 'ollama', model: 'primary', compatibleMode: 'local',
    fallback: { ...defaults.llm.fallback, enabled: true, provider: 'ollama', model: 'backup', compatibleMode: 'local' },
  } });
  return settings.get().llm;
}

test('a slow healthy Ollama stays primary after an unanswered agent deadline', async (t) => {
  const llm = configure(t);
  const models: string[] = [];
  const fixture = await listen(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { model } = JSON.parse(raw);
    models.push(model);
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: 'assistant', content: model }, done: true,
        done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }));
    }, model === 'primary' ? 150 : 0);
  });
  t.after(async () => { fixture.server.closeAllConnections(); await fixture.close(); });
  llm.ollamaUrl = fixture.url;
  llm.fallback.ollamaUrl = fixture.url;
  llm.requestTimeoutMs = 1000;
  assert.equal(await djText({ prompt: 'warm the primary' }), 'primary');
  await assert.rejects(djAgent({ system: 'test', messages: [{ role: 'user', content: 'test' }], timeoutMs: 50 }), { name: 'AgentDeadlineError' });
  assert.equal(await djText({ prompt: 'short request after the deadline' }), 'primary');
  assert.ok(!models.includes('backup'));
});

for (const stickyBackup of [false, true]) {
  test(`a failed ${stickyBackup ? 'sticky' : 'initial'} backup lets the next call try the recovered primary`, async (t) => {
    configure(t);
    const attempts: string[] = [];
    const backupError = new Error('backup failed');
    if (stickyBackup) {
      await withFailover('seed', failExtra, async (leg) => {
        if (leg.label === primaryLabel) throw exhausted();
        return answer('backup');
      });
    }
    await assert.rejects(withFailover('both-down', failExtra, async (leg) => {
      attempts.push(leg.label);
      if (leg.label === primaryLabel) throw exhausted();
      throw backupError;
    }), err => err === backupError);
    assert.deepEqual(attempts, stickyBackup ? [backupLabel] : [primaryLabel, backupLabel]);
    attempts.length = 0;
    assert.equal(await withFailover('recovered', failExtra, async (leg) => {
      attempts.push(leg.label);
      if (leg.label === backupLabel) throw backupError;
      return answer('primary recovered');
    }), 'primary recovered');
    assert.deepEqual(attempts, [primaryLabel]);
  });
}

for (const mode of ['disabled', 'unusable', 'pinned-primary', 'pinned-fallback', 'backup', 'sticky-backup'] as const) {
  test(`refusal retries are preserved for ${mode} attempts`, async (t) => {
    const llm = configure(t);
    if (mode === 'disabled') llm.fallback.enabled = false;
    if (mode === 'unusable') Object.assign(llm.fallback, { provider: 'openai-compatible', baseUrl: '' });
    if (mode === 'sticky-backup') {
      await withFailover('seed', failExtra, async (leg) => {
        if (leg.label === primaryLabel) throw exhausted();
        return answer('backup');
      });
    }
    const pin = mode === 'pinned-primary' ? 'primary' : mode === 'pinned-fallback' ? 'fallback' : undefined;
    const retryLabel = mode === 'backup' || mode === 'sticky-backup' || pin === 'fallback' ? backupLabel : primaryLabel;
    let retries = 0;
    const result = await withFailover('retry-scope', failExtra, (leg) => {
      if (mode === 'backup' && leg.label === primaryLabel) return Promise.reject(exhausted());
      assert.equal(leg.label, retryLabel);
      return withTransientRetry('retry-scope', async () => {
        if (++retries === 1) throw refused();
        return answer('recovered');
      });
    }, pin);
    assert.equal(result, 'recovered');
    assert.equal(retries, 2);
  });
}

test('an eligible primary skips SDK refusal retries before switching to backup', async (t) => {
  const llm = configure(t);
  Object.assign(llm, { provider: 'openai-compatible', baseUrl: 'http://primary.invalid/v1' });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new TypeError('fetch failed', { cause: refused() });
  });
  const attempts: string[] = [];
  assert.equal(await withFailover('sdk-refusal', failExtra, (leg) => {
    attempts.push(leg.label);
    if (leg.label === backupLabel) return Promise.resolve(answer('backup'));
    return withTransientRetry('sdk-refusal', async () => {
      await generateText({ model: leg.model, prompt: 'test' });
      return answer('unexpected primary');
    });
  }), 'backup');
  assert.deepEqual(attempts, ['openai-compatible:primary', backupLabel]);
  assert.equal(requests, 1);
});

test('an unsupported hosted probe cannot clear the sticky window', async (t) => {
  const llm = configure(t);
  Object.assign(llm, { provider: 'openai', model: 'hosted', keys: { openai: 'test-key' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network still down'); });
  await withFailover('hosted-down', failExtra, async (leg) => {
    if (leg.label === 'openai:hosted') throw Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND' });
    return answer('backup');
  });
  t.mock.timers.tick(30_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  const attempts: string[] = [];
  await withFailover('still-down', failExtra, async (leg) => {
    attempts.push(leg.label);
    return answer('backup');
  });
  assert.deepEqual(attempts, [backupLabel]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a successful self-hosted probe clears an unreachable sticky window', async (t) => {
  const llm = configure(t);
  llm.ollamaUrl = 'http://primary.invalid';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'http://primary.invalid/api/version');
    return new Response('{}');
  });
  await withFailover('local-down', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw refused();
    return answer('backup');
  });
  t.mock.timers.tick(30_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  const attempts: string[] = [];
  await withFailover('local-up', failExtra, async (leg) => {
    attempts.push(leg.label);
    return answer('primary');
  });
  assert.deepEqual(attempts, [primaryLabel]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('the real Ollama adapter exposes a nested refused connection', async (t) => {
  const llm = configure(t);
  const fixture = await listen((_req, res) => res.end());
  llm.ollamaUrl = fixture.url;
  await fixture.close();
  await assert.rejects(generateText({ model: primaryLeg().model, prompt: 'test' }), (err: any) => {
    assert.equal(err.cause?.cause?.code, 'ECONNREFUSED');
    assert.equal(isConnectionRefused(err), true);
    return true;
  });
});

test('refusal classification handles nested causes and terminates on cycles', () => {
  const cycle: { message: string; cause?: typeof cycle } = { message: 'fetch failed' };
  cycle.cause = cycle;
  assert.equal(isConnectionRefused(cycle), false);
  const first = { message: 'fetch failed', cause: { message: 'fetch failed', cause: { code: 'ECONNREFUSED' } } };
  assert.equal(isConnectionRefused({ lastError: first }), true);
  assert.equal(isConnectionRefused({ message: 'fetch failed', cause: { cause: { code: 'ENOTFOUND' } } }), true);
});

test('a stale reachability probe cannot clear a newer exhausted window', async (t) => {
  configure(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probe = deferred<Response>();
  const fetchMock = t.mock.method(globalThis, 'fetch', () => probe.promise);
  await withFailover('unreachable', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw refused();
    return answer('backup');
  });
  t.mock.timers.tick(30_000);
  assert.equal(fetchMock.mock.callCount(), 1);
  await assert.rejects(withFailover('backup-down', failExtra, async () => {
    throw new Error('backup failed');
  }));
  await withFailover('exhausted', failExtra, async (leg) => {
    if (leg.label === primaryLabel) throw exhausted();
    return answer('backup');
  });
  probe.resolve(new Response('{}'));
  await new Promise<void>(resolve => setImmediate(resolve));
  const attempts: string[] = [];
  await withFailover('after-stale-probe', failExtra, async (leg) => {
    attempts.push(leg.label);
    return answer('backup');
  });
  assert.deepEqual(attempts, [backupLabel]);
});

test('a successful call to an old primary cannot clear the new primary window', async (t) => {
  const llm = configure(t);
  const oldPrimary = deferred<ReturnType<typeof answer>>();
  const oldCall = withFailover('old-primary', failExtra, () => oldPrimary.promise);
  llm.model = 'new-primary';
  await withFailover('new-primary-down', failExtra, async (leg) => {
    if (leg.label === 'ollama:new-primary') throw exhausted();
    return answer('backup');
  });
  oldPrimary.resolve(answer('old primary succeeded'));
  await oldCall;
  const attempts: string[] = [];
  await withFailover('after-old-success', failExtra, async (leg) => {
    attempts.push(leg.label);
    return answer('backup');
  });
  assert.deepEqual(attempts, [backupLabel]);
});

for (const backupFails of [false, true]) {
  test(`an old primary failure preserves the new window when its backup ${backupFails ? 'fails' : 'succeeds'}`, async (t) => {
    const llm = configure(t);
    const oldPrimary = deferred<ReturnType<typeof answer>>();
    const oldCall = withFailover('old-primary', failExtra, (leg) => {
      if (leg.label === primaryLabel) return oldPrimary.promise;
      if (backupFails) return Promise.reject(new Error('old call backup failed'));
      return Promise.resolve(answer('backup'));
    });
    llm.model = 'new-primary';
    await withFailover('new-primary-down', failExtra, async (leg) => {
      if (leg.label === 'ollama:new-primary') throw exhausted();
      return answer('backup');
    });
    oldPrimary.reject(exhausted());
    if (backupFails) await assert.rejects(oldCall, /old call backup failed/);
    else await oldCall;
    const attempts: string[] = [];
    await withFailover('after-old-failure', failExtra, async (leg) => {
      attempts.push(leg.label);
      return answer('backup');
    });
    assert.deepEqual(attempts, [backupLabel]);
  });
}

for (const status of [500, 400]) {
  test(`the real Ollama adapter preserves status ${status} for failover classification`, async (t) => {
    const llm = configure(t);
    let failPrimary = true;
    const models: string[] = [];
    const fixture = await listen(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { model } = JSON.parse(raw);
      models.push(model);
      res.setHeader('content-type', 'application/json');
      if (model === 'primary' && failPrimary) {
        res.statusCode = status;
        res.end(JSON.stringify({ error: status === 500 ? 'Internal Server Error' : 'max_tokens must be at most 500' }));
        return;
      }
      res.end(JSON.stringify({ model, created_at: new Date().toISOString(),
        message: { role: 'assistant', content: model }, done: true,
        done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }));
    });
    t.after(async () => { fixture.server.closeAllConnections(); await fixture.close(); });
    llm.ollamaUrl = fixture.url;
    llm.fallback.ollamaUrl = fixture.url;
    if (status === 500) {
      assert.equal(await djText({ prompt: 'test' }), 'backup');
      failPrimary = false;
      assert.equal(await djText({ prompt: 'sticky' }), 'backup');
      assert.deepEqual(models, ['primary', 'backup', 'backup']);
      llm.fallback.enabled = false;
      failPrimary = true;
      await assert.rejects(djText({ prompt: 'no backup' }), /Internal Server Error/);
      assert.deepEqual(models, ['primary', 'backup', 'backup', 'primary']);
    } else {
      await assert.rejects(djText({ prompt: 'test' }), /max_tokens must be at most 500/);
      assert.ok(!models.includes('backup'));
      failPrimary = false;
      assert.equal(await djText({ prompt: 'primary stays in use' }), 'primary');
    }
  });
}
