import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moodVocab } from '../src/settings.js';
import { taggerBatchSystem, taggerSystem } from '../src/music/tagger-core.js';

const RAW_JSON_ONLY = /\b(?:return|output)\s+only\s+(?:a\s+)?json object\b/i;
const UNKNOWN_TRACK_FALLBACK = /\{"moods":\[\],"energy":"medium"\}/;
const ALLOWED_ENERGIES = /"low"\s*\|\s*"medium"\s*\|\s*"high"/;

function assertSharedTaggingContract(prompt: string): void {
  assert.doesNotMatch(prompt, RAW_JSON_ONLY, 'prompt must not prescribe a raw JSON-only response');
  assert.match(prompt, ALLOWED_ENERGIES, 'prompt keeps the allowed energy values');
  assert.ok(
    prompt.includes(moodVocab().join(', ')),
    'prompt includes the complete live mood vocabulary',
  );
  assert.match(prompt, UNKNOWN_TRACK_FALLBACK, 'prompt keeps the unknown-track fallback');
  assert.match(prompt, /Do not invent\./, 'prompt keeps the anti-invention guidance');
}

test('single-track tagger prompt is transport-neutral and preserves its result contract', () => {
  const prompt = taggerSystem();

  assertSharedTaggingContract(prompt);
  assert.match(prompt, /"moods": \[1-3 strings/, 'prompt keeps the one-to-three moods constraint');
  assert.match(prompt, /"energy":/, 'prompt keeps the energy field');
});

test('batch tagger prompt is transport-neutral and preserves count and order constraints', () => {
  const prompt = taggerBatchSystem();

  assertSharedTaggingContract(prompt);
  assert.match(prompt, /"results": \[/, 'prompt keeps the results array shape');
  assert.match(prompt, /moods: 1-3 strings/, 'prompt keeps the per-entry mood constraint');
  assert.match(prompt, /exactly one entry per input track/i, 'prompt keeps the batch cardinality');
  assert.match(prompt, /same order as the numbered list/i, 'prompt keeps input order');
  assert.match(prompt, /for that entry/i, 'prompt scopes the unknown fallback to one batch entry');
});
