// The listener-facing show text (#2358): description first, the topic brief
// as the fallback, so a station that never sets a description reads as before.
//
// Run: `npm test -- lib/showBlurb`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showBlurb } from './showBlurb';

test('a set description wins over the topic brief', () => {
  assert.equal(
    showBlurb({ description: 'Ambient for the small hours.', topic: 'Keep the energy low. Use search_library.' }),
    'Ambient for the small hours.',
  );
});

test('an empty, blank or absent description falls back to the topic', () => {
  assert.equal(showBlurb({ description: '', topic: 'Late-night brief' }), 'Late-night brief');
  assert.equal(showBlurb({ description: '   ', topic: 'Late-night brief' }), 'Late-night brief');
  assert.equal(showBlurb({ topic: 'Late-night brief' }), 'Late-night brief');
  assert.equal(showBlurb({ description: null, topic: 'Late-night brief' }), 'Late-night brief');
});

test('nothing set reads as empty, so callers keep their own placeholder', () => {
  assert.equal(showBlurb({ description: '', topic: '' }), '');
  assert.equal(showBlurb(null), '');
  assert.equal(showBlurb(undefined), '');
});
