import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { requestResultLabel, requestPollPhase, REQUEST_POLL_DEADLINE_MS } from '../src/lib/request-outcome';

test('native request labels distinguish refused, substituted and queued tracks', () => {
  const track = { title: 'Bohemian Rhapsody' };
  assert.equal(requestResultLabel({ track, outcome: 'cooldown' }), 'Played recently');
  assert.equal(requestResultLabel({ track, outcome: 'already-queued' }), 'Already playing or queued');
  assert.equal(requestResultLabel({ track, outcome: 'substituted' }), 'Alternative queued');
  assert.equal(requestResultLabel({ track }), 'Queued');
  assert.equal(requestResultLabel({ outcome: 'chat' }), 'Answered');
});

test('native slow requests remain pending and eventually report uncertainty', () => {
  assert.equal(requestPollPhase(0, 59_000), 'waiting');
  assert.equal(requestPollPhase(0, 61_000), 'delayed');
  assert.equal(requestPollPhase(0, REQUEST_POLL_DEADLINE_MS + 1), 'unconfirmed');
});

test('native and web players share identical outcome and timeout policy', () => {
  assert.equal(readFileSync(new URL('../src/lib/request-outcome.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../../web/lib/request-outcome.ts', import.meta.url), 'utf8'));
});
