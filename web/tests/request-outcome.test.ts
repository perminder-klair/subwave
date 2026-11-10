import assert from 'node:assert/strict';
import test from 'node:test';
import { isRefusedOutcome, requestResultLabel } from '../lib/request-outcome';

test('refused requests are never labelled as newly queued', () => {
  const track = { title: 'Bohemian Rhapsody', artist: 'Queen' };
  assert.equal(requestResultLabel({ track, outcome: 'cooldown' }), 'Played recently');
  assert.equal(requestResultLabel({ track, outcome: 'already-queued' }), 'Already playing or queued');
  assert.equal(requestResultLabel({ track, outcome: 'substituted' }), 'Alternative queued');
  assert.equal(requestResultLabel({ track, outcome: 'matched' }), 'Queued');
});

test('chat, pending and legacy controller replies retain truthful labels', () => {
  assert.equal(requestResultLabel({ pending: true }), 'On the wire');
  assert.equal(requestResultLabel({ outcome: 'chat' }), 'Answered');
  assert.equal(requestResultLabel({ track: { title: 'Legacy track' } }), 'Queued');
});

test('only cooldown and already-queued are refusals', () => {
  assert.ok(isRefusedOutcome('cooldown'));
  assert.ok(isRefusedOutcome('already-queued'));
  for (const outcome of ['matched', 'substituted', 'chat', 'no-match', undefined, null]) assert.ok(!isRefusedOutcome(outcome));
});
