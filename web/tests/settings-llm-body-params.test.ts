import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { dirtyPaths } from '../components/admin/settings/form-diff';
import { sectionById } from '../components/admin/settings/registry';
import {
  LLM_BODY_PARAM_PRESETS, bodyParamProblem, bodyParamsPayload, fillBodyParamsPreset,
} from '../components/admin/settings/llmBodyParams';

// The LLM leg's request-body lists (#2296). The "Fill for…" preset must only
// edit the form: nothing reaches settings until the operator saves, so the
// saved baseline stays put and the save bar shows the change as unsaved.

const stored = {
  llm: {
    bodyParams: [{ key: 'top_k', value: '20' }, { key: 'enable_thinking', value: 'true' }],
    toolCallBodyParams: [{ key: 'thinking_budget', value: 'null' }],
    fallback: { bodyParams: [{ key: 'seed', value: '7' }] },
  },
};

test('both lists hydrate per leg, and a settings read without them is empty', () => {
  const form = settingsForm(stored as never);
  assert.deepEqual(form.llm.bodyParams, stored.llm.bodyParams);
  assert.deepEqual(form.llm.toolCallBodyParams, stored.llm.toolCallBodyParams);
  assert.deepEqual(form.llm.fallback.bodyParams, [{ key: 'seed', value: '7' }]);
  assert.deepEqual(form.llm.fallback.toolCallBodyParams, []);
  const bare = settingsForm({ llm: {} } as never);
  assert.deepEqual(bare.llm.bodyParams, []);
  assert.deepEqual(bare.llm.toolCallBodyParams, []);
});

test('the Hetzner / vLLM Qwen preset fills the form without saving', () => {
  const baseline = settingsForm(stored as never);
  const before = JSON.stringify(baseline);
  assert.deepEqual(LLM_BODY_PARAM_PRESETS.map(p => p.id), ['hetzner-qwen'], 'only tested presets ship');

  const form = fillBodyParamsPreset('primary', 'hetzner-qwen')(baseline);
  // Same-name row takes the preset value in place; the operator's other rows stay.
  assert.deepEqual(form.llm.bodyParams, [{ key: 'top_k', value: '20' }, { key: 'enable_thinking', value: 'false' }]);
  assert.deepEqual(form.llm.toolCallBodyParams, baseline.llm.toolCallBodyParams, 'overrides untouched');
  assert.deepEqual(form.llm.fallback, baseline.llm.fallback, 'the other leg is untouched');
  // Nothing saved: the baseline object is unchanged and the section reads dirty.
  assert.equal(JSON.stringify(baseline), before);
  const keys: readonly string[] = sectionById('llm')?.formKeys ?? [];
  assert.ok(keys.includes('llm.bodyParams'), 'the LLM section tracks the list');
  assert.deepEqual(dirtyPaths(form, baseline, keys), ['llm.bodyParams']);

  // On the backup leg it fills the backup's own list, appending the row.
  const fb = fillBodyParamsPreset('fallback', 'hetzner-qwen')(baseline);
  assert.deepEqual(fb.llm.fallback.bodyParams, [{ key: 'seed', value: '7' }, { key: 'enable_thinking', value: 'false' }]);
  assert.deepEqual(fb.llm.bodyParams, baseline.llm.bodyParams);
});

test('the save payload trims rows and drops untouched blank ones', () => {
  assert.deepEqual(
    bodyParamsPayload([{ key: ' enable_thinking ', value: ' false ' }, { key: '', value: '' }]),
    [{ key: 'enable_thinking', value: 'false' }],
  );
});

test('the editor flags what a save would refuse', () => {
  const reserved = { key: 'tool_choice', value: 'auto' };
  assert.match(bodyParamProblem(reserved, [reserved]), /SUB\/WAVE sets "tool_choice"/);
  assert.match(bodyParamProblem({ key: 'a b', value: '1' }, []), /letters, digits/);
  const first = { key: 'x', value: '1' };
  assert.match(bodyParamProblem(first, [first, { key: 'x', value: '2' }]), /listed twice/);
  assert.equal(bodyParamProblem({ key: 'enable_thinking', value: 'false' }, []), '');
  assert.equal(bodyParamProblem({ key: '', value: '' }, []), '');
});
