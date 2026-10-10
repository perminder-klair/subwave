// The intro budget's advisory PHRASE and its hard BACKSTOP size the same runway.
//
// enforceIntroBudget treats a measured first vocal (≥ the 2.5s floor) as THE
// runway; the phrase used to read the energy-heuristic intro instead, so a track
// whose singer enters at 4s was advertised as "vocals around 12s — room for a
// sentence or two", the model wrote to that, and the backstop then cut the link
// to ten words or dropped it. Both now resolve one runway, and the measured
// onset is composed by broadcast/vocal-runway.ts.
//
// Run: npm test -- intro-budget-runway

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-intro-budget-runway-'));
process.env.STATE_DIR = stateRoot;
const { introBudgetPhrase, enforceIntroBudget, firstVocalMsFor } = await import('../src/llm/internal/prompts/intro-budget.js');
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '.';

test('a measured vocal entry sizes the advice, not the heuristic intro', () => {
  const phrase = introBudgetPhrase(12_000, 4_000);
  assert.match(phrase, /around 4s/);
  assert.match(phrase, /single short phrase/, 'a 4s runway is a short-phrase budget');
  // The backstop agrees: 4s × 2.5 words/s.
  assert.equal(enforceIntroBudget(words(10), 12_000, 1, 4_000), words(10));
  assert.equal(enforceIntroBudget(words(25), 12_000, 1, 4_000), '', 'a 25-word line cannot land inside 4s');
});

test('a long heuristic intro no longer silences the advice when the vocal is measured early', () => {
  assert.match(introBudgetPhrase(20_000, 5_000), /around 5s/);
  assert.notEqual(enforceIntroBudget(words(30), 20_000, 1, 5_000), words(30), 'and the backstop binds there too');
});

test('a measured vocal past the ceiling constrains neither', () => {
  assert.equal(introBudgetPhrase(4_000, 20_000), '');
  assert.equal(enforceIntroBudget(words(40), 4_000, 1, 20_000), words(40));
});

test('un-measured tracks keep the heuristic intro on both sides', () => {
  assert.match(introBudgetPhrase(12_000, null), /around 12s/);
  assert.equal(introBudgetPhrase(1_000, null), '');
  assert.match(introBudgetPhrase(12_000, 1_000), /skip the spoken intro/);
});

test('firstVocalMsFor reads the onset through vocal-runway: fresh ranges, earliest start', () => {
  assert.equal(firstVocalMsFor({ vocalRanges: [{ startMs: 9_000 }, { startMs: 3_000 }] }), 3_000);
  assert.equal(firstVocalMsFor({ vocalRanges: [] }), null, 'an instrumental has no vocal to budget against');
  assert.equal(firstVocalMsFor({}), null, 'un-analysed');
  assert.equal(firstVocalMsFor(null), null);
});
