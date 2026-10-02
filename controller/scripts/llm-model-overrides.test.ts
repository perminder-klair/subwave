// settings.llm.modelOverrides — per-task model routing ("Task Model Overrides"
// in Admin → LLM): heavy tasks ride a larger model while the station default
// stays small and fast.
//
// COLD LOAD, NOT AN IN-PROCESS CHECK. settings.load()'s llm block composes
// explicitly and does NOT spread DEFAULTS, so a field missing from that
// composition still validates, still saves to settings.json, and still works for
// the rest of that process — then silently vanishes on the next restart with
// nothing in the logs (tts.cloud.compatParams #1317, llm.repeatPenalty).
//
// Covers: persistence round trip, load-path sanitising (non-strings dropped,
// blanks dropped), patch replace semantics, primaryLeg() resolution, and the
// ONE-KIND-PER-TASK rule — the override map is keyed by the `kind` a caller
// passes, so a task that reaches two call sites under two different kinds gets
// two override entries, and the editor (which names tasks, not kinds) can only
// ever write one of them. That is a silently dead control, not a missing feature.
//
// No credentials, no external host.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-discovery-steps.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-model-overrides-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { applyLlmLegPatch } = await import('../src/settings/vocab.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

const BASE_LLM = {
  provider: 'openai-compatible',
  model: 'small-flash',
  baseUrl: 'http://127.0.0.1:8080/v1',
};

async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { ...BASE_LLM, ...llm } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('overrides survive a cold load', async () => {
  const llm = await coldLoad({ modelOverrides: { djAgentPick: 'big-pro', matchRequest: '  ' } });
  assert.deepEqual(llm.modelOverrides, { djAgentPick: 'big-pro' });
});

test('absent or malformed overrides read as empty, never wedging boot', async () => {
  assert.deepEqual((await coldLoad({})).modelOverrides, {});
  assert.deepEqual((await coldLoad({ modelOverrides: null })).modelOverrides, {});
  assert.deepEqual((await coldLoad({ modelOverrides: { ok: 'm', bad: 42, nested: {} } })).modelOverrides, { ok: 'm' });
});

test('patch replaces the whole map so clearing a task clears it', async () => {
  await coldLoad({ modelOverrides: { a: 'x', b: 'y' } });
  await settings.update({ llm: { modelOverrides: { a: 'z', b: '' } } } as never);
  assert.deepEqual(settings.get().llm.modelOverrides, { a: 'z' });
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().llm.modelOverrides, { a: 'z' });
});

test('patch rejects non-objects and over-long model ids', async () => {
  await coldLoad({});
  assert.throws(() => applyLlmLegPatch({}, { modelOverrides: ['x'] }, 'llm'), /modelOverrides must be an object/);
  assert.throws(
    () => applyLlmLegPatch({}, { modelOverrides: { a: 'x'.repeat(101) } }, 'llm'),
    /0-100 chars/,
  );
});

test('primaryLeg resolves the override by kind, default otherwise', async () => {
  await coldLoad({ modelOverrides: { djAgentPick: 'big-pro' } });
  assert.equal(primaryLeg('djAgentPick').cfg.model, 'big-pro');
  assert.equal(primaryLeg('matchRequest').cfg.model, 'small-flash');
  assert.equal(primaryLeg().cfg.model, 'small-flash');
});

// The bug this pins: both segment paths used to pass `generateSegment`, so an
// operator's Script Generation override — which the editor writes under
// `djAgentSegment`, the AGENT path's kind — never reached the pool path. With
// `settings.llm.pickerAgent` off that is the only segment path there is, so the
// control saved fine and did nothing. primaryLeg() was never wrong; the callers
// disagreed about what the task is called.
test('the Script Generation override reaches BOTH segment paths', async () => {
  await coldLoad({ modelOverrides: { djAgentSegment: 'big-pro' } });
  assert.equal(primaryLeg('djAgentSegment').cfg.model, 'big-pro');

  // Read the kinds off the source rather than restating them: a test that
  // hardcodes 'djAgentSegment' on both sides still passes if the pool call site
  // drifts back to a pool-only kind, which is the whole regression.
  const src = readFileSync(path.join(process.cwd(), 'src/skills/_agent.ts'), 'utf8');
  const segmentKinds = [...src.matchAll(/kind: '([A-Za-z]+)'/g)].map(m => m[1]);
  assert.ok(segmentKinds.length >= 4, `expected the agent and pool segment call sites, saw ${segmentKinds}`);
  assert.equal(
    new Set(segmentKinds).size,
    1,
    `every segment call site must use ONE kind, saw ${JSON.stringify(segmentKinds)}`,
  );
  for (const kind of segmentKinds) {
    assert.equal(primaryLeg(kind).cfg.model, 'big-pro', `${kind} must resolve the Script Generation override`);
  }
});
