// Pins the two SHOW-source invariants in the pool picker's candidate builder
// (music/picker.ts buildCandidates) and the coast's twin (broadcast/scheduler.ts).
//
// THE DEFECT THIS GUARDS. Both defects are silent one-line regressions in a
// function that can't be unit-tested directly — buildCandidates isn't exported
// and needs a live Navidrome — and both fail in the same direction: a STRICT
// show quietly airing off-target music, with the log line still reporting a
// healthy pool.
//
//   1. The dedicated show sources (show-genre, show-playlist) must never-starve
//      on recency. Every OTHER source samples fresh-only, and rightly so: a
//      fully-aired similarity cluster re-emitting exactly what just played is
//      how the anti-repeat guard became a source of repeats. But these two are
//      the pool's only in-filter contributors, and the strict end-filters
//      never-starve on an empty in-filter set — `if (inPl.length)` keeps the
//      FULL pool, applyStrictLocks(starve:false) skips a zero-match dimension.
//      So a show pinned to a 40-track playlist whose tracks are all inside the
//      (library-scaled, up to 36 h) window contributes nothing and is then
//      handed nothing BUT off-playlist discovery candidates.
//
//   2. The exploration slot must be skipped for a strict-PLAYLIST show. A
//      library-wide random draw can't be playlist-filtered, so every track it
//      contributes is either discarded by the end-filter — a wasted Navidrome
//      round trip on every pick — or, on the never-starve branch, becomes a live
//      off-playlist candidate. scheduler.ts has always gated its identical
//      source; picker.ts did not.
//
//   3. The per-artist cap must be LIFTED for a strict-PLAYLIST show, in all
//      THREE pick paths, and only there. A playlist is an exact operator-pinned
//      set, so a single-artist / single-album playlist is the point of pinning
//      it — capping it at 3 (picker) / AUTO_MAX_PER_ARTIST (coast) handed the
//      LLM three tracks and looped a two-track fallback. The lift must sit
//      AFTER the playlist narrowing (otherwise it uncaps a discovery pool) and
//      must not spill onto sources the strict end-filter is about to drop.
//
// Scraped from source because there is no runtime seam: nothing observable
// distinguishes "the show source contributed zero" from "the show has no
// matching tracks", which is the same reason picker-lock-forwarding.test.ts
// exists. Kept deliberately narrow — the anchors are the `add(...)`/`take(...)`
// call for each named source, not the surrounding logic.
//
// Run: npm test -- picker-show-source

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
const picker = readFileSync(resolve(here, '../src/music/picker.ts'), 'utf8');
const scheduler = readFileSync(resolve(here, '../src/broadcast/scheduler.ts'), 'utf8');
const scope = readFileSync(resolve(here, '../src/llm/internal/tools/picker/scope.ts'), 'utf8');

// The single line that adds a named source to the pool.
const addLine = (src: string, label: string): string => {
  const m = src.match(new RegExp(`^.*\\b(?:add|take)\\(\\s*'${label}'[\\s\\S]*?$`, 'm'));
  assert.ok(m, `no add/take call found for the "${label}" source`);
  return m![0];
};

console.log('dedicated show sources never-starve:');

for (const label of ['show-genre', 'show-playlist']) {
  test(`picker.ts: "${label}" samples via sampleShowSource, not sampleFresh`, () => {
    const line = addLine(picker, label);
    assert.ok(
      line.includes('sampleShowSource('),
      `"${label}" must use sampleShowSource — sampleFresh drops the never-starve and the strict end-filter then falls back to the FULL (off-target) pool:\n    ${line.trim()}`,
    );
  });

  test(`scheduler.ts: "${label}" is taken with neverStarve`, () => {
    const line = addLine(scheduler, label);
    assert.ok(
      line.includes('neverStarve: true'),
      `"${label}" must pass { neverStarve: true } — take() otherwise hard-drops recents and the coast plays off-target:\n    ${line.trim()}`,
    );
  });
}

test('the DISCOVERY sources keep fresh-only sampling', () => {
  // The never-starve is scoped to the show sources on purpose. If a similarity
  // or crate source ever picks it up, a fully-aired cluster re-emits what just
  // played — the original repeated-songs defect.
  for (const label of ['similar', 'embedding-similar', 'explore', 'recent', 'frequent']) {
    const line = addLine(picker, label);
    assert.ok(
      !line.includes('sampleShowSource('),
      `discovery source "${label}" must sample fresh-only:\n    ${line.trim()}`,
    );
  }
});

console.log('\nexploration slot is skipped for a strict-playlist show:');

test('picker.ts gates the explore slot on !strictPlaylist', () => {
  const at = picker.indexOf(`add('explore'`);
  assert.ok(at > 0, 'no explore source found in picker.ts');
  // Walk back to the nearest enclosing guard — the gate must sit above the
  // fetch, not merely filter the result afterwards (the round trip is half the
  // cost, and the never-starve branch is the other half).
  const before = picker.slice(Math.max(0, at - 800), at);
  assert.ok(
    /if\s*\(!strictPlaylist\)/.test(before),
    'the explore slot must be wrapped in `if (!strictPlaylist)`, mirroring scheduler.ts §2b',
  );
  assert.ok(
    before.lastIndexOf('if (!strictPlaylist)') < before.lastIndexOf('getRandomSongs'),
    'the guard must OPEN above the getRandomSongs fetch — gating only the add() still pays the round trip on every pick',
  );
});

test('scheduler.ts still gates its twin the same way', () => {
  const at = scheduler.indexOf(`take('explore'`);
  assert.ok(at > 0, 'no explore source found in scheduler.ts');
  const before = scheduler.slice(Math.max(0, at - 800), at);
  assert.ok(
    /if\s*\(!strictPlaylist\)/.test(before),
    'scheduler.ts §2b must keep its !strictPlaylist gate — picker.ts mirrors it',
  );
});

console.log('\nthe artist cap is lifted for a strict-playlist show, in every pick path:');

test('picker.ts uncaps MAX_PER_ARTIST for a strict playlist, after the inPl narrowing', () => {
  const m = picker.match(/^\s*const MAX_PER_ARTIST = .*$/m);
  assert.ok(m, 'no MAX_PER_ARTIST declaration found in picker.ts');
  assert.ok(
    /strictPlaylist\s*\?\s*Infinity/.test(m![0]),
    `a strict playlist is an exact pinned set — capping it shrinks a single-artist show to 3 candidates:\n    ${m![0].trim()}`,
  );
  // Order is load-bearing: the cap is applied to selectionPool, which is only
  // the playlist set once `inPl` has narrowed it. Uncapping ABOVE that line
  // would uncap the raw discovery pool instead.
  const narrowAt = picker.indexOf('const inPl = pool.filter(');
  assert.ok(narrowAt > 0, 'no strict-playlist narrowing found in picker.ts');
  assert.ok(
    narrowAt < picker.indexOf(m![0]),
    'MAX_PER_ARTIST must be declared AFTER selectionPool is narrowed to the playlist set',
  );
});

test('scheduler.ts lifts the cap on the show-playlist TAKE, not on the builder', () => {
  const builder = scheduler.match(/createPoolBuilder\(\{[\s\S]*?\}\)/);
  assert.ok(builder, 'no createPoolBuilder call found in scheduler.ts');
  assert.ok(
    !/strictPlaylist/.test(builder![0]),
    'the BUILDER cap must stay unconditional — lifting it there uncaps show-genre/mood/recent too, and those tracks fill TARGET_POOL only to be dropped by the strict end-filter, starving the in-playlist share:\n    ' + builder![0],
  );
  const line = addLine(scheduler, 'show-playlist');
  assert.ok(
    /maxPerArtist:[^,}]*Infinity/.test(line),
    `the show-playlist source must opt out per-take on a strict playlist:\n    ${line.trim()}`,
  );
  assert.ok(
    /strictPlaylist/.test(line),
    `the opt-out must be conditional on strictPlaylist — a SOFT playlist anchor still shares the pool with discovery:\n    ${line.trim()}`,
  );
});

test('scheduler.ts keeps the cap on every discovery source', () => {
  for (const label of ['mood', 'recent', 'frequent', 'starred', 'explore']) {
    const line = addLine(scheduler, label);
    assert.ok(
      !/maxPerArtist/.test(line),
      `discovery source "${label}" must keep the builder's artist cap:\n    ${line.trim()}`,
    );
  }
});

test('scope.ts uncaps the agent tools under a playlistLock', () => {
  // The agent path (dj-agent.pickViaAgent) is the DEFAULT picker; music/picker.ts
  // is its fallback. collect() applies playlistLock as a hard intersection just
  // above this filter, so what reaches it is already the pinned set.
  const m = scope.match(/^\s*maxPerArtist: opts\.maxPerArtist.*$/m);
  assert.ok(m, 'no maxPerArtist default found in scope.ts collect()');
  assert.ok(
    /playlistLock\s*\?\s*Infinity/.test(m![0]),
    `without this, showPlaylistTracks returns 3 of its cap of 12 on a single-artist show — the pool picker's bug on the default path:\n    ${m![0].trim()}`,
  );
  const lockAt = scope.indexOf('if (playlistLock) pool = pool.filter(');
  assert.ok(lockAt > 0, 'no playlistLock intersection found in scope.ts');
  assert.ok(
    lockAt < scope.indexOf(m![0]),
    'the playlistLock intersection must run BEFORE the cap is lifted, or the lift uncaps an unfiltered discovery pool',
  );
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
