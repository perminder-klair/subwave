// Per-show full rotation (#1612) — "play every track in the anchor playlist
// once before repeating".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { showNoRepeatGuard } from '../src/music/show-recency.js';
import { exhaustiveNoRepeatWindow } from '../src/music/recency.js';

type Track = {
  id: string;
  title: string;
  artist: string;
  genres: string[];
  durationSec?: number;
};

const makeTracks = (n: number, opts: { genre?: (i: number) => string; durationSec?: (i: number) => number } = {}): Track[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    genres: [opts.genre ? opts.genre(i) : 'Jazz'],
    ...(opts.durationSec ? { durationSec: opts.durationSec(i) } : {}),
  }));

const LIBRARY = 27_986;
const CONFIGURED = 100;

const guard = (show: Record<string, unknown>, playlistTracks: Track[] | null, extra: Record<string, unknown> = {}) =>
  showNoRepeatGuard(CONFIGURED, LIBRARY, {
    show: show as never,
    playlistTracks,
    excludedIds: null,
    ...extra,
  });


test('absent and false are the shipped behaviour, unchanged', () => {
  const tracks = makeTracks(400);
  const strictOnly = { playlistStrict: true, filtersStrict: false };

  assert.deepEqual(
    guard(strictOnly, tracks),
    { window: CONFIGURED, exhaustive: false },
    'a strict playlist with the field ABSENT keeps the configured window',
  );
  assert.deepEqual(
    guard({ ...strictOnly, playlistExhaust: false }, tracks),
    { window: CONFIGURED, exhaustive: false },
    'an explicit false is the same as absent',
  );
  // showBool() reads anything but `true` as off, and the guard must agree —
  // a hand-edited settings.json carrying "yes" is not an opt-in.
  assert.deepEqual(
    guard({ ...strictOnly, playlistExhaust: 'yes' }, tracks),
    { window: CONFIGURED, exhaustive: false },
    'a truthy non-boolean is off, matching the schema',
  );
});

test('the switch is inert without a resolved strict anchor', () => {
  const tracks = makeTracks(400);
  // A SOFT anchor can leave the playlist, so the universe is the library again
  // and there is no set for "every track once" to be true of. Documented as a
  assert.deepEqual(
    guard({ playlistStrict: false, playlistExhaust: true }, tracks),
    { window: CONFIGURED, exhaustive: false },
    'exhaust without playlistStrict is a no-op, not a narrower window',
  );
  // A strict anchor whose playlists resolved to nothing (stale Navidrome id)
  // has no playlist lock at runtime either.
  assert.deepEqual(
    guard({ playlistStrict: true, playlistExhaust: true }, null),
    { window: CONFIGURED, exhaustive: false },
    'an unresolved anchor stays library-scoped',
  );
});


test('the window is the rotation size less two, and both slots are load-bearing', () => {
  // queue.recentlyPlayedByCount(n) blocks the ON-AIR track on top of the n
  // ended plays it counts, so a window of n withholds n+1 identities; one more
  // has to survive or the pool is empty. Hence S-2 for a rotation of S.
  assert.equal(exhaustiveNoRepeatWindow(40), 38);
  assert.equal(exhaustiveNoRepeatWindow(3), 1);
  // Too small to leave the headroom → 0, i.e. the guard switches off.
  assert.equal(exhaustiveNoRepeatWindow(2), 0);
  assert.equal(exhaustiveNoRepeatWindow(1), 0);
  assert.equal(exhaustiveNoRepeatWindow(0), 0);
  assert.equal(exhaustiveNoRepeatWindow(null), 0);
});

test('a 40-track anchor takes a 38-track window, ignoring the configured N', () => {
  assert.deepEqual(
    guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(40)),
    { window: 38, exhaustive: true },
    'the rotation sizes its own window',
  );
});

test('the library-fraction ceiling and the minimum-effective floor do not apply', () => {
  // Both exist to tame a number the operator TYPED against a catalogue it was
  // never measured on. Clamping a window derived from its own universe to
  // 37.5% of that same universe would just refuse the feature.
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(40)).window, 38);
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(20)).window, 18);
  // And a playlist far wider than the configured window is not capped at it:
  // the operator asked for the whole playlist, not the first 100 of it.
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(500)).window, 498);
});

test('a playlist growing mid-show widens the rotation on the next pick', () => {
  // Nothing is cached: the window is recomputed per pick off the resolved
  // pool, which is what makes "it silently stops being right the moment the
  const show = { playlistStrict: true, playlistExhaust: true };
  assert.equal(guard(show, makeTracks(40)).window, 38);
  assert.equal(guard(show, makeTracks(41)).window, 39, 'one track added in Navidrome, one wider window');
});


test('strict music filters narrow the rotation before it is counted', () => {
  // 40 tracks, 25 of them Jazz. A strict Jazz show rotates 25, not 40 — sizing
  // the window against the raw playlist would withhold tracks the show was
  const tracks = makeTracks(40, { genre: (i) => (i < 25 ? 'Jazz' : 'Rock') });
  assert.deepEqual(
    guard({ playlistStrict: true, playlistExhaust: true, filtersStrict: true, genres: ['Jazz'] }, tracks),
    { window: 23, exhaustive: true },
    '25 in-filter tracks → a 23-track window',
  );
  // The genre lock is the RESOLVED one, exactly as the pick paths resolve it.
  assert.equal(
    guard(
      { playlistStrict: true, playlistExhaust: true, filtersStrict: true, genres: ['Pop Punk'] },
      makeTracks(40, { genre: (i) => (i < 25 ? 'Pop' : 'Rock') }),
      { resolvedGenres: ['Pop'] },
    ).window,
    23,
    'capacity uses the same resolved alias as candidate filtering',
  );
});

test('excluded playlists and duplicate rips narrow it too', () => {
  const tracks = makeTracks(40);
  assert.equal(
    guard({ playlistStrict: true, playlistExhaust: true }, tracks, {
      excludedIds: new Set(tracks.slice(30).map((t) => t.id)),
    }).window,
    28,
    '10 excluded → a 30-track rotation → a 28-track window',
  );
  // Two ids, one audible song: it consumes ONE slot in the real rotation, so
  // counting the rows would size the window against a rotation that does not
  const rips = tracks.slice(0, 20).flatMap((t) => [t, { ...t, id: `${t.id}-alt` }]);
  assert.equal(
    guard({ playlistStrict: true, playlistExhaust: true }, rips).window,
    18,
    '40 rows, 20 identities → an 18-track window',
  );
});

test('the minimum-track-length floor is subtracted from the rotation', () => {
  // #1573's floor is HARD in the agent's discovery tools, so a playlist's
  // 40-second interludes are not part of the rotation. Counting them would
  // size the window against 40 while only 34 tracks can ever air — which,
  const tracks = makeTracks(40, { durationSec: (i) => (i < 6 ? 35 : 240) });
  assert.equal(
    guard({ playlistStrict: true, playlistExhaust: true }, tracks, { minTrackSec: 60 }).window,
    32,
    '34 tracks clear a 60s floor → a 32-track window',
  );
  // No floor configured (the default) changes nothing.
  assert.equal(
    guard({ playlistStrict: true, playlistExhaust: true }, tracks, { minTrackSec: 0 }).window,
    38,
  );
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, tracks).window, 38);
});


test('a playlist too small to rotate switches the guard off rather than risking a gap', () => {
  for (const size of [0, 1, 2]) {
    assert.deepEqual(
      guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(size)),
      { window: 0, exhaustive: false },
      `a ${size}-track anchor must leave the hard guard off`,
    );
  }
  // And it must not silently fall back to the CONFIGURED window either: 100
  // was measured against the library, not against two tracks, and applying it
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(2)).window, 0);
});

test('a filter that empties the playlist leaves the relaxable cascade in charge', () => {
  // A strict show whose genre matches nothing in its own anchor. applyStrictLocks
  // never-starves per dimension, so this reaches the count as the whole
  const tracks = makeTracks(40, { durationSec: () => 30 });
  assert.deepEqual(
    guard({ playlistStrict: true, playlistExhaust: true }, tracks, { minTrackSec: 600 }),
    { window: 0, exhaustive: false },
    'nothing can air → no hard window at all',
  );
});


// A faithful stand-in for queue.recentlyPlayedByCount(n): the last n DISTINCT
// ended plays, plus the track currently on air — which is not in the sidecar,
// because a play is appended when it ENDS. That "plus one" is one of the two
function blockedSet(endedNewestFirst: string[], onAir: string | null, n: number): Set<string> {
  const blocked = new Set<string>();
  if (onAir) blocked.add(onAir);
  if (!Number.isFinite(n) || n <= 0) return blocked;
  let distinct = 0;
  const seen = new Set<string>();
  for (const id of endedNewestFirst) {
    if (distinct >= n) break;
    if (seen.has(id)) continue;
    seen.add(id);
    distinct++;
    blocked.add(id);
  }
  return blocked;
}

test('a 40-track anchor plays 40 distinct tracks before any repeat', () => {
  const tracks = makeTracks(40);
  const show = { playlistStrict: true, playlistExhaust: true };
  const ended: string[] = [];
  let onAir: string | null = null;
  const aired: string[] = [];

  // 41 picks: the 41st is where a repeat becomes legal, and must be the track
  // that has waited longest rather than an arbitrary one.
  for (let pick = 0; pick < 41; pick++) {
    const { window } = guard(show, tracks);
    const blocked = blockedSet(ended, onAir, window);
    const eligible = tracks.filter((t) => !blocked.has(t.id));
    assert.ok(eligible.length > 0, `pick ${pick + 1}: the rotation must never leave an empty pool`);
    // The oldest eligible track — the pool's freshness ordering picks this one
    const chosen = eligible[0];
    if (onAir) ended.unshift(onAir);
    onAir = chosen.id;
    aired.push(chosen.id);
  }

  assert.equal(new Set(aired.slice(0, 40)).size, 40, 'the first 40 airings are 40 distinct tracks');
  assert.equal(aired[40], aired[0], 'the 41st airing is the track that has waited longest');
});

test('the same show with the switch off repeats inside those 40', () => {
  // The counterfactual: without the switch a 40-track anchor clamps to
  // floor(40 * 0.375) = 15, so track 16 is free to come round again. This is
  const tracks = makeTracks(40);
  const show = { playlistStrict: true };
  const ended: string[] = [];
  let onAir: string | null = null;
  const aired: string[] = [];

  for (let pick = 0; pick < 40; pick++) {
    const { window } = guard(show, tracks);
    const blocked = blockedSet(ended, onAir, window);
    const eligible = tracks.filter((t) => !blocked.has(t.id));
    const chosen = eligible[0];
    if (onAir) ended.unshift(onAir);
    onAir = chosen.id;
    aired.push(chosen.id);
  }
  assert.ok(new Set(aired).size < 40, 'the station-wide window lets a track repeat inside the playlist');
});

// ---------------------------------------------------------------------------
// Wiring. The policy only reaches the air if both paths ask it, and the pool

test('both pick paths resolve the floor before they size the window', () => {
  // The floor thins the rotation the window is counted against, so a call site
  // that passed the guard a pre-floor pool would size it too wide.
  for (const file of ['../src/music/picker.ts', '../src/broadcast/dj-agent.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const guardAt = source.indexOf('showNoRepeatGuard(');
    const floorAt = source.indexOf('effectiveMinTrackSec(');
    assert.ok(guardAt > 0, `${file} must go through the shared show policy`);
    assert.ok(floorAt > 0 && floorAt < guardAt,
      `${file} must resolve effectiveMinTrackSec before sizing the no-repeat window`);
    assert.match(source, /minTrackSec,?\s*\n?\s*\}/,
      `${file} must hand the floor to the guard`);
  }
});

test('the pool picker prunes hard-blocked tracks before capping its playlist source', () => {
  // CAP_SHOW_PLAYLIST_STRICT is 24. Under an exhaustive window all but one of
  // a 40-track anchor is hard-blocked, so an un-pruned random sample of 24
  // misses the only eligible track ~40% of the time and the strict show falls
  const source = readFileSync(new URL('../src/music/picker.ts', import.meta.url), 'utf8');
  assert.match(source, /function sampleShowSource\([\s\S]{0,400}hardRecent/,
    'sampleShowSource must be able to prune the hard-recent set');
  assert.match(source, /add\('show-playlist',[\s\S]{0,300}exhaustiveRotation \? \{ ids: hardRecentIds, keys: hardRecentKeys \} : null/,
    'the show-playlist source must pass the hard sets only under an exhaustive window');
});

test('the resolved show shape carries the switch to the pick paths', () => {
  // resolveShowShape is an explicit allowlist and is what every pick path
  // actually reads. A field missing there is a switch that saves, renders and
  const source = readFileSync(new URL('../src/settings/persona.ts', import.meta.url), 'utf8');
  assert.match(source, /playlistExhaust: show\.playlistExhaust === true/,
    'resolveShowShape must carry playlistExhaust');
});

test('the schema states which way the playlistStrict dependency was decided', () => {
  // The issue asked for the choice to be recorded where the shape is defined,
  // because a hand-edited settings.json reaches the schema without ever seeing
  const source = readFileSync(new URL('../src/schemas/show.ts', import.meta.url), 'utf8');
  assert.match(source, /playlistExhaust: showBool\(\)/,
    'playlistExhaust must be a show boolean beside playlistStrict');
  assert.match(source, /NO-OP without `playlistStrict`/,
    'the schema must say how the playlistStrict dependency was decided');
});
