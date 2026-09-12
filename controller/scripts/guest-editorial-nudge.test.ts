import assert from 'node:assert/strict';
import test from 'node:test';
import { guestEditorialNudgeFromGuests } from '../src/settings/persona.js';

test('a guest nudge is occasional and only comes from configured Musical Leanings', () => {
  const guests = [
    { id: 'p_terry', name: 'Terry', musicLean: ' favour trip-hop classics ' },
    { id: 'p_blank', name: 'Blank', musicLean: '' },
  ];

  assert.equal(guestEditorialNudgeFromGuests(guests, () => 0.25), null);
  assert.deepEqual(guestEditorialNudgeFromGuests(guests, () => 0), {
    guest: { id: 'p_terry', name: 'Terry' },
    musicalLeanings: 'favour trip-hop classics',
  });
});

test('a guest nudge never falls back to a guest Soul', () => {
  assert.equal(guestEditorialNudgeFromGuests([
    { id: 'p_terry', name: 'Terry', musicLean: '', soul: 'loves trip-hop' },
  ], () => 0), null);
});
