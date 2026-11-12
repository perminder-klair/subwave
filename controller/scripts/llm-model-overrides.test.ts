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
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-discovery-steps.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-model-overrides-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg, TASK_OVERRIDE_PARENT, resolveModelOverride } = await import('../src/llm/internal/provider/legs.js');
const { applyModelOverridesPatch } = await import('../src/settings/vocab.js');

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
  assert.throws(() => applyModelOverridesPatch({}, { modelOverrides: ['x'] }, 'llm'), /modelOverrides must be an object/);
  assert.throws(
    () => applyModelOverridesPatch({}, { modelOverrides: { a: 'x'.repeat(101) } }, 'llm'),
    /0-100 chars/,
  );
});

test('primaryLeg resolves the override by kind, default otherwise', async () => {
  await coldLoad({ modelOverrides: { djAgentPick: 'big-pro' } });
  assert.equal(primaryLeg('djAgentPick').cfg.model, 'big-pro');
  assert.equal(primaryLeg('matchRequest').cfg.model, 'small-flash');
  assert.equal(primaryLeg().cfg.model, 'small-flash');
});

// Script Generation override reaches both agent (djAgentSegment) and pool
// (generateSegment) call sites via TASK_OVERRIDE_PARENT, while preserving distinct
// telemetry kinds so stats, debug, and llm-bench can tell the paths apart.
test('the Script Generation override reaches BOTH segment paths with telemetry kind distinction', async () => {
  await coldLoad({ modelOverrides: { djAgentSegment: 'big-pro' } });
  assert.equal(primaryLeg('djAgentSegment').cfg.model, 'big-pro');
  assert.equal(primaryLeg('generateSegment').cfg.model, 'big-pro');

  // Read the kinds off the source rather than restating them
  const src = readFileSync(path.join(process.cwd(), 'src/skills/_agent.ts'), 'utf8');
  const segmentKinds = [...src.matchAll(/kind: '([A-Za-z]+)'/g)].map(m => m[1]);
  assert.ok(segmentKinds.length >= 4, `expected the agent and pool segment call sites, saw ${segmentKinds}`);
  assert.ok(segmentKinds.includes('djAgentSegment'), 'expected agent mode to pass djAgentSegment');
  assert.ok(segmentKinds.includes('generateSegment'), 'expected pool mode to pass generateSegment');
  for (const kind of segmentKinds) {
    assert.equal(primaryLeg(kind).cfg.model, 'big-pro', `${kind} must resolve the Script Generation override`);
  }
});

test('applyLlmLegPatch only reads LLM_LEG_FIELDS so swap parity holds', async () => {
  const { applyLlmLegPatch } = await import('../src/settings/vocab.js');
  const { LLM_LEG_FIELDS } = await import('../src/settings/llm-swap.js');
  const read = new Set<string>();
  const recorder = new Proxy({}, {
    get(_t, key) { if (typeof key === 'string') read.add(key); return undefined; },
    has(_t, key) { if (typeof key === 'string') read.add(key); return false; },
  });
  applyLlmLegPatch({}, recorder, 'llm');
  read.delete('baseUrl');
  assert.deepEqual([...read].sort(), [...LLM_LEG_FIELDS].sort());
});

test('sticky primary-down window holds across tasks with and without modelOverrides', async () => {
  const { withFailover, resetFailoverStickyForTest, failoverRoutingSnapshot } = await import('../src/llm/internal/core/failover.js');
  resetFailoverStickyForTest();
  await coldLoad({
    modelOverrides: { djAgentPick: 'big-pro' },
    fallback: { enabled: true, provider: 'openai-compatible', model: 'backup-model', baseUrl: 'http://127.0.0.1:8081/v1' },
  });
  const attempts: string[] = [];
  // Overridden task hits a down primary and starts the sticky window.
  await withFailover('djAgentPick', () => ({}), async (leg) => {
    attempts.push(leg.label);
    if (leg.label === 'openai-compatible:big-pro') {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
    }
    return { value: 'backup-1', via: 'test' };
  });
  assert.ok(failoverRoutingSnapshot()?.retryPrimaryAt, 'overridden task started the sticky window');
  // Next call is an un-overridden task: must honour the sticky window instead of clearing it.
  await withFailover('matchRequest', () => ({}), async (leg) => {
    attempts.push(leg.label);
    return { value: 'backup-2', via: 'test' };
  });
  assert.deepEqual(attempts, [
    'openai-compatible:big-pro',
    'openai-compatible:backup-model',
    'openai-compatible:backup-model',
  ]);
  resetFailoverStickyForTest();
});

test('all 7 parent task controls resolve their respective overrides via primaryLeg', async () => {
  const overrides = {
    generateBanter: 'model-banter',
    djAgentSegment: 'model-segment',
    generateIntro: 'model-intro',
    djAgentPick: 'model-pick',
    djAgentRequest: 'model-request',
    matchRequest: 'model-match',
    identifyRequest: 'model-identify',
  };
  await coldLoad({ modelOverrides: overrides });

  for (const [task, expectedModel] of Object.entries(overrides)) {
    assert.equal(primaryLeg(task).cfg.model, expectedModel, `${task} must resolve to ${expectedModel}`);
  }
});

test('sub-calls inherit parent model override for all 7 parent tasks', async () => {
  const overrides = {
    generateBanter: 'model-banter',
    djAgentSegment: 'model-segment',
    generateIntro: 'model-intro',
    djAgentPick: 'model-pick',
    djAgentRequest: 'model-request',
    matchRequest: 'model-match',
    identifyRequest: 'model-identify',
  };
  await coldLoad({ modelOverrides: overrides });

  for (const [subCall, parentTask] of Object.entries(TASK_OVERRIDE_PARENT)) {
    const expectedModel = overrides[parentTask as keyof typeof overrides];
    assert.equal(
      resolveModelOverride(subCall, overrides),
      expectedModel,
      `resolveModelOverride(${subCall}) must inherit from ${parentTask}`,
    );
    assert.equal(
      primaryLeg(subCall).cfg.model,
      expectedModel,
      `primaryLeg(${subCall}) must resolve inherited model from ${parentTask}`,
    );
  }
});

test('direct sub-call override takes precedence over parent task override', async () => {
  await coldLoad({
    modelOverrides: {
      generateIntro: 'parent-intro-model',
      generateHourlyTime: 'direct-hourly-model',
      djAgentPick: 'parent-pick-model',
      djShortlistPick: 'direct-shortlist-model',
    },
  });

  // Direct overrides win
  assert.equal(primaryLeg('generateHourlyTime').cfg.model, 'direct-hourly-model');
  assert.equal(primaryLeg('djShortlistPick').cfg.model, 'direct-shortlist-model');

  // Sibling sub-calls without direct override still inherit parent
  assert.equal(primaryLeg('generateLink').cfg.model, 'parent-intro-model');
  assert.equal(primaryLeg('generateStationId').cfg.model, 'parent-intro-model');
  assert.equal(primaryLeg('pickNextTrack').cfg.model, 'parent-pick-model');
  assert.equal(primaryLeg('djAgentPick').cfg.model, 'parent-pick-model');
});

test('telemetry kind is preserved in withFailover and recentCalls while model is overridden', async () => {
  const { withFailover } = await import('../src/llm/internal/core/failover.js');
  const { recentCalls } = await import('../src/llm/internal/telemetry/log.js');

  await coldLoad({
    modelOverrides: {
      generateIntro: 'inherited-intro-model',
      djAgentSegment: 'inherited-segment-model',
    },
  });

  // Call withFailover using sub-call kind 'generateLink'
  let capturedLegLabel = '';
  await withFailover('generateLink', () => ({}), async (leg) => {
    capturedLegLabel = leg.label;
    return { value: 'intro-link-text', via: 'test' };
  });

  assert.equal(capturedLegLabel, 'openai-compatible:inherited-intro-model');
  assert.equal(recentCalls[0].kind, 'generateLink', 'telemetry kind must remain generateLink, not parent');
  assert.equal(recentCalls[0].model, 'openai-compatible:inherited-intro-model');

  // Call withFailover using pool segment kind 'generateSegment'
  await withFailover('generateSegment', () => ({}), async (leg) => {
    capturedLegLabel = leg.label;
    return { value: 'pool-segment-text', via: 'test' };
  });

  assert.equal(capturedLegLabel, 'openai-compatible:inherited-segment-model');
  assert.equal(recentCalls[0].kind, 'generateSegment', 'telemetry kind must remain generateSegment, not parent');
  assert.equal(recentCalls[0].model, 'openai-compatible:inherited-segment-model');
});


