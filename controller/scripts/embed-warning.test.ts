// embedTexts degrades to null on failure and names the cause, but an analyzer
// outage fails every call of a tagger run: the warning is rate limited to one
// per EMBED_WARN_EVERY_MS, and the next one says how many it held back.

import assert from 'node:assert/strict';
import test from 'node:test';
import { EMBED_WARN_EVERY_MS, _resetEmbedWarningsForTests, warnEmbedFailure } from '../src/music/analyzer.js';

test('an outage logs one warning per window, then counts the ones it held back', (t) => {
  _resetEmbedWarningsForTests();
  const lines: string[] = [];
  t.mock.method(console, 'warn', (msg: string) => { lines.push(msg); });
  const t0 = 1_000_000;
  assert.equal(warnEmbedFailure('fetch failed (UND_ERR_SOCKET: other side closed)', t0), true);
  for (let i = 1; i <= 40; i++) assert.equal(warnEmbedFailure('fetch failed (ECONNREFUSED)', t0 + i * 1_000), false);
  assert.equal(lines.length, 1);
  assert.equal(warnEmbedFailure('fetch failed (ECONNREFUSED)', t0 + EMBED_WARN_EVERY_MS), true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /UND_ERR_SOCKET/);
  assert.match(lines[1], /ECONNREFUSED\) \(40 more since the last warning\)$/);
  _resetEmbedWarningsForTests();
});

test('a single failure after a quiet spell has no count', (t) => {
  _resetEmbedWarningsForTests();
  const lines: string[] = [];
  t.mock.method(console, 'warn', (msg: string) => { lines.push(msg); });
  warnEmbedFailure('fetch failed', 0);
  warnEmbedFailure('fetch failed', EMBED_WARN_EVERY_MS * 5);
  assert.deepEqual(lines, ['[analyzer] text embedding failed: fetch failed', '[analyzer] text embedding failed: fetch failed']);
  _resetEmbedWarningsForTests();
});
