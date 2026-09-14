// Structural guard on the per-file picker tool registry
// (llm/internal/tools/picker/). Two failures are invisible at runtime: a
// module whose `name` disagrees with index.ts, and a duplicate name
// overwriting an earlier tool in the ToolSet.
//
// Also pins the availability gates: on a forced-tool provider the single
// discovery call spent on a guaranteed-empty tool corners the model.

import assert from 'node:assert/strict';
import { PICKER_TOOLS } from '../src/llm/internal/tools/picker/index.js';
import { buildPickerContext, pickerScope } from '../src/llm/internal/tools/picker/scope.js';
import type { PickerContext } from '../src/llm/internal/tools/picker/scope.js';

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

// A context with no library/index coverage — the shape a fresh install has.
const bareCtx = (over: Partial<PickerContext> = {}): PickerContext => ({
  ...buildPickerContext(pickerScope()),
  hasTextEmbeddings: false,
  hasAudioEmbeddings: false,
  hasEmbeddingProvider: false,
  ...over,
});

const namesOf = (ctx: PickerContext) =>
  PICKER_TOOLS.filter(m => !m.available || m.available(ctx)).map(m => m.name);

console.log('registry integrity:');

test('every module declares a name and a build', () => {
  for (const m of PICKER_TOOLS) {
    assert.ok(m.name && typeof m.name === 'string', 'a module has no name');
    assert.equal(typeof m.build, 'function', `${m.name} has no build()`);
  }
});

test('names are unique — a duplicate would silently overwrite in the ToolSet', () => {
  const names = PICKER_TOOLS.map(m => m.name);
  assert.deepEqual(
    names.filter((n, i) => names.indexOf(n) !== i), [],
    'duplicate tool name in PICKER_TOOLS',
  );
});

test('every tool carries a description the model can act on', () => {
  const ctx = bareCtx();
  for (const m of PICKER_TOOLS) {
    const built = m.build(ctx) as any;
    assert.ok(built.description && built.description.length > 40,
      `${m.name} has no usable description`);
    assert.ok(built.inputSchema, `${m.name} has no inputSchema`);
  }
});

console.log('\navailability gating:');

test('the always-on core is offered on a bare install', () => {
  // No embedding index, playlist anchor or journey needed, so a fresh station
  // still has a working picker.
  const offered = namesOf(bareCtx());
  for (const n of ['searchLibrary', 'similarSongs', 'topSongsByArtist', 'recentByArtist',
    'songsByGenre', 'tracksByMood', 'tracksByEnergy', 'recentlyAdded', 'starredSongs', 'randomSongs']) {
    assert.ok(offered.includes(n), `${n} must be offered on a bare install`);
  }
});

test('index-backed tools stay hidden until their index holds vectors', () => {
  const offered = namesOf(bareCtx());
  for (const n of ['tracksLikeThis', 'tracksThatSoundLikeThis', 'searchByLyrics', 'searchBySound']) {
    assert.ok(!offered.includes(n), `${n} must be gated off with an empty index`);
  }
});

test('a text index alone lights up tracksLikeThis but not searchByLyrics', () => {
  // searchByLyrics additionally needs a live embedding PROVIDER, because it
  // embeds the query at call time; tracksLikeThis reads a stored vector.
  const offered = namesOf(bareCtx({ hasTextEmbeddings: true }));
  assert.ok(offered.includes('tracksLikeThis'));
  assert.ok(!offered.includes('searchByLyrics'));
  assert.ok(namesOf(bareCtx({ hasTextEmbeddings: true, hasEmbeddingProvider: true }))
    .includes('searchByLyrics'));
});

test('path-scoped tools are off unless their scope field is set', () => {
  const bare = namesOf(bareCtx());
  for (const n of ['showPlaylistTracks', 'tracksTowardJourney', 'identifyRequestedTrack']) {
    assert.ok(!bare.includes(n), `${n} must be off without its scope field`);
  }
  const withPlaylist = buildPickerContext(pickerScope({ playlistTracks: [{ id: 'x' }] }));
  assert.ok(namesOf({ ...withPlaylist, hasTextEmbeddings: false, hasAudioEmbeddings: false, hasEmbeddingProvider: false })
    .includes('showPlaylistTracks'));
});

test('deepCuts needs the library mirror, not an embedding index', () => {
  // Airing memory reads plays joined against tracks, no vectors, so it lights
  // up as soon as the library is synced.
  assert.ok(!namesOf(bareCtx()).includes('deepCuts'),
    'deepCuts must be off with an empty library mirror');
  assert.ok(namesOf(bareCtx({ stats: { mirrorTotal: 100, total: 100 } })).includes('deepCuts'));
});

test('deepCuts reads the MIRROR size, not the tagged count', () => {
  // `stats.total` counts only TAGGED tracks, but db.deepCutTracks queries
  // `tracks` unconditionally, so gating on `total` leaves a synced-but-untagged
  // install dark.
  assert.ok(
    namesOf(bareCtx({ stats: { mirrorTotal: 50000, total: 0 } })).includes('deepCuts'),
    'deepCuts must light up on a synced library the tagger has not reached',
  );
  // And a genuinely empty mirror still keeps it off, whatever `total` claims.
  assert.ok(!namesOf(bareCtx({ stats: { mirrorTotal: 0, total: 0 } })).includes('deepCuts'));
});

test('the journey tool needs BOTH a waypoint and an audio index', () => {
  const waypointOnly = buildPickerContext(pickerScope({ audioWaypoint: [0.1, 0.2] }));
  assert.ok(!namesOf({ ...waypointOnly, hasAudioEmbeddings: false, hasTextEmbeddings: false, hasEmbeddingProvider: false })
    .includes('tracksTowardJourney'), 'a waypoint without audio vectors must not offer the tool');
  assert.ok(namesOf({ ...waypointOnly, hasAudioEmbeddings: true, hasTextEmbeddings: false, hasEmbeddingProvider: false })
    .includes('tracksTowardJourney'));
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
