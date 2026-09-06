// Minimum track length (#1573) — the pure policy in music/track-floor.ts, the
// resolver's precedence, and the operator dial's cold-load round trip.
//
// THE DEFECT THIS GUARDS. The floor is the mirror image of the max-track-length
// cap and shares almost none of its mechanics: a cap is a cue_out cut applied
// to a track that stayed eligible, while a floor has to remove the track from
// the pool, because a 40-second interlude cannot be lengthened. Anything that
// "unifies" the two — reusing filterPickerCandidates' deliberate "track length
// is NOT a selection criterion" comment, or stamping the floor on the
// annotation next to maxDurationSec — silently switches the feature off.
//
// The cold-load half exists for the reason llm-repeat-penalty.test.ts
// documents: load()'s section blocks compose explicitly rather than spreading
// DEFAULTS, so a field missing from load() still validates, still saves, and
// still works for the rest of the process — then vanishes on the next restart.
//
// Run: npm test -- track-floor

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-track-floor-'));
process.env.STATE_DIR = stateRoot;

const { applyTrackFloor, belowTrackFloor, trackLengthSeconds } =
  await import('../src/music/track-floor.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { buildShowCandidateDiagnostic } = await import('../src/music/show-candidates.js');
const { PICKER_MIN_TRACK_LENGTH_BOUNDS } = await import('../src/schemas/settings.js');
const { SHOW_MIN_TRACK_LENGTH_MAX } = await import('../src/schemas/show.js');
const { durationSeconds } = await import('../src/music/recency.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

async function coldLoad(stored: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  return settings.get();
}

// ── the pure policy ────────────────────────────────────────────────────────

test('length is read from either field name a source may carry', () => {
  // Subsonic children carry `duration`; library rows carry `durationSec`. A
  // reader that knew only one name would read half the pool as unknown length.
  assert.equal(trackLengthSeconds({ duration: 45 }), 45);
  assert.equal(trackLengthSeconds({ durationSec: 45 }), 45);
  assert.equal(trackLengthSeconds({}), null);
  assert.equal(trackLengthSeconds(null), null);
});

test('zero, negative and non-finite lengths read as UNKNOWN, never as short', () => {
  // A 0 in the duration column is a track nobody measured, not a zero-second
  // track — reading it as short would drop rows the floor was never aimed at.
  for (const d of [0, -30, NaN, Infinity, '45' as unknown as number]) {
    assert.equal(belowTrackFloor({ durationSec: d as number }, 60), false, `${String(d)}`);
  }
});

test('an unknown length passes the floor', () => {
  // Same tolerance every other filter here gives an unmeasured track. Dropping
  // unknowns would turn a 60s floor into "play only what we happen to have
  // walked", which is a much larger behaviour change than the one asked for.
  assert.equal(belowTrackFloor({}, 60), false);
});

test('a floor of 0/null/undefined is a no-op, and that is the shipped default', () => {
  const pool = [{ durationSec: 5 }, { durationSec: 400 }];
  for (const min of [0, null, undefined, -10]) {
    assert.deepEqual(applyTrackFloor(pool, min, { starve: true }), pool);
    assert.equal(belowTrackFloor({ durationSec: 5 }, min), false);
  }
});

test('a positive floor drops the short tracks and keeps the rest', () => {
  const pool = [
    { id: 'skit', durationSec: 41 },
    { id: 'song', durationSec: 213 },
    { id: 'unwalked' },
  ];
  assert.deepEqual(
    applyTrackFloor(pool, 60, { starve: true }).map(t => t.id),
    ['song', 'unwalked'],
  );
});

test('the floor is exclusive at the boundary: exactly the floor passes', () => {
  assert.equal(belowTrackFloor({ durationSec: 60 }, 60), false);
  assert.equal(belowTrackFloor({ durationSec: 59 }, 60), true);
});

test('starve:true empties, starve:false never-starves — the two postures', () => {
  // Both are deliberate and are chosen per call site, exactly as
  // show-filter.applyStrictLocks does it: HARD in the agent's discovery tools
  // (a tool that returns nothing contributes nothing, and the pool picker is
  // the wider dead-air scope behind it), never-starve in that pool picker and
  // in the auto.m3u coast, which ARE the dead-air scope. Unifying them is the
  // bug in one direction or the other.
  const allShort = [{ id: 'a', durationSec: 20 }, { id: 'b', durationSec: 30 }];
  assert.deepEqual(applyTrackFloor(allShort, 60, { starve: true }), []);
  assert.deepEqual(applyTrackFloor(allShort, 60, { starve: false }), allShort);
});

test('never-starve does NOT fire while anything survives', () => {
  const pool = [{ id: 'a', durationSec: 20 }, { id: 'b', durationSec: 300 }];
  assert.deepEqual(applyTrackFloor(pool, 60, { starve: false }).map(t => t.id), ['b']);
});

// ── the resolver's precedence ──────────────────────────────────────────────

test('the shipped default is OFF, so an upgrade picks byte-identically', async () => {
  await coldLoad({});
  assert.equal(settings.get().picker.minTrackLengthSeconds, 0);
  assert.equal(settings.effectiveMinTrackSec(null), null, 'no show, no station value');
});

test('the station default applies when the show sets nothing', async () => {
  await coldLoad({ picker: { minTrackLengthSeconds: 90 } });
  assert.equal(settings.effectiveMinTrackSec(null), 90);
  assert.equal(settings.effectiveMinTrackSec({ minTrackLengthSeconds: null }), 90, 'null = inherit');
});

test("a show's own floor overrides the station's — including 0 as an opt-OUT", async () => {
  await coldLoad({ picker: { minTrackLengthSeconds: 90 } });
  assert.equal(settings.effectiveMinTrackSec({ minTrackLengthSeconds: 240 }), 240);
  // 0 at the winning level is "no floor", not "unset" — the same split
  // effectiveMaxTrackSec draws, so a skit-and-interlude show can opt out of a
  // station floor its sibling shows want.
  assert.equal(settings.effectiveMinTrackSec({ minTrackLengthSeconds: 0 }), null);
});

test('a junk stored value resolves to no floor rather than an error', async () => {
  await coldLoad({ picker: { minTrackLengthSeconds: 'ages' } });
  assert.equal(settings.effectiveMinTrackSec(null), null);
});

// ── the operator dial ──────────────────────────────────────────────────────

test('a configured floor survives a controller restart', async () => {
  await coldLoad({ picker: { minTrackLengthSeconds: 120 } });
  assert.equal(settings.get().picker.minTrackLengthSeconds, 120);
});

test('a stored value is clamped rather than refused — load stays lenient', async () => {
  assert.equal((await coldLoad({ picker: { minTrackLengthSeconds: 99999 } })).picker.minTrackLengthSeconds, 3600);
  assert.equal((await coldLoad({ picker: { minTrackLengthSeconds: -5 } })).picker.minTrackLengthSeconds, 0);
  assert.equal((await coldLoad({ picker: { minTrackLengthSeconds: 'soon' } })).picker.minTrackLengthSeconds, 0);
});

test('saving a floor then restarting keeps it — the operator story', async () => {
  await coldLoad({});
  await settings.update({ picker: { minTrackLengthSeconds: 75 } } as never);
  assert.equal(settings.get().picker.minTrackLengthSeconds, 75, 'applies immediately');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().picker.minTrackLengthSeconds, 75, 'and survives the restart');
});

test('the patch path refuses what load() repairs', async () => {
  await coldLoad({ picker: { minTrackLengthSeconds: 75 } });
  await assert.rejects(
    () => settings.update({ picker: { minTrackLengthSeconds: 99999 } } as never),
    /picker\.minTrackLengthSeconds must be between 0 and 3600/,
  );
  assert.equal(settings.get().picker.minTrackLengthSeconds, 75, 'a refused patch changes nothing');
});

test('a positive floor must clear the crossfade-derived minimum; 0 always passes', async () => {
  // The distinct-name half of #1573: settings.minTrackSeconds() is the
  // CROSSFADE floor and keeps its meaning, and it is this key's lower bound —
  // below 2x the crossfade a track never gets solo airtime at all, so a floor
  // under it cannot express anything the mixer doesn't already impose.
  await coldLoad({});
  const floor = settings.minTrackSeconds();
  await assert.rejects(
    () => settings.update({ picker: { minTrackLengthSeconds: 1 } } as never),
    new RegExp(`picker\\.minTrackLengthSeconds must be 0 \\(no floor\\) or at least ${floor}s`),
  );
  await settings.update({ picker: { minTrackLengthSeconds: floor } } as never);
  assert.equal(settings.get().picker.minTrackLengthSeconds, floor);
  // 0 is off and must stay reachable whatever the crossfade is — it is what
  // makes an untouched station byte-identical.
  await settings.update({ picker: { minTrackLengthSeconds: 0 } } as never);
  assert.equal(settings.get().picker.minTrackLengthSeconds, 0);
});

test('a fractional patch lands on whole seconds', async () => {
  await coldLoad({});
  await settings.update({ picker: { minTrackLengthSeconds: 90.6 } } as never);
  assert.equal(settings.get().picker.minTrackLengthSeconds, 91);
});

test('the two track-length keys are independent — setting one leaves the other', async () => {
  await coldLoad({});
  await settings.update({ maxTrackSeconds: 600 } as never);
  await settings.update({ picker: { minTrackLengthSeconds: 90 } } as never);
  assert.equal(settings.get().maxTrackSeconds, 600);
  assert.equal(settings.get().picker.minTrackLengthSeconds, 90);
});

// ── the show-editor candidate diagnostic ───────────────────────────────────

const LIB = [
  { id: 'skit', durationSec: 38, genres: ['Jazz'], moods: [], audioMoods: [], energy: null, vocalRanges: null },
  { id: 'song', durationSec: 300, genres: ['Jazz'], moods: [], audioMoods: [], energy: null, vocalRanges: null },
];
const NO_LOCKS = { genres: [], eras: [], moods: [], energies: [], vocals: null };

test('the diagnostic counts what the picker will actually see', () => {
  // The funnel is what an operator reads before saving a show. Counting a track
  // the floor will refuse is the diagnostic lying about the very setting being
  // configured on that screen.
  const off = buildShowCandidateDiagnostic({
    show: {}, libraryRows: LIB, playlistRows: null, excludedIds: null, locks: NO_LOCKS,
  });
  assert.equal(off.library.indexed, 2, 'no floor: both counted');
  assert.equal(off.library.effective, 2);

  const on = buildShowCandidateDiagnostic({
    show: {}, libraryRows: LIB, playlistRows: null, excludedIds: null, locks: NO_LOCKS,
    minTrackSec: 60,
  });
  assert.equal(on.library.effective, 1, 'the floor removes the skit from the pool');
});

test('the funnel\'s INPUT counts stay pre-floor — a labelled field keeps its meaning', () => {
  // `library.indexed` is the indexed library and `playlist.total` is the
  // playlist; the show editor renders the latter verbatim as "Playlist anchor:
  // N tracks". Moving them post-floor made both fields report something other
  // than their own name. The floor belongs in the DROP to the steps below,
  // which is the entire point of a funnel.
  const d = buildShowCandidateDiagnostic({
    show: {}, libraryRows: LIB, playlistRows: LIB, excludedIds: null, locks: NO_LOCKS,
    minTrackSec: 60,
  });
  assert.equal(d.library.indexed, 2, 'indexed still means indexed');
  assert.equal(d.playlist!.total, 2, 'total still means the whole playlist');
  assert.equal(d.library.effective, 1);
  assert.equal(d.playlist!.effective, 1);
});

test('the floor applies to a pinned playlist too, and is NOT gated on strict', () => {
  // Every other filter in the funnel answers to filtersStrict. This one does
  // not — it is the cap's twin, and no show opts into that either.
  const d = buildShowCandidateDiagnostic({
    show: { filtersStrict: false }, libraryRows: LIB, playlistRows: LIB,
    excludedIds: null, locks: NO_LOCKS, minTrackSec: 60,
  });
  assert.equal(d.strict, false);
  assert.equal(d.playlist!.matchingFilters, 1);
  assert.equal(d.playlist!.effective, 1);
});

// ── the aliasing contract ──────────────────────────────────────────────────
//
// THE DEFECT THIS GUARDS. The auto.m3u coast rebuilds its pool IN PLACE
// (`pool.length = 0; pool.push(...kept)`) because `pool` is owned by the
// balanced pool builder. A filter that answers "keep everything" by handing its
// input straight back therefore hands the caller the very array it is about to
// clear — and the never-starve branch, which exists to stop the coast going
// silent, is precisely where that fires. The result was an empty auto.m3u: a
// dead-air guard that produced dead air.

test('applyTrackFloor NEVER returns its input array, on any branch', () => {
  const pool = [{ id: 'a', duration: 30 }, { id: 'b', duration: 40 }];
  // no floor
  assert.notEqual(applyTrackFloor(pool, 0, { starve: false }), pool);
  assert.notEqual(applyTrackFloor(pool, null, { starve: true }), pool);
  // never-starve rescue: everything is below the floor, so everything is kept
  assert.notEqual(applyTrackFloor(pool, 90, { starve: false }), pool);
  // ordinary filtering already allocated
  assert.notEqual(applyTrackFloor(pool, 35, { starve: false }), pool);
  // and the contents are still right on every one of them
  assert.deepEqual(applyTrackFloor(pool, 0, { starve: false }).map(t => t.id), ['a', 'b']);
  assert.deepEqual(applyTrackFloor(pool, 90, { starve: false }).map(t => t.id), ['a', 'b']);
});

test('the coast\'s in-place pool rebuild survives the never-starve rescue', () => {
  // The scheduler idiom, verbatim. Before the fix this left `pool` empty and
  // auto.m3u was written with nothing but its #EXTM3U header.
  const pool = [{ id: 'skit', duration: 30 }, { id: 'interlude', duration: 40 }];
  const longEnough = applyTrackFloor(pool, 90, { starve: false });
  pool.length = 0;
  pool.push(...longEnough);
  assert.deepEqual(pool.map(t => t.id), ['skit', 'interlude'],
    'never-starve must leave the coast something to play, not empty it');
});

test('a zero duration beside a real durationSec reads as the real one', () => {
  // `duration ?? durationSec` only falls through on null/undefined, so a
  // Subsonic child whose server never measured the track (duration: 0) shadowed
  // the library row's true length sitting next to it and slipped past the floor.
  assert.equal(trackLengthSeconds({ duration: 0, durationSec: 300 }), 300);
  assert.equal(belowTrackFloor({ duration: 0, durationSec: 30 }, 60), true);
  assert.equal(belowTrackFloor({ duration: 0, durationSec: 300 }, 60), false);
  // Still unknown when NEITHER field is usable — unknown always passes.
  assert.equal(trackLengthSeconds({ duration: 0, durationSec: 0 }), null);
  assert.equal(belowTrackFloor({ duration: 0, durationSec: 0 }, 60), false);
});

test('the cap and the floor cannot disagree about how long a track is', () => {
  // recency.durationSeconds (the cap's reader) delegates to trackLengthSeconds
  // rather than restating it — two copies of this rule is how the two ends of
  // the same setting drift apart.
  for (const t of [
    { duration: 0, durationSec: 300 },
    { duration: 240 },
    { durationSec: 38 },
    { duration: -1, durationSec: null },
    {},
  ]) {
    assert.equal(durationSeconds(t as any), trackLengthSeconds(t as any));
  }
});

test('the two 3600 ceilings that "must move together" actually match', () => {
  // The per-show override and the station default bound the same number, but a
  // mirrored schema module may import only zod, so they are two declarations.
  // defaults.ts BOUNDS clamps loads against the SHOW one while the patch schema
  // validates saves against the PICKER one — drift would let update() accept a
  // value the next cold load silently clamps away.
  assert.equal(PICKER_MIN_TRACK_LENGTH_BOUNDS.max, SHOW_MIN_TRACK_LENGTH_MAX);
  assert.equal(PICKER_MIN_TRACK_LENGTH_BOUNDS.min, 0);
});
