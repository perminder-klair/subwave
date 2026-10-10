// settings.llm.agentTimeoutMs — the shared wall-clock budget for DJ-agent
// picks, listener requests, and the segment director.
//
// Exercise both persistence paths: update() is what the admin UI uses, while a
// cold load is what proves the saved value survives a controller restart.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-agent-timeout-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

async function coldLoad(agentTimeoutMs: unknown) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { agentTimeoutMs } }));
  setCache(null);
  await settings.load();
  return settings.get().llm.agentTimeoutMs;
}

test('the admin save path accepts a five-minute agent deadline across a restart', async () => {
  await coldLoad(45_000);
  await settings.update({ llm: { agentTimeoutMs: 300_000 } } as never);
  assert.equal(settings.get().llm.agentTimeoutMs, 300_000, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.agentTimeoutMs, 300_000, 'survives a controller restart');
});

test('a hand-edited deadline is capped at five minutes on cold load', async () => {
  assert.equal(await coldLoad(300_000), 300_000, 'the documented ceiling is accepted');
  assert.equal(await coldLoad(600_000), 300_000, 'values above the ceiling are contained');
});
