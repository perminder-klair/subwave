// Show editor side of the listener description (#2358): the field survives the
// editor's hydrate → payload round trip, so a save never drops it.
//
// Run: `npm test -- show-description`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateShow, showPayload } from './lib';

test('hydrate then payload keeps the description, trimmed', () => {
  const show = hydrateShow({ id: 's_late', name: 'Late', personaId: 'p', topic: 'brief', description: '  Small-hours ambient.  ' });
  const payload = showPayload(show);
  assert.equal(payload.description, 'Small-hours ambient.');
  assert.equal(payload.topic, 'brief');
});

test('a show from before the field hydrates with an empty description', () => {
  const show = hydrateShow({ id: 's_old', name: 'Old', personaId: 'p', topic: 'brief' });
  assert.equal(show.description, '');
  assert.equal(showPayload(show).description, '');
});
