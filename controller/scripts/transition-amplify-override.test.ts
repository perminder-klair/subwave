// Every amplify inside the transition passes override=null.
//
// amplify's default override reads the liq_amplify metadata field, and every
// analysed track carries one (its loudness gain, applied before the cross). The
// incoming source carries it from its first sample, so an amplify inside
// dj_transition without override=null has its factor REPLACED by the track's
// gain: a curve becomes a constant and the gain lands twice. That is how the
// sweep's bass swap ended up adding the incoming's low band instead of holding
// it back, and how the equal-power fade-in became a flat level and a step. The
// failure is silent (both scripts still parse and render), so this is a source
// pin over both copies: scripts/fx-render-test.sh mirrors the transition so
// gestures can be rendered offline, and a harness that drifts from the mixer
// proves nothing about it.
//
// Run: `npm test -- transition-amplify-override`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// The transition body: from its `def` line (the first one after `after`, when
// given) to the first column-0 `end`.
function block(path: string, startLine: RegExp, after?: RegExp): string {
  const lines = readFileSync(path, 'utf8').split('\n');
  const anchor = after ? lines.findIndex((l) => after.test(l)) : 0;
  assert.ok(anchor >= 0, `${path}: no line matches ${after}`);
  const from = lines.findIndex((l, i) => i >= anchor && startLine.test(l));
  assert.ok(from >= 0, `${path}: no line matches ${startLine}`);
  const to = lines.findIndex((l, i) => i > from && l === 'end');
  assert.ok(to > from, `${path}: the block opened at line ${from + 1} never ends`);
  // Comments may quote the old call shape; only code counts.
  return lines.slice(from, to + 1).filter((l) => !l.trimStart().startsWith('#')).join('\n');
}

// Each `amplify(` call, with the text that follows its paren.
function amplifyCalls(code: string): string[] {
  return [...code.matchAll(/\bamplify\(([^\n]*)/g)].map((m) => m[1]);
}

const SOURCES = [
  { name: 'liquidsoap/radio.liq dj_transition', path: join(repo, 'liquidsoap', 'radio.liq'), start: /^def dj_transition\(a, b\) =$/ },
  // The harness holds several small transitions; `render()`'s is the mirror.
  { name: 'scripts/fx-render-test.sh render transition', path: join(repo, 'scripts', 'fx-render-test.sh'), start: /^def t\(a, b\) =$/, after: /^render\(\) \{$/ },
];

for (const { name, path, start, after } of SOURCES) {
  test(`${name}: every amplify passes override=null`, () => {
    const calls = amplifyCalls(block(path, start, after));
    assert.ok(calls.length >= 10, `${name}: expected the gestures' gains, found ${calls.length} amplify calls`);
    const bare = calls.filter((args) => !args.trimStart().startsWith('override=null'));
    assert.deepEqual(bare, [], `${name}: amplify without override=null takes the track's liq_amplify instead of its own factor`);
  });
}

test('the check sees a bare amplify', () => {
  const code = 'def t(a, b) =\n  x = amplify(0.5, a.source)\n  amplify(override=null, 1., x)\nend';
  const bare = amplifyCalls(code).filter((args) => !args.trimStart().startsWith('override=null'));
  assert.deepEqual(bare, ['0.5, a.source)']);
});
