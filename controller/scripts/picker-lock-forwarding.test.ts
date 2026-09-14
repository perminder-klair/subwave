// Pins the hand-off of strict show locks from pickViaAgent (broadcast/dj-agent.ts)
// to the agent's discovery tools (broadcast/dj-agent/agents.ts → buildPickerTools).
//
// THE DEFECT THIS GUARDS. A lock that pickViaAgent resolves and passes but that
// something downstream fails to carry is not a crash and produces no log line:
// it falls through to a `null` default and that whole dimension silently stops
// being enforced on the agent path, while the pool picker still honours it. The
// two pick paths then disagree about the same show, which is exactly what
// music/show-filter.ts exists to prevent. It happened for real on #1300 FR 13,
// where vocalLock was resolved, passed, and then dropped.
//
// The shape that allowed it is gone. Constraints now travel as ONE PickerScope
// object (llm/internal/tools/picker/scope.ts) that is never unpacked into
// per-field lists on the way to the tools, so there are no two lists left to
// disagree. These tests hold that property in place: they assert the scope
// reaches the tools whole and that every lock actually filters, rather than
// scraping source text for matching identifier names as the pre-scope version
// had to.
//
// Run: npm test -- picker-lock-forwarding

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pickerScope, type PickerScope } from '../src/llm/internal/tools/picker/scope.js';
import { buildPickerContext } from '../src/llm/internal/tools/picker/scope.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

// A candidate list spanning every dimension a lock can filter on.
const CANDIDATES = [
  { id: 'a', title: 'A', artist: 'X', year: 1975, genres: ['Punk Rock'], moods: ['night'], energy: 'high', vocalRanges: [[0, 1000]] },
  { id: 'b', title: 'B', artist: 'Y', year: 1995, genres: ['Jazz'], moods: ['calm'], energy: 'low', vocalRanges: [] },
  { id: 'c', title: 'C', artist: 'Z', year: 2015, genres: ['Jazz'], moods: ['night'], energy: 'low', vocalRanges: [[0, 500]] },
];

const idsFor = (partial: Partial<PickerScope>) => {
  const ctx = buildPickerContext(pickerScope(partial));
  return ctx.collect(CANDIDATES, 50).map((s: any) => s.id).sort();
};

console.log('PickerScope defaults:');

test('an empty scope constrains nothing', () => {
  assert.deepEqual(idsFor({}), ['a', 'b', 'c']);
});

test('every field has a no-constraint default, so a caller states only what it constrains', () => {
  const s = pickerScope();
  // The locks must default to null/empty rather than undefined: `undefined`
  // reads the same at a call site but means "field absent" to anything that
  // enumerates the scope, which is how a dropped lock hid before.
  for (const k of ['genreLock', 'eraLock', 'moodLock', 'energyLock', 'vocalLock', 'minTrackSec', 'playlistLock', 'playlistTracks', 'excludedIds', 'audioWaypoint'] as const) {
    assert.equal(s[k], null, `${k} must default to null`);
  }
  assert.equal(s.resolveReferences, false);
  for (const k of ['recentIds', 'recentKeys', 'hardRecentIds', 'hardRecentKeys'] as const) {
    assert.ok(s[k] instanceof Set && s[k].size === 0, `${k} must default to an empty Set`);
  }
});

console.log('\nevery lock in the scope actually filters:');

// Each case proves the dimension is enforced in CODE, not just described in the
// prompt. A lock that stopped being carried would return the unfiltered set here.
test('genreLock drops off-genre candidates (refine direction: "Punk" admits "Punk Rock")', () => {
  assert.deepEqual(idsFor({ genreLock: ['Punk'] }), ['a']);
  assert.deepEqual(idsFor({ genreLock: ['Jazz'] }), ['b', 'c']);
});

test('eraLock drops out-of-window candidates', () => {
  assert.deepEqual(idsFor({ eraLock: [{ fromYear: 1990, toYear: 1999 }] }), ['b']);
});

test('moodLock drops untagged-for-that-mood candidates', () => {
  assert.deepEqual(idsFor({ moodLock: ['night'] }), ['a', 'c']);
});

test('energyLock drops other bands', () => {
  assert.deepEqual(idsFor({ energyLock: ['low'] }), ['b', 'c']);
});

test('vocalLock drops the other side (instrumental = empty vocalRanges)', () => {
  assert.deepEqual(idsFor({ vocalLock: 'instrumental' as any }), ['b']);
});

test('minTrackSec drops short candidates, and is NOT gated on filtersStrict', () => {
  // The minimum-track-length floor (#1573) travels in the scope like the five
  // locks above, but unlike them it is the twin of the max-track-length cap and
  // applies whether or not the show opted into strict filters. HARD here
  // (starve:true), same as every other filter in collect(): the pool picker
  // never-starves on the same floor and is the dead-air scope behind this one.
  const LENGTHS = [
    { id: 'skit', title: 'Skit', artist: 'X', duration: 38 },
    { id: 'song', title: 'Song', artist: 'Y', durationSec: 300 },
    { id: 'unwalked', title: 'Unwalked', artist: 'Z' },
  ];
  const idsOf = (partial: Partial<PickerScope>) =>
    buildPickerContext(pickerScope(partial)).collect(LENGTHS, 50).map((s: any) => s.id).sort();
  assert.deepEqual(idsOf({}), ['skit', 'song', 'unwalked'], 'no floor = today');
  // An unmeasured track survives: dropping unknowns would make the floor mean
  // "only play what we happen to have walked".
  assert.deepEqual(idsOf({ minTrackSec: 60 }), ['song', 'unwalked']);
  // Both field names, since a Subsonic child and a library row spell it
  // differently and the tools see both.
  assert.deepEqual(idsOf({ minTrackSec: 400 }), ['unwalked']);
});

test('playlistLock hard-intersects — no never-starve to off-playlist', () => {
  assert.deepEqual(idsFor({ playlistLock: new Set(['c']) }), ['c']);
  // A lock matching nothing contributes nothing, rather than leaking the set.
  assert.deepEqual(idsFor({ playlistLock: new Set(['nope']) }), []);
});

test('excludedIds overrides the playlist anchor', () => {
  assert.deepEqual(idsFor({ playlistLock: new Set(['b', 'c']), excludedIds: new Set(['c']) }), ['b']);
});

test('recency drops by id AND by "title|artist" key', () => {
  assert.deepEqual(idsFor({ recentIds: new Set(['a']) }), ['b', 'c']);
  assert.deepEqual(idsFor({ recentKeys: new Set(['b|y']) }), ['a', 'c']);
});

test('locks compose — all of them apply together, none overrides another', () => {
  assert.deepEqual(idsFor({ genreLock: ['Jazz'], energyLock: ['low'], moodLock: ['night'] }), ['c']);
});

console.log('\nthe scope reaches the tools whole:');

test('pickViaAgent builds ONE scope and hands it over unpacked', () => {
  const src = read('../src/broadcast/dj-agent.ts');
  assert.match(src, /const scope = pickerScope\(\{/,
    'pickViaAgent should assemble a single pickerScope(...) value');
  assert.match(src, /pickerAgent\.run\(\{[^}]*\bscope,/s,
    'the picker run must receive the scope as one value');
});

test('buildTools passes the scope straight through — no per-field re-listing', () => {
  const src = read('../src/broadcast/dj-agent/agents.ts');
  assert.match(src, /buildTools:\s*\(\{\s*scope\s*\}\)\s*=>\s*\{\s*const \{ tools, seen \} = buildPickerTools\(scope\);/,
    'pickerAgent.buildTools must forward the scope object itself; re-listing its '
    + 'fields is the shape that let a lock go missing (see the header).');
});

test('no *Lock identifier is named between the call site and the tools', () => {
  // The guard on regression: if someone reintroduces a per-field hand-off, lock
  // names reappear in agents.ts and this fails. dj-agent.ts still names them
  // once — it is where they are resolved — but agents.ts must stay lock-blind.
  const agents = read('../src/broadcast/dj-agent/agents.ts');
  const code = agents.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const named = [...code.matchAll(/\b(\w+Lock)\b/g)].map(m => m[1]);
  assert.deepEqual([...new Set(named)], [],
    `agents.ts names ${[...new Set(named)].join(', ')} — locks must travel inside the scope, not as keys here`);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
