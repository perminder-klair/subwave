// The Doctor's web-search hint and its knowledge base list the backends by
// hand. Both have to name every one the catalogue offers, or an operator stuck
// on a keyed provider is never told a keyless one exists (Parallel shipped
// missing from the hint, #2278).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as settings from '../src/settings.js';
import { checkCapabilities } from '../src/doctor/checks-station.js';
import { DJ_DOC_KNOWLEDGE } from '../src/doctor-knowledge.js';
import { SEARCH_PROVIDER_CATALOG } from '../src/schemas/settings.js';

const names = SEARCH_PROVIDER_CATALOG.map(p => p.label.split(' ')[0]);

test('the not-ready web search hint names every backend, keyless ones as the way out', async () => {
  const envKey = process.env.SEARCH_API_KEY;
  delete process.env.SEARCH_API_KEY;
  const original = structuredClone(settings.get().search);
  try {
    await settings.update({ search: { provider: 'tavily', apiKey: '' } });
    const finding = (await checkCapabilities(settings.get())).find(f => f.label === 'web search');
    assert.equal(finding?.status, 'warn');
    const hint = finding?.hint ?? '';
    for (const name of names) assert.ok(hint.includes(name), `hint names ${name}: ${hint}`);
    const wayOut = hint.slice(hint.indexOf('Or switch to'));
    for (const p of SEARCH_PROVIDER_CATALOG.filter(e => e.group === 'keyless')) {
      assert.ok(wayOut.includes(p.label.split(' ')[0]), `"switch to" offers ${p.id}`);
    }
  } finally {
    await settings.update({ search: original });
    if (envKey !== undefined) process.env.SEARCH_API_KEY = envKey;
  }
});

test('the Doctor knowledge base names every backend', () => {
  for (const name of names) assert.ok(DJ_DOC_KNOWLEDGE.includes(name), name);
});
