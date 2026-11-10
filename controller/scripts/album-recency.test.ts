// The album cooldown's key and its pool-path enforcement (#1485 FR 3).
//
// Three things have to hold, and only the first is obvious:
//
//   1. albumKey identifies a RECORD — album title plus its lead artist, folded
//      the same way artistRootKey folds a name.
//   2. A compilation is EXEMPT. Two tracks off "Now 47" in an evening is
//      ordinary radio; a cooldown there is the feature misfiring. The signal is
//      the era pipeline's existing isCompilation/yearUntrusted composition
//      (#1418) — never a second heuristic.
//   3. With the cooldown OFF (the shipped default) the pool filter is
//      byte-identical to what it was before this existed. This is the half a
//      regression would hide in, so it is asserted against the real modes.
//
// The guard's own composition on the agent path is pinned separately, without
// settings or a queue, in album-guard-run.test.ts.
//
// Run: npm test -- album-recency

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  albumCooldownExempt,
  albumKey,
  filterPickerCandidates,
  isVariousArtistsName,
} from '../src/music/recency.js';

// ── albumKey: the record, and who made it ──────────────────────────────────

test('an album keys on its title and its lead artist', () => {
  assert.equal(albumKey({ album: 'Kid A', artist: 'Radiohead' }), 'kid a|radiohead');
  // Folded exactly as artistRootKey folds: case, curly apostrophes, whitespace.
  assert.equal(
    albumKey({ album: '  WHAT’S   GOING On ', artist: 'Marvin Gaye' }),
    "what's going on|marvin gaye",
  );
  // A leading article is decoration on the ARTIST half only — the record's own
  // title keeps every word, because "The Wall" and "Wall" are not one album.
  assert.equal(albumKey({ album: 'The Wall', artist: 'Pink Floyd' }), 'the wall|pink floyd');
});

test('a collaboration keys with the artist fronting it', () => {
  // The same collapse artistRootKey performs, so one record's tracks share a
  // key however the ripper credited each one.
  assert.equal(
    albumKey({ album: 'United', artist: 'Marvin Gaye & Tammi Terrell' }),
    albumKey({ album: 'United', artist: 'Marvin Gaye' }),
  );
});

test('an album artist outranks the track artist', () => {
  // The whole point of preferring it: a guest verse on one track must not put
  // that track on a different record from the rest of the album.
  assert.equal(
    albumKey({ album: 'Donuts', artist: 'Guest Rapper', albumArtist: 'J Dilla' }),
    'donuts|j dilla',
  );
});

test('no album, no artist and no track at all key as nothing', () => {
  // '' matches nothing on either side, which is what makes "unknown" mean
  // "no evidence of a repeat" rather than "a repeat".
  assert.equal(albumKey({ artist: 'Radiohead' }), '');
  assert.equal(albumKey({ album: 'Kid A' }), '');
  assert.equal(albumKey({ album: '   ', artist: 'Radiohead' }), '');
  assert.equal(albumKey({}), '');
});

test('an edition suffix is NOT stripped', () => {
  // Deliberate: guessing which parenthetical is an edition and which is part of
  // the record's name fails in the direction of a cooldown nobody asked for.
  assert.notEqual(
    albumKey({ album: 'Kid A (Remastered)', artist: 'Radiohead' }),
    albumKey({ album: 'Kid A', artist: 'Radiohead' }),
  );
});

// ── compilations are exempt, on the existing plumbing ──────────────────────

test('the various-artists names are the ones era-suspect already knows', () => {
  for (const name of ['Various Artists', 'various', 'VA', 'V.A.', 'Verschiedene', 'divers']) {
    assert.equal(isVariousArtistsName(name), true, name);
  }
  assert.equal(isVariousArtistsName('Various Cruelties'), false, 'a real band named Various…');
  assert.equal(isVariousArtistsName(null), false);
});

test('a compilation is exempt by every signal the era pipeline composes', () => {
  const sampler = { album: 'Now 47', artist: 'Some Act' };
  // Navidrome's own flag…
  assert.equal(albumCooldownExempt({ ...sampler, isCompilation: true }), true);
  // …the composed flag the walk derives when Navidrome's is empty (#1418)…
  assert.equal(albumCooldownExempt({ ...sampler, yearUntrusted: true }), true);
  // …and the album-artist marker.
  assert.equal(albumCooldownExempt({ ...sampler, albumArtist: 'Various Artists' }), true);

  for (const s of [
    { ...sampler, isCompilation: true },
    { ...sampler, yearUntrusted: true },
    { ...sampler, albumArtist: 'Various Artists' },
  ]) {
    assert.equal(albumKey(s), '', 'an exempt album has no key, so it cannot block');
  }
});

test('an ordinary album is not exempt, flags present or absent', () => {
  const ok = { album: 'Kid A', artist: 'Radiohead' };
  assert.equal(albumCooldownExempt(ok), false, 'no flags = no evidence, not a compilation');
  assert.equal(albumCooldownExempt({ ...ok, isCompilation: false, yearUntrusted: false }), false);
  assert.notEqual(albumKey(ok), '');
});

test('an untagged compilation cannot block a whole evening', () => {
  // The failure this guards against: a sampler whose flags never reached us.
  // Because the key carries the LEAD ARTIST, twelve different artists on one
  // untagged sampler get twelve different keys, so one airing blocks only that
  // artist's other tracks off it — not the record.
  const one = albumKey({ album: 'Café del Mar', artist: 'Salt Tank' });
  const two = albumKey({ album: 'Café del Mar', artist: 'Underworld' });
  assert.notEqual(one, '');
  assert.notEqual(one, two);
});

// ── the pool path's filter ─────────────────────────────────────────────────

type Cand = {
  id: string; title: string; artist: string;
  album?: string; isCompilation?: boolean | null;
};

const kidA1: Cand = { id: 'k1', title: 'Everything In Its Right Place', artist: 'Radiohead', album: 'Kid A' };
const kidA2: Cand = { id: 'k2', title: 'The National Anthem', artist: 'Radiohead', album: 'Kid A' };
const bends: Cand = { id: 'b1', title: 'Fake Plastic Trees', artist: 'Radiohead', album: 'The Bends' };
const clash: Cand = { id: 'c1', title: 'Clampdown', artist: 'The Clash', album: 'London Calling' };
const nowA: Cand = { id: 'n1', title: 'A Track', artist: 'Act One', album: 'Now 47', isCompilation: true };
const nowB: Cand = { id: 'n2', title: 'B Track', artist: 'Act Two', album: 'Now 47', isCompilation: true };

const ids = (list: Cand[]) => list.map((s) => s.id);

test('a recent album is dropped from the pool; its artist\'s other records are not', () => {
  const out = filterPickerCandidates([kidA2, bends, clash], {
    recentAlbums: new Set([albumKey(kidA1)]),
  });
  assert.deepEqual(ids(out), ['b1', 'c1']);
});

test('a compilation neither blocks nor is blocked', () => {
  // nowA aired; nowB is another track off the same sampler and stays eligible.
  const out = filterPickerCandidates([nowB, clash], {
    recentAlbums: new Set([albumKey(nowA)].filter(Boolean)),
  });
  assert.deepEqual(ids(out), ['n2', 'c1']);
});

test('the album guard is the FIRST thing the starvation cascade drops', () => {
  // Only Kid A tracks are on offer and Kid A is on cooldown. The pool must
  // still answer — music never stops for a preference — and it must answer by
  // dropping the ALBUM guard, not the artist or track guards above it.
  const out = filterPickerCandidates([kidA2], {
    recentAlbums: new Set([albumKey(kidA1)]),
  });
  assert.deepEqual(ids(out), ['k2'], 'never returns empty over an album cooldown');
});

test('the hard no-repeat guard still outranks the album stage', () => {
  // hardRecentIds is checked OUTSIDE every mode, so prepending an album stage
  // must not have opened a way past it. c1 is hard-blocked and stays blocked
  // through the relaxation; k2 is only album-blocked, so it is what the cascade
  // gives back — the album guard yielding is the correct outcome here, and the
  // hard guard not yielding is the assertion.
  const out = filterPickerCandidates([kidA2, clash], {
    recentAlbums: new Set([albumKey(kidA1)]),
    hardRecentIds: new Set(['c1']),
  });
  assert.deepEqual(ids(out), ['k2']);

  // With nothing but the hard-blocked track on offer the answer is empty — the
  // album stage's relaxation cannot resurrect it.
  const only = filterPickerCandidates([clash], {
    recentAlbums: new Set([albumKey(clash)]),
    hardRecentIds: new Set(['c1']),
  });
  assert.deepEqual(ids(only), []);
});

test('with the cooldown OFF the filter is exactly what it was', () => {
  // The upgrade story. An empty album set removes the stage entirely, so every
  // existing relaxation outcome is reproduced verbatim.
  const pool = [kidA1, kidA2, bends, clash];
  const off = filterPickerCandidates(pool, {});
  assert.deepEqual(ids(off), ['k1', 'k2', 'b1', 'c1']);

  // …including the artist relaxation cascade: every candidate is a recent
  // artist, so the pool relaxes to the whole list rather than returning empty.
  const relaxed = filterPickerCandidates([kidA1, bends], {
    recentArtists: new Set(['radiohead']),
  });
  assert.deepEqual(ids(relaxed), ['k1', 'b1']);

  // And with the guard ON but nothing recent, the answer is unchanged again.
  const onButClear = filterPickerCandidates(pool, { recentAlbums: new Set(['some other|record']) });
  assert.deepEqual(ids(onButClear), ids(off));
});
