// Track selection migration: Candidate Pool was represented by the legacy
// `pickerAgent: false` flag before the explicit Track Shortlist setting existed.
// A cold load is essential: this is the actual upgrade path from settings.json.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-track-selection-migration-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const settingsPath = path.join(stateRoot, 'settings.json');

async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(settingsPath, JSON.stringify({ llm }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('a retired Candidate Pool install upgrades to Track Shortlist', async () => {
  const llm = await coldLoad({ pickerAgent: false });
  assert.equal(llm.trackSelection, 'shortlist');
  assert.equal(llm.pickerAgent, false, 'the legacy compatibility flag is preserved');
  assert.equal(llm.segmentRuntime, 'direct', 'the existing direct-segment migration is retained');
  assert.equal(llm.requestMatching, 'agentic', 'request matching keeps its established independent default');
});

test('an unambiguous explicit setting always wins over the legacy flag', async () => {
  assert.equal((await coldLoad({ pickerAgent: false, trackSelection: 'agentic' })).trackSelection, 'agentic');
  assert.equal((await coldLoad({ pickerAgent: true, trackSelection: 'shortlist' })).trackSelection, 'shortlist');
});

test('new and older Agentic Tools installs retain the Agentic default', async () => {
  assert.equal((await coldLoad({})).trackSelection, 'agentic');
  assert.equal((await coldLoad({ pickerAgent: true })).trackSelection, 'agentic');
});
