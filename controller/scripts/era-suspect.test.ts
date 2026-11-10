// Unit pins for the anthology detector behind #1418 — the judgement that
// replaces "Navidrome set isCompilation" as the trigger for an original-year
// lookup and for treating an album's year as untrustworthy.
//
// The tuning here is PRECISION-first and the tests are written to hold that
// line: the negative cases (an ordinary album that must NOT be flagged) are the
// ones that matter, because a false positive costs a MusicBrainz request and
// can drop a perfectly good album out of era-bounded shows.
//
// Every artist-count case below is taken from a REAL catalogue (9,216 tracks,
// 3,989 albums) that the first cut of this detector got wrong — it flagged 24%
// of that library. The three fixtures named after real albums are the ones that
// drove each threshold, so a future loosening has to argue with them.
//
// Run: npm test -- era-suspect

import test from 'node:test';
import assert from 'node:assert/strict';
import { albumEraSuspect, titleYearRange } from '../src/music/era-suspect.js';

// ── titleYearRange ───────────────────────────────────────────────────────────

test('reads a full four-digit range', () => {
  assert.deepEqual(titleYearRange('The Atco/Atlantic Singles 1968-1974'), { from: 1968, to: 1974 });
});

test('expands a two-digit close against the open year', () => {
  assert.deepEqual(
    titleYearRange('Complete Stax & Volt Singles + Rarities 1964–65'),
    { from: 1964, to: 1965 },
  );
});

test('rolls a two-digit close over a century boundary', () => {
  assert.deepEqual(titleYearRange('Sessions 1998-02'), { from: 1998, to: 2002 });
});

test('accepts en dash and em dash as well as hyphen', () => {
  assert.deepEqual(titleYearRange('Anthology 1970—1979'), { from: 1970, to: 1979 });
});

test('a BARE year is not a range', () => {
  // "Woodstock 1969" and "Top 40 Hits of 2015" must not read as anthologies —
  // a lone 4-digit number in a title is more often a name than a date.
  assert.equal(titleYearRange('Woodstock 1969'), null);
  assert.equal(titleYearRange('Top 40 Hits of 2015'), null);
});

test('rejects a backwards or implausible range', () => {
  assert.equal(titleYearRange('Nonsense 1974-1968'), null);
  assert.equal(titleYearRange('Catalogue 0001-0002'), null);
});

test('does not match inside a longer digit run', () => {
  assert.equal(titleYearRange('Serial 12345-6789'), null);
});

// ── albumEraSuspect: the markers ─────────────────────────────────────────────

test("Navidrome's compilation flag still fires first", () => {
  assert.deepEqual(
    albumEraSuspect({ isCompilation: true, albumArtist: 'Chic', title: '100 Hits', year: 2013 }),
    { suspect: true, reason: 'compilation-flag' },
  );
});

test('a Various Artists album artist is enough on its own', () => {
  for (const name of ['Various Artists', 'various', 'VA', 'Various  Artists']) {
    assert.equal(albumEraSuspect({ albumArtist: name, year: 2012 }).suspect, true, name);
  }
});

// n tracks, each by a different lead — the shape of a sampler.
const manyLeads = (n: number) => Array.from({ length: n }, (_, i) => `Artist ${i}`);
// n tracks fronted by one artist, with a different guest on each — the shape of
// an ordinary features-heavy record, and the case the naive rule got wrong.
const oneLeadWithGuests = (n: number) =>
  Array.from({ length: n }, (_, i) => `Main Artist feat. Guest ${i}`);

test('a sampler with no artist at the front of it is an anthology', () => {
  assert.deepEqual(
    albumEraSuspect({ albumArtist: 'Stax', title: 'Label Sampler', year: 2012, trackArtists: manyLeads(12) }),
    { suspect: true, reason: 'many-artists' },
  );
});

test('a features-heavy album by ONE artist is not', () => {
  // Measured failure. "Slauson Boy 2" counted 13 distinct artist STRINGS and
  // "Mr. Morale & The Big Steppers" 9, because the raw `artist` field carries
  // the features — both are single-artist records. Counting the LEAD is what
  // fixes it, and it is the biggest correctness win in this module.
  assert.equal(albumEraSuspect({ albumArtist: 'Main Artist', year: 2022, trackArtists: oneLeadWithGuests(18) }).suspect, false);
});

test('a guest-heavy record still reads as its lead even at album length', () => {
  const mostlyOne = [...Array(14).fill('Kendrick Lamar'), 'Kendrick Lamar feat. Baby Keem', 'Sampha', 'Ghostface Killah'];
  assert.equal(albumEraSuspect({ albumArtist: 'Kendrick Lamar', year: 2022, trackArtists: mostlyOne }).suspect, false);
});

test('a SHORT multi-artist release is not an anthology', () => {
  // The other measured failure: on a 4-track EP with four collaborators no one
  // holds a third of the record, so any ratio test fires on arithmetic alone.
  // The real catalogue is full of these ("Nasha - Single", "Say Less - EP").
  assert.equal(albumEraSuspect({ albumArtist: 'Someone', year: 2024, trackArtists: manyLeads(4) }).suspect, false);
  assert.equal(albumEraSuspect({ albumArtist: 'Someone', year: 2024, trackArtists: manyLeads(7) }).suspect, false);
  assert.equal(albumEraSuspect({ albumArtist: 'Someone', year: 2024, trackArtists: manyLeads(8) }).suspect, true);
});

test('FOUR leads is below the floor, five clears it', () => {
  assert.equal(albumEraSuspect({ year: 2012, trackArtists: manyLeads(4).concat(manyLeads(4)) }).suspect, false);
  assert.equal(albumEraSuspect({ year: 2012, trackArtists: manyLeads(5).concat(manyLeads(5)) }).suspect, true);
});

test('a title that SAYS it is a collection fires on its own', () => {
  // Catches the single-artist "Best of", which no artist-count signal can see.
  for (const t of ['The Collection', 'Kaun Nachdi (The Ultimate Collection)',
                   'Best of Diljit Dosanjh', 'Free Fire (DJ Mix)', 'Rarities', 'Greatest Hits']) {
    assert.equal(albumEraSuspect({ albumArtist: 'One Artist', title: t, year: 2020, trackArtists: ['One Artist'] }).suspect, true, t);
  }
});

test('loose collection-ish words do NOT fire', () => {
  // "Vol." and a bare "Collection" appear in ordinary album titles; the word
  // list is short on purpose.
  for (const t of ['Mxrci Season, Vol. 1', 'Hard Drive, Vol. 2', 'Spring Collection Blues', 'The Best Day']) {
    assert.equal(albumEraSuspect({ albumArtist: 'One Artist', title: t, year: 2020, trackArtists: ['One Artist'] }).suspect, false, t);
  }
});

test('the reported single-artist anthology is caught by its title range', () => {
  // Allen Toussaint, The Atco/Atlantic Singles 1968-1974 (2015 reissue) —
  // ONE credited artist throughout, so every artist-count signal misses it.
  assert.deepEqual(
    albumEraSuspect({
      isCompilation: false,
      albumArtist: 'Allen Toussaint',
      title: 'The Atco/Atlantic Singles 1968-1974',
      year: 2015,
      trackArtists: Array(14).fill('Allen Toussaint'),
    }),
    { suspect: true, reason: 'title-year-range' },
  );
});

test('the other reported anthology is caught too', () => {
  assert.equal(
    albumEraSuspect({
      isCompilation: false,
      albumArtist: 'Various Artists',
      title: 'After Laughter Comes Tears: Complete Stax & Volt Singles + Rarities 1964–65',
      year: 2012,
      trackArtists: manyLeads(8),
    }).suspect,
    true,
  );
});

// ── albumEraSuspect: what must stay clear ────────────────────────────────────

test('an ordinary single-artist album is not suspect', () => {
  assert.deepEqual(
    albumEraSuspect({
      isCompilation: false, albumArtist: 'Radiohead', title: 'In Rainbows',
      year: 2007, trackArtists: Array(10).fill('Radiohead'),
    }),
    { suspect: false, reason: null },
  );
});

test('a range that CLOSES in the album year is describing when it was made', () => {
  // "Sessions 2014-2015" on a 2015 album is not an anthology.
  assert.equal(
    albumEraSuspect({ albumArtist: 'A Band', title: 'Sessions 2014-2015', year: 2015, trackArtists: ['A Band'] }).suspect,
    false,
  );
});

test('a title range with no album year to compare against stays clear', () => {
  // Untagged year — we cannot tell "collects older material" from "made then",
  // and guessing is the expensive direction.
  assert.equal(
    albumEraSuspect({ albumArtist: 'A Band', title: 'Recordings 1968-1974', year: null, trackArtists: ['A Band'] }).suspect,
    false,
  );
});

test('an explicit isCompilation:false does not override a real marker', () => {
  // The whole defect: Navidrome says false on exactly these records, so a
  // false must never be read as "definitely not an anthology".
  assert.equal(
    albumEraSuspect({ isCompilation: false, albumArtist: 'Various Artists', year: 2012 }).suspect,
    true,
  );
});

test('empty / unknown facts are not suspect', () => {
  assert.equal(albumEraSuspect({}).suspect, false);
  assert.equal(albumEraSuspect({ isCompilation: null, albumArtist: null, title: null, year: null }).suspect, false);
});
