import assert from 'node:assert/strict';
import test from 'node:test';
import {
  breakerFailure,
  breakerOpen,
  requestBreakerFailure,
  requestBreakerOpen,
} from '../src/broadcast/dj-agent/breaker.js';

const queue = { log: () => undefined };

test('picker and request failures use independent breakers', () => {
  assert.equal(requestBreakerOpen(), false);
  requestBreakerFailure(queue, { expected: true });
  requestBreakerFailure(queue, { expected: true });
  requestBreakerFailure(queue, { expected: true });
  assert.equal(requestBreakerOpen(), false);
  breakerFailure(queue);
  breakerFailure(queue);
  breakerFailure(queue);
  assert.equal(breakerOpen(), true);
  assert.equal(requestBreakerOpen(), false);
  requestBreakerFailure(queue);
  requestBreakerFailure(queue);
  requestBreakerFailure(queue);
  assert.equal(requestBreakerOpen(), true);
  assert.equal(breakerOpen(), true);
});
