// Regression test for the pick-anchor artist guard's re-pick (issue #1251).
// Run: `tsx scripts/artist-guard.test.ts`.
//
// Two defects, one guard:
//   1. The re-pick excluded ONLY the rejected anchor artist, so whichever artist ranked
//      next-highest in the run won it every time the guard fired — no adjacent
//      repeats, but the same artist every other slot.
//   2. artistKey was a raw lowercase compare, so "Marvin Gaye & Tammi Terrell"
//      was a different artist from "Marvin Gaye" and walked past the guard.
//
// node:assert-via-tsx style, matching scripts/picker-recency-regression.test.ts.

import assert from 'node:assert/strict';
import { artistKey, artistRootKey, filterPickerCandidates } from '../src/music/recency.js';
import { ARTIST_VARIETY_WINDOW, alternativeCandidates, artistGuardCause } from '../src/broadcast/dj-agent/artist-guard.js';
import { queue } from '../src/broadcast/queue.js';

// ── artistRootKey: collaborations collapse, band names don't ────────────────

const collapses: [string, string][] = [
  ['Marvin Gaye & Tammi Terrell', 'marvin gaye'],
  ['Marvin Gaye and Tammi Terrell', 'marvin gaye'],
  ['  MARVIN GAYE & Tammi Terrell ', 'marvin gaye'],
  ['Kanye West feat. Jay-Z', 'kanye west'],
  ['Kanye West ft Jay-Z', 'kanye west'],
  ['Calvin Harris (feat. Rihanna)', 'calvin harris'],
  ['Daft Punk featuring Pharrell Williams', 'daft punk'],
  // A feature credit on top of a duo: the feature splits first, then the join.
  ['Marvin Gaye & Tammi Terrell feat. The Funk Brothers', 'marvin gaye'],
];
for (const [raw, want] of collapses) {
  assert.equal(artistRootKey(raw), want, `"${raw}" → "${want}"`);
  assert.equal(artistRootKey({ artist: raw }), want, `"${raw}" (candidate form) → "${want}"`);
}

// "X & the Y" / "X and the Y" is ONE act. Stripping the tail would key half the
// soul and Motown bench onto a first name — and both of these are in the live
// log the issue was filed from.
const intact = [
  'Sly & the Family Stone',
  'Diana Ross and the Supremes',
  'Bob Marley & The Wailers',
  'Florence + the Machine',
  'Booker T. & the M.G.\'s',
  'AC/DC',
];
for (const raw of intact) {
  assert.equal(artistRootKey(raw), raw.toLowerCase().trim(), `"${raw}" must keep its whole name`);
}

// ── name variants of ONE act collapse together (#1406) ─────────────────────

// The reported bypass: "The Jimi Hendrix Experience" straight into "Jimi
// Hendrix" — two tags for one artist, so the guard never fired.
const variants: [string, string][] = [
  ['The Jimi Hendrix Experience', 'jimi hendrix'],
  ['Jimi Hendrix', 'jimi hendrix'],
  ['The Clash', 'clash'],
  ['Clash', 'clash'],
  ['Glenn Miller Orchestra', 'glenn miller'],
  ['Dave Matthews Band', 'dave matthews'],
  ['The Bill Evans Trio', 'bill evans'],
  // Curly vs straight apostrophe — the same act off two different rippers.
  ['Guns N\u2019 Roses', "guns n' roses"],
  ["Guns N' Roses", "guns n' roses"],
  // Whitespace runs are noise, not identity.
  ['The   Jimi  Hendrix   Experience', 'jimi hendrix'],
];
for (const [raw, want] of variants) {
  assert.equal(artistRootKey(raw), want, `"${raw}" \u2192 "${want}"`);
}

// An ensemble word can be part of an act's real name rather than a removable
// credit. Generic suffix stripping turns these unrelated pairs into the same
// hard-block key, so the fallback rescue can discard a legitimate alternative.
const distinctEnsembleNames: [string, string, string][] = [
  ['The Beta Band', 'beta band', 'Beta'],
  ['Manchester Orchestra', 'manchester orchestra', 'Manchester'],
  ['Unknown Mortal Orchestra', 'unknown mortal orchestra', 'Unknown Mortal'],
  ['Kronos Quartet', 'kronos quartet', 'Kronos'],
];
for (const [raw, want, unrelated] of distinctEnsembleNames) {
  assert.equal(artistRootKey(raw), want, `"${raw}" must keep its complete act name`);
  assert.notEqual(
    artistRootKey(raw),
    artistRootKey(unrelated),
    `"${raw}" and "${unrelated}" are unrelated artists`,
  );
}

const betaRescuePool = [
  { id: 'beta', title: 'A Different Track', artist: 'Beta' },
];
assert.deepEqual(
  filterPickerCandidates(betaRescuePool, {
    blockedArtists: new Set([artistRootKey('The Beta Band')]),
  }).map((song) => song.id),
  ['beta'],
  'a hard rescue block for The Beta Band must not discard Beta',
);

// Normalisation must never empty a key — an empty root matches nothing and
// would silently switch the guard off for that artist.
assert.equal(artistRootKey('The Band'), 'band', 'an act that is ONLY a suffix keeps it');
assert.equal(artistRootKey('The The'), 'the', 'an act that is ONLY an article keeps it');
assert.equal(artistRootKey('Orchestra'), 'orchestra', 'a bare suffix is a name, not a suffix');

// The article strip runs AFTER the join, so the join's "the ..." exception —
// the thing keeping half the Motown bench off a first name — still sees the
// tail it was written for.
assert.equal(
  artistRootKey('Sly & the Family Stone'),
  'sly & the family stone',
  'the article strip must not reach a band name through the join exception',
);

// ── artistGuardCause: when does the guard fire ─────────────────────────────

{
  const recent = new Set(['the beatles', 'marvin gaye'].map((a) => artistRootKey(a)));
  assert.equal(
    artistGuardCause(artistRootKey('Marvin Gaye'), artistRootKey('Marvin Gaye'), recent),
    'onair',
    'a pick matching its anchor uses the legacy onair cause',
  );
  // The #1406 case: legal by the old guard, three slots after the same artist.
  assert.equal(
    artistGuardCause(artistRootKey('The Beatles'), artistRootKey('Marvin Gaye'), recent),
    'recent',
    'a pick inside the spacing window fires on the recent cause',
  );
  assert.equal(
    artistGuardCause(artistRootKey('The Clash'), artistRootKey('Marvin Gaye'), recent),
    null,
    'an artist outside the window is not guarded',
  );
  // Normalisation and the guard are one mechanism: the variant must reach it.
  assert.equal(
    artistGuardCause(
      artistRootKey('Jimi Hendrix'),
      artistRootKey('The Jimi Hendrix Experience'),
      new Set(),
    ),
    'onair',
    'a name variant of the anchor act still uses the strong anchor cause',
  );
  // Window off (operator set 0) → pick-anchor protection is NOT disableable.
  assert.equal(
    artistGuardCause(artistRootKey('Marvin Gaye'), artistRootKey('Marvin Gaye'), new Set()),
    'onair',
    'an empty window still guards a pick-anchor match',
  );
  assert.equal(
    artistGuardCause(artistRootKey('The Beatles'), artistRootKey('Marvin Gaye'), new Set()),
    null,
    'an empty window guards nothing else',
  );
  // An untagged pick is not evidence of a repeat, on either cause.
  assert.equal(artistGuardCause('', artistRootKey('Marvin Gaye'), recent), null, 'no artist, no guard');
}

// Empty / missing artist is empty, never a wildcard that matches everything.
assert.equal(artistRootKey(''), '', 'empty artist → empty key');
assert.equal(artistRootKey({ artist: null }), '', 'null artist → empty key');
assert.equal(artistRootKey({}), '', 'absent artist → empty key');
// A leading join isn't a credit list — nothing to strip, and never an empty key.
assert.equal(artistRootKey('& Friends'), '& friends', 'a leading join keeps the raw key');

// artistKey stays an IDENTITY key: it feeds trackKey, whose `title|artist`
// shape must match the keys queue.recentlyPlayed builds from raw tag text. If
// this ever collapses too, every count-based no-repeat key silently stops
// matching its recent-play row.
assert.equal(
  artistKey({ artist: 'Marvin Gaye & Tammi Terrell' }),
  'marvin gaye & tammi terrell',
  'artistKey must NOT collapse collaborations — it is the identity key',
);

// ── alternativeCandidates: the re-pick's candidate set ──────────────────────

type Cand = { id: string; title: string; artist: string };
const seenOf = (...songs: Cand[]) => new Map(songs.map((s) => [s.id, s]));

const marvin = { id: 'm1', title: 'Heavy Love Affair', artist: 'Marvin Gaye' };
const marvinTammi = { id: 'm2', title: 'If I Could Build My Whole World Around You', artist: 'Marvin Gaye & Tammi Terrell' };
const clash = { id: 'c1', title: 'Living in Fame', artist: 'The Clash' };
const beatles = { id: 'b1', title: 'Ob-La-Di, Ob-La-Da', artist: 'The Beatles' };
const sly = { id: 's1', title: 'Fun', artist: 'Sly & the Family Stone' };

// The rejected artist is excluded — and so is the collaboration they front. This
// is the third slot of the live repro: the guard was avoiding Marvin Gaye and
// the re-pick handed back Marvin Gaye & Tammi Terrell.
{
  const { alt } = alternativeCandidates(seenOf(marvin, marvinTammi, clash), artistRootKey('Marvin Gaye'));
  assert.deepEqual([...alt.keys()], ['c1'], 'both the artist and their collaboration must be excluded');
}

// …and the reverse: rejecting a collaboration excludes the lead artist's solo work.
{
  const { alt } = alternativeCandidates(seenOf(marvin, clash), artistRootKey('Marvin Gaye & Tammi Terrell'));
  assert.deepEqual([...alt.keys()], ['c1'], 'a rejected collaboration must exclude the lead artist too');
}

// The #1251 case proper. Guard fires on The Beatles; the run's alternatives are
// Marvin Gaye (played two slots ago) and Sly. Without a recency window the
// re-pick is free to return to Marvin — and did, every time.
{
  const recent = new Set(['the beatles', 'marvin gaye', 'the clash'].map((a) => artistRootKey(a)));
  const { alt, dropped, starved } = alternativeCandidates(seenOf(marvin, sly), artistRootKey('The Beatles'), recent);
  assert.deepEqual([...alt.keys()], ['s1'], 'an artist inside the recency window must not win the re-pick');
  assert.equal(dropped, 1, 'the narrowing is counted so the booth log can report it');
  assert.equal(starved, false, 'a narrowing that left candidates is not starvation');
}

// A recently-played artist's COLLABORATION is inside the window too — otherwise
// normalisation fixes the guard check and leaves the oscillation intact one
// name longer.
{
  const recent = new Set([artistRootKey('Marvin Gaye')]);
  const { alt } = alternativeCandidates(seenOf(marvinTammi, sly), artistRootKey('The Beatles'), recent);
  assert.deepEqual([...alt.keys()], ['s1'], 'a recent artist\'s collaboration is also recent');
}

// Never starve: when EVERY alternative is recently played, hand back the bare
// rejected-artist exclusion rather than nothing. A repeat five slots later beats a
// repeat one slot later, and the run genuinely did surface another artist —
// escalating to the pool rescue here would be the wrong answer.
{
  const recent = new Set(['marvin gaye', 'sly & the family stone'].map((a) => artistRootKey(a)));
  const { alt, dropped, starved } = alternativeCandidates(seenOf(marvin, sly), artistRootKey('The Beatles'), recent);
  assert.deepEqual([...alt.keys()].sort(), ['m1', 's1'], 'a wholly-recent alternative set must not empty the pool');
  assert.equal(dropped, 0, 'the fallback reports no narrowing — it narrowed nothing');
  assert.equal(starved, true, 'the waived window is reported as starved, distinct from a no-op window');
}

// An untagged candidate is not evidence of a repeat: it survives both filters.
{
  const untagged = { id: 'u1', title: 'Unknown', artist: '' };
  const { alt } = alternativeCandidates(
    seenOf(marvin, untagged),
    artistRootKey('Marvin Gaye'),
    new Set([artistRootKey('Marvin Gaye')]),
  );
  assert.deepEqual([...alt.keys()], ['u1'], 'a candidate with no artist is never dropped by the guard');
}

// No recency data (a fresh boot, or a queue with nothing played) → byte-for-byte
// the pre-#1251 behaviour: the rejected artist excluded, nothing else.
{
  const { alt, dropped, starved } = alternativeCandidates(seenOf(marvin, sly, beatles), artistRootKey('Marvin Gaye'));
  assert.deepEqual([...alt.keys()].sort(), ['b1', 's1'], 'an empty recency window leaves the old behaviour intact');
  assert.equal(dropped, 0, 'nothing dropped when there is no recency window');
  assert.equal(starved, false, 'a window that never applied is a no-op, not starvation');
}

// Every candidate is the rejected artist → empty, which is what tells the caller
// to escalate to the pool rescue (#1187). The recency window must not change
// that verdict.
{
  const { alt } = alternativeCandidates(
    seenOf(marvin, marvinTammi),
    artistRootKey('Marvin Gaye'),
    new Set([artistRootKey('The Clash')]),
  );
  assert.equal(alt.size, 0, 'a single-artist run still reports no alternatives');
}

assert(ARTIST_VARIETY_WINDOW >= 2, 'the window must span at least the every-other-slot shape it was filed for');

// ── blockedArtists (the guard's pool rescue) sees collaborations ────────────

// The rescue asks the pool for a pick that is NOT the rejected anchor artist. A
// collaboration answering that ask is the repeat it was called to prevent.
const rescuePool = [
  { id: 'p1', title: 'Solo', artist: 'Marvin Gaye' },
  { id: 'p2', title: 'Duet', artist: 'Marvin Gaye & Tammi Terrell' },
  { id: 'p3', title: 'Other', artist: 'The Clash' },
];
assert.deepEqual(
  filterPickerCandidates(rescuePool, { blockedArtists: new Set([artistRootKey('Marvin Gaye')]) }).map((s) => s.id),
  ['p3'],
  'a hard artist block must also block that artist\'s collaborations',
);
// Blocking the collaboration blocks the lead artist as well — the rescue is
// steering around an act, not a string.
assert.deepEqual(
  filterPickerCandidates(rescuePool, { blockedArtists: new Set([artistRootKey('Marvin Gaye & Tammi Terrell')]) }).map((s) => s.id),
  ['p3'],
  'blocking a collaboration blocks the lead artist too',
);
// A band whose name contains a join is blocked whole and blocks nothing else.
assert.deepEqual(
  filterPickerCandidates(
    [{ id: 'q1', title: 'Fun', artist: 'Sly & the Family Stone' }, { id: 'q2', title: 'Riot', artist: 'Sly & Robbie' }],
    { blockedArtists: new Set([artistRootKey('Sly & the Family Stone')]) },
  ).map((s) => s.id),
  ['q2'],
  'a band name containing "&" must not block unrelated acts sharing its first word',
);

// ── queue.neighbourArtistRoots: the recency window's data source ────────────

// Reads queue.upcoming + queue.current + queue._recentPlays only — no disk or
// Liquidsoap side effects (same setup as scripts/recent-plays.test.ts).
function setPlays(plays: any[]) {
  (queue as any).current = null;
  (queue as any).upcoming = [];
  (queue as any)._recentPlays = plays;
}

setPlays([
  { id: 'A', title: 'Song One', artist: 'Marvin Gaye & Tammi Terrell', endedAt: '2026-07-30T18:00:00.000Z' },
  // The events-backfill duplicate of the same play — must not burn a slot.
  { id: null, title: 'Song One', artist: 'Marvin Gaye & Tammi Terrell', endedAt: '2026-07-30T17:58:00.000Z' },
  { id: 'B', title: 'Song Two', artist: 'The Clash', endedAt: '2026-07-30T17:55:00.000Z' },
  { id: 'C', title: 'Song Three', artist: 'Sly & the Family Stone', endedAt: '2026-07-30T17:50:00.000Z' },
]);

const twoBack = queue.neighbourArtistRoots(2);
assert(twoBack.has('marvin gaye'), 'a played collaboration registers under its lead artist');
assert(twoBack.has(artistRootKey('The Clash')), 'the duplicate sidecar row must not consume a slot');
assert(!twoBack.has('sly & the family stone'), 'n=2 must not reach the third distinct play');

assert.equal(queue.neighbourArtistRoots(0).size, 0, 'n=0 → empty window');
assert.equal(queue.neighbourArtistRoots(-3).size, 0, 'negative n → empty window');

(queue as any).current = { track: { id: 'CUR', title: 'On Air', artist: 'The Beatles' } };
const withCurrent = queue.neighbourArtistRoots(1);
assert(withCurrent.has(artistRootKey('The Beatles')), 'the on-air artist is always in the window');
assert(withCurrent.has('marvin gaye'), 'the N sidecar artists ride alongside current');

// Queued-but-unaired tracks are neighbours too: with a pair-aware drain (or a
// request stacked ahead) the pick is not adjacent to the track on air, and a
// queued track has no play row to be found in.
(queue as any).upcoming = [
  { track: { id: 'Q1', title: 'Queued One', artist: 'Curtis Mayfield' } },
  { track: { id: 'Q2', title: 'Queued Two', artist: 'The Isley Brothers' } },
];
const withQueued = queue.neighbourArtistRoots(2);
assert(withQueued.has('curtis mayfield'), 'a queued artist is inside the window');
assert(withQueued.has(artistRootKey('The Isley Brothers')), 'so is the one queued behind it');
assert(withQueued.has(artistRootKey('The Beatles')), 'the queued side does not displace the on-air track');
// A pick appends to the END of the queue, so the window takes the queue's tail.
assert(
  !queue.neighbourArtistRoots(1).has('curtis mayfield'),
  'n=1 reaches only the nearest queued neighbour',
);

// An untagged play contributes nothing rather than an empty-string key that
// would match every untagged candidate.
setPlays([{ id: 'D', title: 'Untitled', artist: '', endedAt: '2026-07-30T18:00:00.000Z' }]);
assert.equal(queue.neighbourArtistRoots(3).size, 0, 'an artist-less play adds no key');

console.log('artist-guard checks passed');
