// Every LLM provider that takes a key gets a placeholder in its key field.
// KEY_HINTS is keyed by env var. Requesty shipped with a blank key input while
// it was hand-kept; its LLM half now comes from the provider catalogue's
// keyPlaceholder, and this guards that derivation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_HINTS } from './shared';
import { PROVIDERS } from '../llm/providerMeta';

test('every keyed LLM provider has a key-field hint', () => {
  const missing = PROVIDERS.filter(p => p.envVar && !KEY_HINTS[p.envVar]).map(p => p.id);
  assert.deepEqual(missing, []);
});
