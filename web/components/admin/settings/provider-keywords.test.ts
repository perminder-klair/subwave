// Settings search finds the LLM Provider card by any provider's id. locca had
// dropped out of the hand-kept keywords; they now derive from the provider
// catalogue's ids.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SETTINGS_INDEX } from './registry';
import { SEARCH_PROVIDER_CATALOG, searchProviderEntry } from '@/lib/schemas.generated';
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

// Prose that lists the web-search backends by hand has to keep up with the
// catalogue: Parallel shipped missing from both of these (#2278).
test('the hand-written provider lists name every web-search backend', () => {
  const section = readFileSync(join(process.cwd(), 'components/admin/settings/SearchSection.tsx'), 'utf8');
  const manual = readFileSync(join(process.cwd(), 'components/manual/AdminSettings.tsx'), 'utf8');
  const header = section.match(/eyebrow="web search"[\s\S]*?metrics=/)?.[0] ?? '';
  const manualItem = manual.match(/<strong>Web search<\/strong>[\s\S]*?<\/li>/)?.[0] ?? '';
  assert.ok(header && manualItem, 'both passages located');
  for (const p of SEARCH_PROVIDER_CATALOG) {
    const name = p.label.split(' ')[0] ?? p.label;
    assert.ok(header.includes(name), `Settings → Web search header names ${name}`);
    assert.ok(manualItem.includes(name), `manual Admin Settings page names ${name}`);
  }
});
