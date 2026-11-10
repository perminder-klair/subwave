import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isRefusedOutcome, requestResultLabel } from '../src/lib/request-outcome';

test('native request labels distinguish refused, substituted and queued tracks', () => {
  const track = { title: 'Bohemian Rhapsody' };
  assert.equal(requestResultLabel({ track, outcome: 'cooldown' }), 'Played recently');
  assert.equal(requestResultLabel({ track, outcome: 'already-queued' }), 'Already playing or queued');
  assert.equal(requestResultLabel({ track, outcome: 'substituted' }), 'Alternative queued');
  assert.equal(requestResultLabel({ track }), 'Queued');
  assert.equal(requestResultLabel({ outcome: 'chat' }), 'Answered');
});


test('native and web players share identical outcome labels', () => {
  assert.equal(readFileSync(new URL('../src/lib/request-outcome.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../../web/lib/request-outcome.ts', import.meta.url), 'utf8'));
});

test('only cooldown and already-queued are refusals', () => {
  assert.ok(isRefusedOutcome('cooldown'));
  assert.ok(isRefusedOutcome('already-queued'));
  for (const outcome of ['matched', 'substituted', 'chat', 'no-match', undefined, null]) assert.ok(!isRefusedOutcome(outcome));
});
