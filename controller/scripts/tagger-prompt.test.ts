// The tagger prompts state the tagging CONTRACT and nothing about transport.
//
// Two different rules are pinned here, and they fail for different reasons:
//
//   1. Contract — the vocabulary, the three energies, and (batch) one entry per
//      input track in input order. These are not prose preferences: sanitizeTag
//      drops any mood outside moodVocab() and nulls any energy outside the three,
//      and tagBatch THROWS on a length mismatch and maps results positionally.
//      A prompt that stops stating them degrades silently into empty tags.
//
//   2. No transport wording — issue #1536. Which output channel a tag call uses
//      is chosen per LEG inside djObject: a forced `emit` tool call for
//      ollama/openai-compatible/locca, the provider's native structured output
//      for the cloud providers, free text on the recovery attempt. Each branch
//      states its own rule (EMIT_ANSWER_INSTRUCTION / NATIVE_JSON_INSTRUCTION /
//      the recovery prompt). A prompt written here cannot know which branch it
//      will run down, so any channel wording it carries is wrong on two of the
//      three — "Return ONLY a JSON object" met toolChoice:'required' and
//      gemma-4-12b on llama.cpp deadlocked choosing between them, tagging zero
//      tracks. The guard is a word ban rather than a phrase match on purpose:
//      the earlier regex matched only the two exact sentences that were removed,
//      so "Output only JSON" or "do not call a tool" would have sailed past it.
//      Describe the result with the literal example already in the prompt; never
//      name a serialisation format or an answer channel.
//
// The other half of rule 2 — that the forced-tool branch DOES carry its
// instruction — is pinned in scripts/llm-pure.test.ts against a mock model.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moodVocab } from '../src/settings.js';
import { taggerBatchSystem, taggerSystem } from '../src/music/tagger-core.js';

// Words that only ever appear in a prompt to name a wire format or an answer
// channel. None of them can occur in a mood/energy tagging contract, and none
// collides with the shipped mood vocabulary.
const TRANSPORT_WORDS = [
  'json',
  'tool',
  'markdown',
  'fence',
  'code block',
  'plain text',
  'respond with',
  'reply with',
];

function assertSharedTaggingContract(label: string, prompt: string): void {
  const lower = prompt.toLowerCase();
  for (const word of TRANSPORT_WORDS) {
    assert.ok(
      !lower.includes(word),
      `${label} must not name an output channel or wire format (found "${word}") — `
        + 'djObject picks the channel per leg and states the rule itself (#1536)',
    );
  }
  assert.ok(
    prompt.includes(moodVocab().join(', ')),
    `${label} includes the complete live mood vocabulary — sanitizeTag drops anything outside it`,
  );
  assert.match(
    prompt,
    /"low" \| "medium" \| "high"/,
    `${label} keeps the three allowed energies — sanitizeTag nulls anything else`,
  );
  assert.match(prompt, /\{"moods":\[\],"energy":"medium"\}/, `${label} keeps the unknown-track fallback`);
}

test('single-track tagger prompt states the contract and no transport', () => {
  const prompt = taggerSystem();

  assertSharedTaggingContract('taggerSystem()', prompt);
  assert.match(prompt, /"moods": \[1-3 strings/, 'keeps the one-to-three moods constraint');
});

test('batch tagger prompt additionally pins cardinality and order', () => {
  const prompt = taggerBatchSystem();

  assertSharedTaggingContract('taggerBatchSystem()', prompt);
  assert.match(prompt, /"results": \[/, 'keeps the results array shape');
  assert.match(prompt, /moods: 1-3 strings/, 'keeps the per-entry mood constraint');
  // tagBatch throws `batch length mismatch` and maps results positionally, so
  // both halves of this are load-bearing, not phrasing.
  assert.match(prompt, /exactly one entry per input track/i, 'keeps the batch cardinality');
  assert.match(prompt, /same order as the numbered list/i, 'keeps input order');
  assert.match(prompt, /for that entry/i, 'scopes the unknown fallback to one batch entry');
});
