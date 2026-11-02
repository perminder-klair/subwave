// Per-show full rotation (#1612) — "play every track in the anchor playlist
// once before repeating".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardRecentFor, rotationHardSet, showNoRepeatGuard, type AirTimeOf } from '../src/music/show-recency.js';
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
  assert.equal(exhaustiveNoRepeatWindow(3), 1);
  // Too small to leave the headroom → 0, i.e. the guard switches off.
  assert.equal(exhaustiveNoRepeatWindow(2), 0);
  assert.equal(exhaustiveNoRepeatWindow(1), 0);
  assert.equal(exhaustiveNoRepeatWindow(0), 0);
  assert.equal(exhaustiveNoRepeatWindow(null), 0);
});

test('a 40-track anchor takes a 38-track window, ignoring the configured N', () => {
  const tracks = makeTracks(40);
  const { window, exhaustive, rotation } = guard({ playlistStrict: true, playlistExhaust: true }, tracks);
  assert.equal(window, 38, 'the rotation sizes its own window');
  assert.equal(exhaustive, true);
  // The window is measured over this set's own airings (#1919), so the guard
  // hands the set over with it.
  assert.deepEqual(rotation?.map((t) => t.id), tracks.map((t) => t.id), 'the airable rotation rides with the window');
});

test('the library-fraction ceiling and the minimum-effective floor do not apply', () => {
  // Both exist to tame a number the operator TYPED against a catalogue it was
  // never measured on. Clamping a window derived from its own universe to
  // 37.5% of that same universe would just refuse the feature.
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(20)).window, 18);
  // And a playlist far wider than the configured window is not capped at it:
  // the operator asked for the whole playlist, not the first 100 of it.
  assert.equal(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(500)).window, 498);
});

test('a playlist growing mid-show widens the rotation on the next pick', () => {
  // Nothing is cached: the window is recomputed per pick off the resolved
  // pool, which is what makes "it silently stops being right the moment the
  const show = { playlistStrict: true, playlistExhaust: true };
  assert.equal(guard(show, makeTracks(41)).window, 39, 'one track added in Navidrome, one wider window');
});

test('strict music filters narrow the rotation before it is counted', () => {
  // 40 tracks, 25 of them Jazz. A strict Jazz show rotates 25, not 40 — sizing
  // the window against the raw playlist would withhold tracks the show was
  const tracks = makeTracks(40, { genre: (i) => (i < 25 ? 'Jazz' : 'Rock') });
  const jazz = guard({ playlistStrict: true, playlistExhaust: true, filtersStrict: true, genres: ['Jazz'] }, tracks);
  assert.equal(jazz.window, 23, '25 in-filter tracks → a 23-track window');
  assert.equal(jazz.rotation?.length, 25, 'and the rotation it is measured over is those 25');
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
// headroom slots. It is what a full rotation was measured over before #1919,
// and is kept for the counterfactuals below.
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

// A station for the simulations: one tick per play, and an air-time reader that
// answers the way queue.rotationAirTimes() does — the newest airing, Infinity
// for the track on air. `ended` is the station-wide sidecar, newest first.
function station() {
  let clock = 0;
  let onAir: string | null = null;
  const lastAired = new Map<string, number>();
  const ended: string[] = [];
  const airTimeOf: AirTimeOf = (t) => (t.id === onAir ? Infinity : lastAired.get(t.id!) ?? null);
  return {
    ended,
    airTimeOf,
    onAir: () => onAir,
    play(id: string) {
      if (onAir) ended.unshift(onAir);
      onAir = id;
      lastAired.set(id, ++clock);
    },
  };
}

// The real hard set, through the one function both pick paths call. The
// station-wide window must not be consulted for a full rotation at all.
function rotationBlocked(s: ReturnType<typeof station>, show: Record<string, unknown>, tracks: Track[]): Set<string> {
  const { ids } = hardRecentFor(guard(show, tracks), {
    recentlyPlayedByCount: () => { throw new Error('a full rotation must not read the station-wide window'); },
    rotationAirTimes: () => s.airTimeOf,
  });
  return ids;
}

// Seeded, so a failure reproduces. The pick among eligible tracks is RANDOM on
// purpose: the window alone has to carry the rotation, whatever the model picks.
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The promise itself: a track airs again only once every other track in the
// rotation has aired since its last airing. Returns the violations.
function rotationBreaks(aired: string[], size: number): string[] {
  const breaks: string[] = [];
  const last = new Map<string, number>();
  aired.forEach((id, i) => {
    const prev = last.get(id);
    if (prev != null) {
      const waiting = size - 1 - new Set(aired.slice(prev + 1, i)).size;
      if (waiting > 0) breaks.push(`${id} at airing ${i + 1} with ${waiting} still waiting`);
    }
    last.set(id, i);
  });
  return breaks;
}

test('a 40-track anchor plays 40 distinct tracks before any repeat', () => {
  const tracks = makeTracks(40);
  const show = { playlistStrict: true, playlistExhaust: true };
  const s = station();
  const random = prng(1612);
  const aired: string[] = [];

  // Two full turns and one more: the 41st airing is where a repeat becomes
  // legal, and must be the track that has waited longest.
  for (let pick = 0; pick < 81; pick++) {
    const blocked = rotationBlocked(s, show, tracks);
    const eligible = tracks.filter((t) => !blocked.has(t.id));
    assert.ok(eligible.length > 0, `pick ${pick + 1}: the rotation must never leave an empty pool`);
    const chosen = eligible[Math.floor(random() * eligible.length)];
    s.play(chosen.id);
    aired.push(chosen.id);
  }

  assert.equal(new Set(aired.slice(0, 40)).size, 40, 'the first 40 airings are 40 distinct tracks');
  assert.equal(aired[40], aired[0], 'the 41st airing is the track that has waited longest');
  assert.deepEqual(rotationBreaks(aired, 40), []);
});

test('other shows airing in between do not push the rotation out of its own window (#1919)', () => {
  // The reported station: a 109-track rotation sharing the day with other
  // shows. Measured over the STATION's last 107 plays, a five-hour show the
  // night before filled the window with its own tracks, so the playlist's
  // tracks heard just before the break came round again while others had not
  // aired at all. Measured over the rotation's own airings, it cannot.
  const tracks = makeTracks(109);
  const others = Array.from({ length: 400 }, (_, i) => `other${i + 1}`);
  const show = { playlistStrict: true, playlistExhaust: true };

  const run = (blocked: (s: ReturnType<typeof station>) => Set<string>) => {
    const s = station();
    const random = prng(1919);
    const aired: string[] = [];
    let other = 0;
    while (aired.length < 330) {
      // A 12-pick stretch of this show, then a 75-track show of someone else's.
      for (let pick = 0; pick < 12; pick++) {
        const held = blocked(s);
        const eligible = tracks.filter((t) => !held.has(t.id));
        assert.ok(eligible.length > 0, 'the rotation must never leave an empty pool');
        const chosen = eligible[Math.floor(random() * eligible.length)];
        s.play(chosen.id);
        aired.push(chosen.id);
      }
      for (let i = 0; i < 75; i++) s.play(others[other++ % others.length]);
    }
    return aired;
  };

  const own = run((s) => rotationBlocked(s, show, tracks));
  assert.deepEqual(rotationBreaks(own, 109), [], 'every repeat waits for the whole rotation');

  // The counterfactual pins that the schedule above really is the bug: the
  // same picks against the station-wide window repeat with tracks still waiting.
  const { window } = guard(show, tracks);
  const stationWide = run((s) => blockedSet(s.ended, s.onAir(), window));
  assert.ok(rotationBreaks(stationWide, 109).length > 0, 'the station-wide window breaks the rotation');
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

test('the rotation window counts its own airings only, wherever they aired', () => {
  const tracks = makeTracks(5);
  const at = new Map<string, number>([['t1', 10], ['t2', 40], ['t3', 30], ['t4', 20]]);
  const airTimeOf: AirTimeOf = (t) => at.get(t.id!) ?? null;
  const ids = (window: number) => [...rotationHardSet(tracks, airTimeOf, window).ids].sort();

  // window + 1 newest: the +1 is the slot the on-air track always took.
  assert.deepEqual(ids(2), ['t2', 't3', 't4'], 'the three most recently aired, whatever aired between them');
  // t5 has never aired: it stays eligible however wide the window.
  assert.deepEqual(ids(10), ['t1', 't2', 't3', 't4'], 'a never-aired track is never withheld');
  assert.equal(rotationHardSet(tracks, airTimeOf, 0).ids.size, 0, 'a zero window is off');

  // On air and queued are Infinity: committed to air, so spent first.
  at.set('t1', Infinity);
  at.set('t5', Infinity);
  assert.deepEqual(ids(1), ['t1', 't5'], 'the on-air and queued tracks take the window first');
});

test('a duplicate rip shares its twin\'s history and slot', () => {
  const tracks = [...makeTracks(3), { id: 't1-rip', title: 'Track 1', artist: 'Artist 1', genres: ['Jazz'] }];
  // Only the rip has aired; the identity is spent all the same.
  const airTimeOf: AirTimeOf = (t) => (t.id === 't1-rip' ? 50 : t.id === 't2' ? 10 : null);
  const { ids, keys } = rotationHardSet(tracks, airTimeOf, 1);
  assert.deepEqual([...ids].sort(), ['t1', 't1-rip', 't2'], 'both rows of the newest identity, then the next');
  assert.ok(keys.has('track 1|artist 1'), 'blocked by key too, for an id-less candidate');
});

test('every other show keeps the station-wide window', () => {
  const asked: number[] = [];
  const history = {
    recentlyPlayedByCount: (n: number) => { asked.push(n); return { ids: new Set(['x']), keys: new Set<string>() }; },
    rotationAirTimes: (): AirTimeOf => { throw new Error('only a full rotation reads air times'); },
  };
  assert.deepEqual([...hardRecentFor(guard({ playlistStrict: true }, makeTracks(400)), history).ids], ['x']);
  assert.deepEqual([...hardRecentFor(guard({ playlistStrict: true, playlistExhaust: true }, makeTracks(2)), history).ids], ['x'],
    'a rotation too small for its window is not a rotation');
  assert.deepEqual(asked, [CONFIGURED, 0]);
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
    assert.match(source, /resolvedGenres:/, `${file} must use its resolved genre lock for show capacity`);
    assert.match(source, /minTrackSec,?\s*maxTrackSec,?\s*\}/,
      `${file} must hand the floor to the guard`);
  }
});

test('both pick paths take their hard set from hardRecentFor', () => {
  // A path that went back to queue.recentlyPlayedByCount would measure a full
  // rotation over the station's history again — #1919, on one path only.
  for (const file of ['../src/music/picker.ts', '../src/broadcast/dj-agent.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /hardRecentFor\(noRepeat, queue\)/, `${file} must ask the shared policy for its hard set`);
    assert.doesNotMatch(source, /queue\.recentlyPlayedByCount\(/, `${file} must not read the station-wide window directly`);
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

// The configured window clamps against a strict anchor's own catalogue.
const windowOf = (...args: Parameters<typeof showNoRepeatGuard>) => showNoRepeatGuard(...args).window;
const recencyTracks = makeTracks(40, { genre: (i) => i < 20 ? 'Jazz' : 'Rock' });

test('configured windows clamp to airable strict anchors', () => {
  // A strict playlist is its own catalogue for the hard no-repeat clamp. With
  // only 21 distinct tracks the configured 100-track guard must self-disable so
  // the relaxable recency cascade can cycle the show instead of falling out to
  // unrelated library material.
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: false },
      playlistTracks: recencyTracks.slice(0, 21),
      excludedIds: null,
    }),
    0,
    'a 21-track strict playlist must clamp against 21, not the full library',
  );

  // The clamp is arithmetic, not a switch: pin both sides of it, or a regression
  // that simply returned 0 for every strict playlist would satisfy the whole
  // suite. Below the library ceiling the playlist's own 37.5% governs; above it
  // the operator's configured window is already the smaller number and stands.
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: false },
      playlistTracks: makeTracks(200),
      excludedIds: null,
    }),
    75,
    'a 200-track strict playlist clamps to floor(200 * 0.375), not the configured 100',
  );
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: false },
      playlistTracks: makeTracks(400),
      excludedIds: null,
    }),
    100,
    'a playlist wide enough to carry the configured window keeps it intact',
  );

  // Soft anchors and unresolved anchors still pick from the wider catalogue, so
  // weakening their station-wide no-repeat window would be a regression.
  for (const scope of [
    { show: { playlistStrict: false }, playlistTracks: recencyTracks },
    { show: { playlistStrict: true }, playlistTracks: null },
  ]) {
    assert.equal(
      windowOf(CONFIGURED, LIBRARY, { ...scope, excludedIds: null }),
      100,
      'non-strict or unresolved playlist anchors must remain library-scoped',
    );
  }

  // Strict music filters and excluded playlists narrow the real universe too.
  // Twenty Jazz tracks remain in each case, which is below the minimum useful
  // hard window and must therefore cycle under the relaxable guard.
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: true, genres: ['Jazz'] },
      playlistTracks: recencyTracks,
      excludedIds: null,
    }),
    0,
    'strict music filters must narrow the no-repeat clamp universe',
  );
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: true, genres: ['Pop Punk'] },
      playlistTracks: recencyTracks.map((track, i) => ({
        ...track,
        genres: [i < 20 ? 'Pop' : 'Rock'],
      })),
      excludedIds: null,
      resolvedGenres: ['Pop'],
    }),
    0,
    'capacity must use the same resolved genre alias as candidate filtering',
  );
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: false },
      playlistTracks: recencyTracks,
      excludedIds: new Set(recencyTracks.slice(20).map(track => track.id)),
    }),
    0,
    'excluded playlist tracks must not inflate the no-repeat clamp universe',
  );

  // Different Subsonic ids for the same title/artist are one audible track. If
  // counted separately these 40 rows would enable a 15-track hard window; as 20
  // real songs the guard must switch off instead.
  const duplicateRips = recencyTracks.slice(0, 20).flatMap(track => [
    track,
    { ...track, id: `${track.id}-duplicate` },
  ]);
  assert.equal(
    windowOf(CONFIGURED, LIBRARY, {
      show: { playlistStrict: true, filtersStrict: false },
      playlistTracks: duplicateRips,
      excludedIds: null,
    }),
    0,
    'duplicate title/artist rips must count as one track for clamp capacity',
  );

});
