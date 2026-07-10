// Unit tests for analyzer handoff selection. Remote analyzers (for example,
// Odin) can fetch Navidrome stream URLs directly, so the controller must be
// able to skip shared-volume path prefetching and send {url} instead.

import assert from 'node:assert/strict';
import { normalizeAnalyzerHandoff, shouldPrefetchAnalyzerAudio } from '../src/music/analyzer-handoff.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

console.log('analyzer handoff:');

test('normalizes supported modes and falls back to auto', () => {
  assert.equal(normalizeAnalyzerHandoff('url'), 'url');
  assert.equal(normalizeAnalyzerHandoff('path'), 'path');
  assert.equal(normalizeAnalyzerHandoff('auto'), 'auto');
  assert.equal(normalizeAnalyzerHandoff(' URL '), 'url');
  assert.equal(normalizeAnalyzerHandoff(''), 'auto');
  assert.equal(normalizeAnalyzerHandoff('odin'), 'auto');
  assert.equal(normalizeAnalyzerHandoff(null), 'auto');
});

test('prefetch stays enabled for auto/path and is disabled for url', () => {
  assert.equal(shouldPrefetchAnalyzerAudio('auto'), true);
  assert.equal(shouldPrefetchAnalyzerAudio('path'), true);
  assert.equal(shouldPrefetchAnalyzerAudio('url'), false);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall analyzer-handoff tests passed');
