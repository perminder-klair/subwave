// Settings search finds the LLM Provider card by any provider's id. locca had
// dropped out of the hand-kept keywords; they now derive from the provider
// catalogue's ids.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_INDEX } from './registry';
import { searchProviderEntry } from '@/lib/schemas.generated';
import { PROVIDERS } from '../llm/providerMeta';

test('the LLM Provider entry is found by every provider id', () => {
  const entry = SETTINGS_INDEX.find(e => e.section === 'llm' && e.card === 'Provider' && e.label === 'Provider');
  assert.ok(entry, 'no LLM Provider entry in SETTINGS_INDEX');
  const words = new Set((entry.keywords ?? '').split(/\s+/));
  assert.deepEqual(PROVIDERS.map(p => p.id).filter(id => !words.has(id)), []);
});

test('Parallel is discoverable as a keyless Web search choice', () => {
  const entry = SETTINGS_INDEX.find(e => e.section === 'search' && e.label === 'Provider');
  assert.ok(entry?.keywords?.split(/\s+/).includes('parallel'));
  assert.equal(searchProviderEntry('parallel')?.key, 'none');
  assert.equal(searchProviderEntry('parallel')?.group, 'keyless');
});
