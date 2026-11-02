// "Swap with primary" in the admin Settings form (#1970 review, finding 1).
//
// The controller writes the swap, so the browser has no submitted patch to
// re-baseline, and the panel holds every new server revision back while ANY
// section is dirty. Pinned here:
//   - the button's gate is "unsaved anywhere", not "unsaved on the LLM page":
//     a dirty Library tagger leaves the LLM section clean but must still block;
//   - after a swap made with another section dirty, the swapped llm/embedding
//     keys are adopted from the authoritative read into BOTH the form and its
//     baseline, so the LLM page shows the new legs and a later Library tagger
//     save posts the pinned embedding values instead of the stale inherited
//     blanks that would un-pin them — while the operator's own unsaved edits
//     (elsewhere, or made during the request) survive and stay dirty;
//   - the confirm dialog names the embedding fields the swap will pin (#1970
//     review, finding 7), in the Library tagger's words.

import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { dirtyPaths, unsavedAnywhere } from '../components/admin/settings/form-diff';
import {
  adoptServerPaths, committedReadReady, LLM_SWAP_FORM_KEYS,
} from '../components/admin/settings/form-reconciliation';
import { LLM_PROVIDER_FORM_KEYS, sectionById } from '../components/admin/settings/registry';
import { pinnedFieldNames } from '../components/admin/settings/llm-swap-copy';

const PRE = {
  station: 'Station',
  llm: {
    provider: 'ollama', model: 'qwen3:14b', ollamaUrl: 'http://gpu-box:11434',
    providerBaseUrls: {}, headers: {},
    fallback: {
      enabled: true, provider: 'openai-compatible', model: 'deepseek-v4-flash',
      providerBaseUrls: { 'openai-compatible': 'https://gateway.example/v1' },
      headers: { 'x-session': 'set' },
    },
  },
  embedding: { provider: '', model: '', ollamaUrl: '', headers: {}, batchSize: 25 },
};

// What GET /settings answers after the swap: legs exchanged, and the embedding
// leg that was inheriting the Ollama primary pinned to it.
const POST = {
  station: 'Station',
  llm: {
    provider: 'openai-compatible', model: 'deepseek-v4-flash', ollamaUrl: '',
    providerBaseUrls: { 'openai-compatible': 'https://gateway.example/v1' },
    headers: { 'x-session': 'set' },
    fallback: {
      enabled: true, provider: 'ollama', model: 'qwen3:14b', ollamaUrl: 'http://gpu-box:11434',
      providerBaseUrls: {}, headers: {},
    },
  },
  embedding: { provider: 'ollama', model: '', ollamaUrl: 'http://gpu-box:11434', headers: {}, batchSize: 25 },
};

test('the swap gate sees a dirty Library tagger from the LLM page', () => {
  const baseline = settingsForm(PRE);
  const form = structuredClone(baseline);
  form.embedding.batchSize = '50';

  const llmSection = sectionById('llm');
  assert.deepEqual(llmSection?.formKeys, LLM_PROVIDER_FORM_KEYS);
  assert.deepEqual(dirtyPaths(form, baseline, LLM_PROVIDER_FORM_KEYS), [], 'the LLM section itself is clean');
  assert.equal(unsavedAnywhere(form, baseline, false), true, 'yet the swap must stay blocked');
  assert.equal(unsavedAnywhere(baseline, baseline, false), false);
  assert.equal(unsavedAnywhere(baseline, baseline, true), true, 'a section-local edit counts too');
});

test('a swap with another section dirty adopts the swapped keys and keeps the edits', () => {
  const baseline = settingsForm(PRE);
  const form = structuredClone(baseline);
  form.embedding.batchSize = '50';
  form.station = 'Unsaved station';
  const server = settingsForm(POST);

  const result = adoptServerPaths(baseline, form, server, LLM_SWAP_FORM_KEYS);

  // The LLM page shows the swapped legs, clean.
  assert.deepEqual(result.form.llm, server.llm);
  assert.deepEqual(result.baseline.llm, server.llm);
  assert.deepEqual(dirtyPaths(result.form, result.baseline, LLM_PROVIDER_FORM_KEYS), []);

  // The Library tagger now holds the pins: its next save posts provider
  // 'ollama' and the Ollama URL, not the inherited blanks that would un-pin.
  assert.equal(result.form.embedding.provider, 'ollama');
  assert.equal(result.form.embedding.ollamaUrl, 'http://gpu-box:11434');
  assert.equal(result.form.embedding.batchSize, '50', 'the unsaved batch size survives');
  assert.deepEqual(result.baseline.embedding, server.embedding);

  // Exactly the operator's own edits are still unsaved.
  assert.deepEqual(dirtyPaths(result.form, result.baseline, ['station', 'llm', 'embedding']), ['station', 'embedding']);
  assert.equal(result.form.station, 'Unsaved station');
  assert.equal(result.baseline.station, 'Station');
});

test('an LLM edit made while the swap was in flight stays the operator\'s, and dirty', () => {
  const baseline = settingsForm(PRE);
  const form = structuredClone(baseline);
  form.llm.fallback.numCtx = 8192;
  form.llm.providerBaseUrls = { locca: 'http://locca:8080/v1' };
  const server = settingsForm(POST);

  const result = adoptServerPaths(baseline, form, server, LLM_SWAP_FORM_KEYS);

  assert.equal(result.form.llm.provider, 'openai-compatible', 'untouched leaves take the swap');
  assert.equal(result.form.llm.fallback.provider, 'ollama');
  assert.equal(result.form.llm.fallback.numCtx, 8192, 'the edited leaf is kept');
  assert.equal(result.baseline.llm.fallback.numCtx, server.llm.fallback.numCtx);
  assert.deepEqual(
    result.form.llm.providerBaseUrls,
    { 'openai-compatible': 'https://gateway.example/v1', locca: 'http://locca:8080/v1' },
    'a map merges per key: the swap adds its URL, the operator keeps theirs',
  );
  assert.deepEqual(dirtyPaths(result.form, result.baseline, LLM_PROVIDER_FORM_KEYS), ['llm.providerBaseUrls', 'llm.fallback']);
});

test('a key the swap removed is removed unless the operator was editing it', () => {
  const pre = structuredClone(PRE);
  pre.llm.providerBaseUrls = { locca: 'http://old:8080/v1' } as Record<string, string>;
  const baseline = settingsForm(pre);
  const result = adoptServerPaths(baseline, structuredClone(baseline), settingsForm(POST), LLM_SWAP_FORM_KEYS);
  assert.deepEqual(result.form.llm.providerBaseUrls, { 'openai-compatible': 'https://gateway.example/v1' });
  assert.deepEqual(result.form, result.baseline);
});

test('only a read that reflects the committed swap is adopted', () => {
  const swap = { refreshedAt: 200, refreshAfter: 201 };
  assert.equal(committedReadReady(swap, 199), false, 'a pre-swap poll');
  assert.equal(committedReadReady(swap, 200), true, 'the swap\'s own authoritative read');
  const failed = { refreshAfter: 300 };
  assert.equal(committedReadReady(failed, 0), false, 'the stale envelope a failed read leaves');
  assert.equal(committedReadReady(failed, 301), true, 'a later successful poll');
});

test('the confirm dialog names the pinned Library-tagger fields in its own words', () => {
  assert.equal(pinnedFieldNames([]), '');
  assert.equal(pinnedFieldNames(['provider']), 'provider');
  assert.equal(pinnedFieldNames(['provider', 'ollamaUrl']), 'provider and Ollama URL');
  assert.equal(
    pinnedFieldNames(['provider', 'providerBaseUrls', 'headers', 'apiKey']),
    'provider, base URL, custom headers and API key',
  );
});
