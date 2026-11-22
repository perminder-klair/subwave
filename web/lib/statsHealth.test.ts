// Unit tests for the Stats page's traffic lights.
// Same lightweight harness as audienceStats.test.ts. Run from web/:
// `npm test -- statsHealth`.

import assert from 'node:assert/strict';
import {
  llmHealth,
  loadHealth,
  memoryHealth,
  requestsHealth,
  voiceFailureHealth,
  voiceFallbackHealth,
} from './statsHealth';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

console.log('health signals:');

test('LLM: idle with no calls, bad under 90% success, warn under 95%', () => {
  assert.equal(llmHealth({ count: 0, failed: 0 }).health, 'idle');
  assert.equal(llmHealth({ count: 100, failed: 11, successRate: 0.89 }).health, 'bad');
  assert.equal(llmHealth({ count: 100, failed: 6, successRate: 0.94 }).health, 'warn');
  assert.equal(llmHealth({ count: 100, failed: 1, successRate: 0.99 }).health, 'ok');
  // successRate absent: derived from the counts.
  assert.equal(llmHealth({ count: 10, failed: 2 }).health, 'bad');
  assert.equal(llmHealth({ count: 10, failed: 2 }).note, '2 of 10 model calls failed');
});

test('voice: a fallback is a warning, a 10% failure share is bad', () => {
  assert.equal(voiceFailureHealth({ count: 0, failed: 0 }).health, 'idle');
  assert.equal(voiceFailureHealth({ count: 50, failed: 0 }).health, 'ok');
  assert.equal(voiceFailureHealth({ count: 50, failed: 1 }).health, 'warn');
  assert.equal(voiceFailureHealth({ count: 50, failed: 5 }).health, 'bad');
  assert.equal(voiceFallbackHealth({ count: 50, fellBack: 0 }).health, 'ok');
  assert.equal(voiceFallbackHealth({ count: 50, fellBack: 20 }).health, 'warn');
  assert.equal(voiceFallbackHealth({ count: 50, fellBack: 3 }).note, '3 lines used the backup voice');
});

test('requests: bad under 80% found, warn under 90%', () => {
  assert.equal(requestsHealth({ count: 0, failed: 0 }).health, 'idle');
  assert.equal(requestsHealth({ count: 10, failed: 3, successRate: 0.7 }).health, 'bad');
  assert.equal(requestsHealth({ count: 10, failed: 2, successRate: 0.8 }).health, 'warn');
  assert.equal(requestsHealth({ count: 10, failed: 1, successRate: 0.9 }).health, 'ok');
  // A null successRate (no resolved/failed split yet) falls back to the counts.
  assert.equal(requestsHealth({ count: 10, failed: 0, successRate: null }).health, 'ok');
});

test('a failure in a small sample is worth a look, never needs attention', () => {
  assert.equal(llmHealth({ count: 1, failed: 1, successRate: 0 }).health, 'warn');
  assert.equal(llmHealth({ count: 9, failed: 5 }).health, 'warn');
  assert.equal(voiceFailureHealth({ count: 3, failed: 2 }).health, 'warn');
  assert.equal(requestsHealth({ count: 4, failed: 4, successRate: 0 }).health, 'warn');
});

test('host load: bad past one per core, warn past 70%', () => {
  assert.equal(loadHealth(null).health, 'idle');
  assert.equal(loadHealth({ cpus: 4, loadavg: [4.5, 1, 1] }).health, 'bad');
  assert.equal(loadHealth({ cpus: 4, loadavg: [3, 1, 1] }).health, 'warn');
  assert.equal(loadHealth({ cpus: 4, loadavg: [1, 1, 1] }).health, 'ok');
});

test('host memory: warn from the 80% red zone, bad at 95%', () => {
  assert.equal(memoryHealth({ memUsed: 0, memTotal: 0 }).health, 'idle');
  assert.equal(memoryHealth({ memUsed: 96, memTotal: 100 }).health, 'bad');
  assert.equal(memoryHealth({ memUsed: 80, memTotal: 100 }).health, 'warn');
  assert.equal(memoryHealth({ memUsed: 79, memTotal: 100 }).health, 'ok');
  assert.equal(memoryHealth({ memUsed: 50, memTotal: 100 }).note, '50% in use');
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll statsHealth tests passed.');
