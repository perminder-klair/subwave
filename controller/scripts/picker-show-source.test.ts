// Source-wiring invariants in the pool picker's candidate builder
// (music/picker.ts buildCandidates) and the coast's twin (scheduler.ts):
//
//   1. show-genre / show-playlist never-starve on recency; every other source
//      samples fresh-only, or a fully-aired cluster re-emits what just played.
//   2. The exploration slot is skipped for a strict-PLAYLIST show — a
//      library-wide random draw cannot be playlist-filtered.
//   3. The per-artist cap is lifted for a strict-PLAYLIST show in all three
//      pick paths, AFTER the playlist narrowing, and only there.
//
// Scraped from source because buildCandidates is unexported and needs a live
// Navidrome, and nothing observable distinguishes "the show source contributed
// zero" from "the show has no matching tracks".

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

const currentTrackInitializer = picker.match(/^\s*const currentTrack = (.*);$/m)?.[1];
assert.ok(currentTrackInitializer, 'no currentTrack initializer found in picker.ts');
const resolveCurrentTrack = new Function('queue', `return (${currentTrackInitializer});`) as
  (queue: Record<string, unknown>) => unknown;

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
  // The never-starve is scoped to the show sources on purpose.
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
  // The gate must sit above the fetch, not filter the result afterwards.
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
  // Order is load-bearing: uncapping above the `inPl` narrowing would uncap
  // the raw discovery pool.
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
  // The agent path is the DEFAULT picker; collect() applies playlistLock as a
  // hard intersection above this filter.
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

console.log('\npool selection anchors on the expected predecessor at selection time:');

const A = { id: 'a', title: 'On air', artist: 'Artist A' };
const B = { id: 'b', title: 'Queued one', artist: 'Artist B' };
const C = { id: 'c', title: 'Queued tail', artist: 'Artist C' };
const IDLESS = { title: 'Queued without id', artist: 'Artist D' };

for (const [name, queue, expected] of [
  ['one queued track beats the on-air track', { current: { track: A }, upcoming: [{ track: B }] }, B],
  ['the last of multiple queued tracks wins', { current: { track: A }, upcoming: [{ track: B }, { track: C }] }, C],
  ['the on-air track remains the fallback', { current: { track: A }, upcoming: [] }, A],
  ['a queued-only track is accepted', { current: null, upcoming: [{ track: B }] }, B],
  ['neither predecessor safely resolves to null', { current: null, upcoming: [] }, null],
  ['an empty lightweight queue safely resolves to null', {}, null],
  ['a lightweight queue without upcoming uses current', { current: { track: A } }, A],
  ['an id-less queue tail does not fall back to current', { current: { track: A }, upcoming: [{ track: IDLESS }] }, IDLESS],
] as const) {
  test(name, () => {
    assert.equal(resolveCurrentTrack(queue), expected);
  });
}

test('the captured predecessor fans out to candidates and the model payload', () => {
  assert.match(picker, /buildCandidates\([^;]*\bcurrentTrack\s*,\s*rankTarget\s*,\s*audioWaypoint/);
  assert.match(picker, /current:\s*currentTrack\s*\?/);
  for (const field of ['title', 'artist', 'paceMean']) {
    assert.match(picker, new RegExp(`\\bcurrentTrack\\.${field}\\b`));
  }
  assert.match(picker, /analysisFor\(currentTrack\)/);
  assert.match(picker, /library\.get\(currentTrack\.id\)/);
});

test('candidate discovery and default ranking consume the captured predecessor', () => {
  assert.match(picker, /getSimilarSongs\(currentTrack\.id/);
  assert.match(picker, /tracksLikeThis\(currentTrack\.id/);
  assert.match(picker, /getSonicSimilarTracks\(currentTrack\.id/);
  assert.match(picker, /tracksLikeThisAudio\(currentTrack\.id/);
  assert.match(picker, /searchArtists\(currentTrack\.artist/);
  assert.match(picker, /rankTarget\s*\|\|\s*\(currentTrack\?\.id\s*\?\s*analysisFor\(currentTrack\)/);
});

test('explicit audio and rank targets still override predecessor-derived defaults', () => {
  assert.match(picker, /if\s*\(audioWaypoint\s*&&\s*audioWaypoint\.length\)[\s\S]*?tracksByAudioVector\(audioWaypoint/);
  assert.match(picker, /}\s*else if\s*\(currentTrack\?\.id\)[\s\S]*?tracksLikeThisAudio\(currentTrack\.id/);
  assert.match(picker, /const curAnalysis = rankTarget\s*\|\|\s*\(currentTrack\?\.id/);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
