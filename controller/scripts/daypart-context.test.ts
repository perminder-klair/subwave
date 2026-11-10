// Issue #1411: a midday DJ link was prompted to address people working at
// night. The shared link-angle list feeds both the session agent and the pool
// fallback, so a time-specific suggestion here must be supported by the
// context the model actually receives.

import assert from 'node:assert/strict';
import test from 'node:test';

import { decoratePrompt } from '../src/llm/internal/prompts/context.js';

test('a midday link prompt does not suggest an unsupported late-shift moment', () => {
  const originalRandom = Math.random;
  // Select the listener-moment angle deterministically (index 6 of 9).
  Math.random = () => 0.7;
  try {
    const prompt = decoratePrompt(
      'Local time: 12:45 pm\nPeriod: midday (lunch hour)',
      { kind: 'link' },
    );
    assert.doesNotMatch(prompt, /commute|late shift|weekend|midweek lull/i);
  } finally {
    Math.random = originalRandom;
  }
});
