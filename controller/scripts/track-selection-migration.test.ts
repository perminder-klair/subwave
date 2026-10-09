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
  assert.equal(llm.requestMatching, 'direct', 'a legacy pool install keeps direct request matching');
});

test('an unambiguous explicit setting always wins over the legacy flag', async () => {
  assert.equal((await coldLoad({ pickerAgent: false, trackSelection: 'agentic' })).trackSelection, 'agentic');
  assert.equal((await coldLoad({ pickerAgent: true, trackSelection: 'shortlist' })).trackSelection, 'shortlist');
  assert.equal((await coldLoad({ pickerAgent: false, requestMatching: 'agentic' })).requestMatching, 'agentic');
});

test('new and older Agentic Tools installs retain the Agentic default', async () => {
  assert.equal((await coldLoad({})).trackSelection, 'agentic');
  assert.equal((await coldLoad({ pickerAgent: true })).trackSelection, 'agentic');
});

test('saving modern music selection preserves independently configured runtimes', async () => {
  await coldLoad({ trackSelection: 'shortlist', requestMatching: 'agentic', segmentRuntime: 'agentic' });
  await settings.update({ llm: { trackSelection: 'shortlist', pickerAgent: false, shortlistPasses: 4 } });
  assert.equal(settings.get().llm.segmentRuntime, 'agentic');
  assert.equal(settings.get().llm.requestMatching, 'agentic');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.segmentRuntime, 'agentic');
  assert.equal(settings.get().llm.shortlistPasses, 4);
});

test('legacy picker toggles select the supported route and survive cold load', async () => {
  await coldLoad({});
  for (const enabled of [false, true]) {
    await settings.update({ llm: { pickerAgent: enabled } });
    assert.equal(settings.get().llm.trackSelection, enabled ? 'agentic' : 'shortlist');
    setCache(null);
    await settings.load();
    assert.equal(settings.get().llm.pickerAgent, enabled);
    assert.equal(settings.get().llm.trackSelection, enabled ? 'agentic' : 'shortlist');
  }
});

test('the legacy toggle moves requests and segments in BOTH directions', async () => {
  await coldLoad({});
  await settings.update({ llm: { pickerAgent: false } });
  assert.equal(settings.get().llm.requestMatching, 'direct');
  assert.equal(settings.get().llm.segmentRuntime, 'direct');
  await settings.update({ llm: { pickerAgent: true } });
  assert.equal(settings.get().llm.requestMatching, 'agentic', 'switching the toggle back on restores agentic requests');
  assert.equal(settings.get().llm.segmentRuntime, 'agentic', 'switching the toggle back on restores agentic segments');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.requestMatching, 'agentic');
  assert.equal(settings.get().llm.segmentRuntime, 'agentic');
  // A legacy write that names a runtime explicitly still keeps that choice.
  await settings.update({ llm: { pickerAgent: false, requestMatching: 'agentic' } });
  assert.equal(settings.get().llm.requestMatching, 'agentic');
  assert.equal(settings.get().llm.segmentRuntime, 'direct');
});

test('a malformed stored choice is treated as absent, so the legacy flag still decides', async () => {
  for (const bad of [null, 'Shortlist', 42, '']) {
    const legacyPool = await coldLoad({ pickerAgent: false, trackSelection: bad, requestMatching: bad, segmentRuntime: bad });
    assert.equal(legacyPool.trackSelection, 'shortlist', `trackSelection ${JSON.stringify(bad)} must not switch a pool station to Agentic`);
    assert.equal(legacyPool.pickerAgent, false);
    assert.equal(legacyPool.requestMatching, 'direct');
    assert.equal(legacyPool.segmentRuntime, 'direct');
    const agentic = await coldLoad({ trackSelection: bad });
    assert.equal(agentic.trackSelection, 'agentic');
    assert.equal(agentic.pickerAgent, true);
  }
});

test('shortlistPasses is clamped to its shared bounds on load', async () => {
  const { SHORTLIST_PASSES_BOUNDS, SHORTLIST_PASSES_DEFAULT } = await import('../src/schemas/settings.js');
  assert.equal((await coldLoad({})).shortlistPasses, SHORTLIST_PASSES_DEFAULT);
  assert.equal((await coldLoad({ shortlistPasses: 0 })).shortlistPasses, SHORTLIST_PASSES_BOUNDS.min);
  assert.equal((await coldLoad({ shortlistPasses: 99 })).shortlistPasses, SHORTLIST_PASSES_BOUNDS.max);
});

test('the Candidate Pool upgrade is announced until a save records the route', async () => {
  const { checkLlm } = await import('../src/doctor/checks-services.js');
  const trackSelectionHint = async () => (await checkLlm(settings.get(), {
    candidatePoolMigrated: settings.migratedFromCandidatePool(),
  })).find((finding) => finding.label === 'track selection')?.hint;

  await coldLoad({ pickerAgent: false });
  assert.equal(settings.migratedFromCandidatePool(), true);
  assert.match(String(await trackSelectionHint()), /retired Candidate Pool/);
  const finding = (await checkLlm(settings.get(), { candidatePoolMigrated: true }))
    .find((f) => f.label === 'track selection');
  assert.equal(finding?.status, 'ok', 'Track Shortlist is a supported route, never a warning');

  // Any save writes the derived route down, after which the station simply
  // has a Shortlist choice like any other.
  await settings.update({ llm: { shortlistPasses: 3 } });
  assert.equal(settings.migratedFromCandidatePool(), false);
  assert.equal(await trackSelectionHint(), undefined);
  setCache(null);
  await settings.load();
  assert.equal(settings.migratedFromCandidatePool(), false, 'and stays retired across a restart');
  assert.equal(settings.get().llm.trackSelection, 'shortlist');

  for (const llm of [{}, { pickerAgent: true }, { pickerAgent: false, trackSelection: 'shortlist' }, { pickerAgent: false, trackSelection: 'agentic' }]) {
    await coldLoad(llm);
    assert.equal(settings.migratedFromCandidatePool(), false, `no notice for ${JSON.stringify(llm)}`);
  }
});
