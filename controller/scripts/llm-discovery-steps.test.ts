// settings.llm.discoverySteps — the operator override on how many discovery
// rounds the DJ agent gets before `done` is forced.
//
// Every case COLD LOADS: load()'s llm block composes explicitly without
// spreading DEFAULTS, so a field missing there works for the rest of the
// process and vanishes on the next restart (#1317, #918 → #1327). The second
// half checks the value reaches its consumers, the harness and the prompt.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected before the first config-derived import.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-discovery-steps-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { discoveryStepsFor, gatedMaxStepsFor, DISCOVERY_STEPS_MAX } =
  await import('../src/llm/internal/provider/capabilities.js');
const { promptDiscoverySteps } = await import('../src/llm/internal/provider/legs.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// A forced-tool provider (capability default 1).
const LOCAL_LLM = {
  provider: 'openai-compatible',
  model: 'qwen3-8b',
  baseUrl: 'http://127.0.0.1:8080/v1',
};
// A native-strategy provider (capability default 3).
const CLOUD_LLM = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };

async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { ...LOCAL_LLM, ...llm } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('0 means auto: an untouched install still follows the capability table', async () => {
  // Upgrading to a build with this setting must change no station's behaviour.
  const llm = await coldLoad({});
  assert.equal(llm.discoverySteps, 0, 'default is the auto sentinel');
  assert.equal(discoveryStepsFor(llm), 1, 'forced-tool provider keeps its 1');
  assert.equal(discoveryStepsFor({ ...CLOUD_LLM, discoverySteps: 0 }), 3, 'native provider keeps its 3');
});

test('an override survives a controller restart and reaches the harness', async () => {
  const llm = await coldLoad({ discoverySteps: 3 });
  assert.equal(llm.discoverySteps, 3);
  // Persisting is only half of it; this is the consumer deciding the loop.
  assert.equal(discoveryStepsFor(llm), 3);
});

test('the override wins over the provider default in BOTH directions', async () => {
  // Up, on a forced-tool provider whose descriptor says 1.
  assert.equal(discoveryStepsFor(await coldLoad({ discoverySteps: 4 })), 4);
  // Down, on a native provider whose descriptor says 3.
  const narrowed = await coldLoad({ ...CLOUD_LLM, discoverySteps: 1 });
  assert.equal(discoveryStepsFor(narrowed), 1);
});

test('the derived cap still leaves exactly one forced-done step at any override', async () => {
  // Widening discovery must never widen the number of `done` attempts.
  for (const n of [1, 2, 3, 4, 5]) {
    const llm = await coldLoad({ discoverySteps: n });
    assert.equal(gatedMaxStepsFor(llm) - discoveryStepsFor(llm), 1, `override ${n}`);
  }
});

test('a stored override is clamped, and junk falls back to the default', async () => {
  assert.equal((await coldLoad({ discoverySteps: 99 })).discoverySteps, DISCOVERY_STEPS_MAX);
  // Negative is nonsense; 0 is the documented "auto", so both land on auto.
  assert.equal((await coldLoad({ discoverySteps: -3 })).discoverySteps, 0);
  assert.equal((await coldLoad({ discoverySteps: 0 })).discoverySteps, 0);
  // A fractional value floors rather than being refused.
  assert.equal((await coldLoad({ discoverySteps: 2.7 })).discoverySteps, 2);
  // A string is not a number; the clamp refuses to guess.
  assert.equal((await coldLoad({ discoverySteps: '3' })).discoverySteps, 0);
  // Absent (written before the field existed) → the default.
  assert.equal((await coldLoad({})).discoverySteps, 0);
});

test('a hand-edited settings.json can never corner the model at step 0', async () => {
  // A 0-round budget forces `done` with an empty `seen` map, where the model
  // can only fabricate an id.
  for (const junk of [0, -1, -99, 0.2, null, 'nope', undefined]) {
    const llm = await coldLoad({ discoverySteps: junk as any });
    assert.ok(discoveryStepsFor(llm) >= 1, `discoverySteps=${String(junk)} resolved below 1`);
  }
});

test('the fallback leg carries its own override across a restart', async () => {
  // Per-leg like toolChoice/numCtx: the backup may be a different provider.
  const llm = await coldLoad({
    discoverySteps: 3,
    fallback: { enabled: true, provider: 'ollama', model: 'qwen3', discoverySteps: 2 },
  });
  assert.equal(llm.fallback.discoverySteps, 2);
  assert.equal(discoveryStepsFor(llm.fallback), 2);
  assert.equal(discoveryStepsFor(llm), 3, 'and the primary is unaffected');
});

test('saving an override then restarting keeps it — the operator story', async () => {
  await coldLoad({});
  await settings.update({ llm: { discoverySteps: 3 } } as any);
  assert.equal(settings.get().llm.discoverySteps, 3, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.discoverySteps, 3, 'and survives the restart');
});

test('the per-provider budget reaches only the agents that opted in', async () => {
  const { runDiscoverySteps } = await import('../src/llm/internal/provider/capabilities.js');
  const llm = await coldLoad({ ...CLOUD_LLM, discoverySteps: 5 });
  assert.equal(runDiscoverySteps(llm, true), 5, 'opted-in agents follow descriptor + override');
  assert.equal(runDiscoverySteps(llm, false), 1, 'everyone else keeps the single historical step');

  const { pickerAgent, requestAgent } = await import('../src/broadcast/dj-agent/agents.js');
  assert.equal(pickerAgent.providerDiscoveryBudget, true, 'picker opts in');
  assert.equal(requestAgent.providerDiscoveryBudget, true, 'request matcher opts in');
});

test('the prompt promises the MINIMUM across the legs that could run', async () => {
  // The system prompt is built before withFailover picks a leg, so promising
  // the primary's budget can promise a look the backup never gives.
  await coldLoad({ ...CLOUD_LLM, discoverySteps: 3 });
  assert.equal(promptDiscoverySteps(), 3, 'no fallback → the primary\'s own budget');

  await coldLoad({
    ...CLOUD_LLM,
    discoverySteps: 3,
    fallback: { enabled: true, provider: 'ollama', model: 'qwen3' },
  });
  assert.equal(promptDiscoverySteps(), 1, 'a narrower fallback pulls the promise down');

  // A DISABLED fallback can never run, so it must not narrow anything.
  await coldLoad({
    ...CLOUD_LLM,
    discoverySteps: 3,
    fallback: { enabled: false, provider: 'ollama', model: 'qwen3' },
  });
  assert.equal(promptDiscoverySteps(), 3);
});
