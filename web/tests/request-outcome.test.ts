import assert from 'node:assert/strict';
import test from 'node:test';
import { requestResultLabel, requestPollPhase, REQUEST_POLL_DEADLINE_MS } from '../lib/request-outcome';

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

test('a slow model remains pending after a minute rather than looking completed', () => {
  const start = 1_000;
  assert.equal(requestPollPhase(start, start + 59_000), 'waiting');
  assert.equal(requestPollPhase(start, start + 61_000), 'delayed');
  assert.equal(requestPollPhase(start, start + REQUEST_POLL_DEADLINE_MS), 'delayed');
  assert.equal(requestPollPhase(start, start + REQUEST_POLL_DEADLINE_MS + 1), 'unconfirmed');
});
