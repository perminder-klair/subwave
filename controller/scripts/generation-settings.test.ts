// Request and agent wall-clock budgets persist independently across cold loads.
// Agent saves accept five minutes and hand edits are capped at that ceiling.

import assert from 'node:assert/strict';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-generation-settings-'));
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
async function coldLoad(llm: Record<string, unknown> = {}) { return (await coldLoadSettings({ llm })).llm; }
test('request timeout remains finite and survives save and cold load without changing agent budget', async () => {
  assert.equal((await coldLoad()).requestTimeoutMs, 300_000);
  for (const value of [null, 'bad', '123', {}]) assert.equal((await coldLoad({ requestTimeoutMs: value })).requestTimeoutMs, 300_000);
  assert.equal((await coldLoad({ requestTimeoutMs: 0 })).requestTimeoutMs, 5_000);
  assert.equal((await coldLoad({ requestTimeoutMs: 9_999_999 })).requestTimeoutMs, 1_800_000);
  await settings.update({ llm: { requestTimeoutMs: 600_000 } } as never);
  for (const value of ['bad', null, false, [], {}, '', Infinity]) {
    await settings.update({ llm: { requestTimeoutMs: value } } as never);
    assert.equal(settings.get().llm.requestTimeoutMs, 600_000);
  }
  await settings.update({ llm: { reasoning: false } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.requestTimeoutMs, 600_000);
  assert.equal(settings.get().llm.agentTimeoutMs, 45_000);
});

test('the admin save path accepts a five-minute agent deadline across a restart', async () => {
  await coldLoad({ agentTimeoutMs: 45_000 });
  await settings.update({ llm: { agentTimeoutMs: 300_000 } } as never);
  assert.equal(settings.get().llm.agentTimeoutMs, 300_000, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.agentTimeoutMs, 300_000, 'survives a controller restart');
});

test('a hand-edited deadline is capped at five minutes on cold load', async () => {
  assert.equal((await coldLoad({ agentTimeoutMs: 300_000 })).agentTimeoutMs, 300_000, 'the documented ceiling is accepted');
  assert.equal((await coldLoad({ agentTimeoutMs: 600_000 })).agentTimeoutMs, 300_000, 'values above the ceiling are contained');
});
