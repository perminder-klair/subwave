import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { dirtyPaths } from '../components/admin/settings/form-diff';
import { sectionById } from '../components/admin/settings/registry';
import {
  REASONING_EFFORT_OPTIONS, hostedReasoningHint, reasoningEffortHiddenHint, reasoningEffortHint,
  reasoningEffortShown, setReasoningEffort,
} from '../components/admin/settings/reasoningEffort';

// The reasoning level under each leg's Reasoning switch (#2296). The picker's
// visibility is the controller's predicate (schemas/reasoning.ts, mirrored),
// so it shows exactly where the controller sends a level.

const leg = (provider: string, model: string, compatibleMode: 'local' | 'hosted' = 'local') => ({ provider, model, compatibleMode });

test('the picker shows where a leg can express a level, and nowhere else', () => {
  const shown = [
    leg('anthropic', 'claude-sonnet-4-5'), leg('anthropic', 'claude-opus-4-7'), leg('openai', 'gpt-5'),
    leg('google', 'gemini-2.5-flash'), leg('deepseek', 'deepseek-v4-flash'), leg('openrouter', 'qwen/qwen3-235b'),
    leg('gateway', 'openai/gpt-5'), leg('requesty', 'anthropic/claude-sonnet-4-5'),
    leg('openai-compatible', 'claude-sonnet-4-5', 'hosted'),
  ];
  const hidden = [
    leg('ollama', 'gpt-oss:20b'), leg('locca', 'qwen3'), leg('openai-compatible', 'claude-sonnet-4-5', 'local'),
    leg('openai-compatible', 'Qwen/Qwen3.6-35B-A3B-FP8', 'hosted'), leg('google', 'gemma-3-27b-it'),
    leg('gateway', 'google/gemma-3-27b'), leg('openai', 'gpt-4o'),
  ];
  for (const l of shown) assert.equal(reasoningEffortShown(l), true, JSON.stringify(l));
  for (const l of hidden) assert.equal(reasoningEffortShown(l), false, JSON.stringify(l));
  assert.deepEqual(REASONING_EFFORT_OPTIONS.map(o => o.id), ['default', 'low', 'medium', 'high']);
});

test('the hints: manual Claude budgets, Request parameters where the picker is hidden, a Claude proxy honours the switch', () => {
  // Default is Low's 1k budget on every manual-thinking id (#2357), never the SDK's 30% share.
  const manualHint = 'Thinking tokens per reply on this model: Default and Low up to ~1k, Medium 2k, High 4k. A DJ line is about 150 tokens, so the default is usually plenty.';
  assert.equal(reasoningEffortHint(leg('anthropic', 'claude-sonnet-4-5')), manualHint);
  assert.equal(reasoningEffortHint(leg('anthropic', 'claude-opus-4-1')), manualHint);
  assert.doesNotMatch(reasoningEffortHint(leg('anthropic', 'claude-opus-4-7')), /thinking tokens/, 'adaptive ids have no budget');
  assert.doesNotMatch(reasoningEffortHint(leg('openai-compatible', 'claude-sonnet-4-5', 'hosted')), /thinking tokens/, 'a proxy gets no budget');
  assert.match(reasoningEffortHint(leg('deepseek', 'deepseek-v4-flash')), /Medium as High/);

  assert.match(reasoningEffortHiddenHint(leg('openai-compatible', 'Qwen/Qwen3.6-35B-A3B-FP8', 'hosted')), /Request parameters/);
  assert.match(reasoningEffortHiddenHint(leg('locca', 'qwen3')), /Request parameters/);
  assert.equal(reasoningEffortHiddenHint(leg('ollama', 'qwen3')), '', 'no Request parameters to point at');
  assert.equal(reasoningEffortHiddenHint(leg('openai', 'gpt-4o')), '');

  assert.match(hostedReasoningHint('claude-sonnet-4-5', false), /honours this switch/);
  assert.match(hostedReasoningHint('Qwen/Qwen3.6-35B-A3B-FP8', true), /ignored for this backup/);
});

test('both legs hydrate their level; absent or unknown reads Default', () => {
  const form = settingsForm({ llm: { reasoningEffort: 'low', fallback: { reasoningEffort: 'high' } } } as never);
  assert.equal(form.llm.reasoningEffort, 'low');
  assert.equal(form.llm.fallback.reasoningEffort, 'high');
  const bare = settingsForm({ llm: { reasoningEffort: 'ultra' } } as never);
  assert.equal(bare.llm.reasoningEffort, 'default');
  assert.equal(bare.llm.fallback.reasoningEffort, 'default');
});

test('picking a level edits the form and reads as unsaved, per leg', () => {
  const baseline = settingsForm({ llm: { provider: 'anthropic', reasoning: true } } as never);
  const keys: readonly string[] = sectionById('llm')?.formKeys ?? [];
  const primary = setReasoningEffort('primary', 'medium')(baseline);
  assert.equal(primary.llm.reasoningEffort, 'medium');
  assert.equal(baseline.llm.reasoningEffort, 'default', 'baseline untouched');
  assert.deepEqual(dirtyPaths(primary, baseline, keys), ['llm.reasoningEffort']);
  const backup = setReasoningEffort('fallback', 'low')(baseline);
  assert.equal(backup.llm.fallback.reasoningEffort, 'low');
  assert.equal(backup.llm.reasoningEffort, 'default');
  assert.deepEqual(dirtyPaths(backup, baseline, keys), ['llm.fallback']);
});
