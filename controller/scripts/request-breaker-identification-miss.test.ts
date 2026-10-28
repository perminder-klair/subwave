import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestIdentificationMiss,
  requestBreakerFailure,
  requestBreakerOpen,
} from '../src/broadcast/dj-agent/breaker.js';

test('expected request identification misses do not trip the request breaker', () => {
  const queue = { log: () => undefined };

  assert.equal(requestBreakerOpen(), false);
  const miss = new RequestIdentificationMiss('no verified library candidate');
  requestBreakerFailure(queue, miss);
  requestBreakerFailure(queue, miss);
  requestBreakerFailure(queue, miss);
  requestBreakerFailure(queue, miss);

  assert.equal(requestBreakerOpen(), false);
});
