import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-request-timeout-'));
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
async function coldLoad(value?: unknown) {
  writeFileSync(path.join(process.env.STATE_DIR!, 'settings.json'), JSON.stringify({ llm: { requestTimeoutMs: value } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}
test('request timeout remains finite and survives save and cold load without changing agent budget', async () => {
  assert.equal((await coldLoad()).requestTimeoutMs, 300_000);
  for (const value of [null, 'bad', '123', {}]) assert.equal((await coldLoad(value)).requestTimeoutMs, 300_000);
  assert.equal((await coldLoad(0)).requestTimeoutMs, 5_000);
  assert.equal((await coldLoad(9_999_999)).requestTimeoutMs, 1_800_000);
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
