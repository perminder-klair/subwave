// Unit pins for the original-year resolution behind issue #842 — the pure
// candidate filtering in music/musicbrainz.ts (earliest first-release-date
// across recordings that genuinely match) and the lookup-scope predicate
// shared by phase-0 enrichment and the retag route. No network: recordings are
// literal fixtures shaped like MB search results.
//
// Run: npm test -- original-year

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  earliestOriginalYear,
  needsOriginalYearLookup,
  stripTitleNoise,
  primaryArtist,
  type MbRecording,
} from '../src/music/musicbrainz.js';

const rec = (over: Partial<MbRecording>): MbRecording => ({
  score: 100,
  title: 'Dancing Queen',
  'artist-credit': [{ name: 'ABBA' }],
  ...over,
});

test('takes the EARLIEST plausible year across matching recordings', () => {
  const recs = [
    rec({ 'first-release-date': '2011-04-04' }), // remaster/comp appearance
    rec({ 'first-release-date': '1976-08-15' }), // the original
    rec({ 'first-release-date': '1997' }),
    rec({}),                                     // no date at all
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
test('low-score and off-title/off-artist candidates are ignored', () => {
  const recs = [
    rec({ score: 60, 'first-release-date': '1950' }),                      // weak match
    rec({ title: 'Completely Different Song', 'first-release-date': '1960' }),
    rec({ 'artist-credit': [{ name: 'Some Cover Band' }], 'first-release-date': '1965' }),
    rec({ 'first-release-date': '1976' }),
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
test('normalised title matching survives remaster suffixes and punctuation', () => {
  const recs = [rec({ title: 'Dancing Queen (Remastered)', 'first-release-date': '1976' })];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
test('implausible years (pre-1900, far-future, junk) never resolve', () => {
  const recs = [
    rec({ 'first-release-date': '1899' }),
    rec({ 'first-release-date': '3000' }),
    rec({ 'first-release-date': 'unknown' }),
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), null);
});
test('trusted (MBID) lookups skip the score/title/artist gate but keep the year sanity window', () => {
  const recs = [rec({ score: 0, title: 'Totally Renamed', 'first-release-date': '1976' })];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA', trusted: true }), 1976);
  assert.equal(earliestOriginalYear([rec({ score: 0, 'first-release-date': '1850' })], { title: 'x', artist: 'y', trusted: true }), null);
});
test('empty / no-match input resolves null (caller records a checked miss)', () => {
  assert.equal(earliestOriginalYear([], { title: 'Dancing Queen', artist: 'ABBA' }), null);
});
test('maxYear (the file year) caps candidates — a later mix release cannot win', () => {
  // Real case: "BREAK MY SOUL" (2022) resolved to 2025 via a 2025 DJ-mix
  // recording before the cap existed.
  const recs = [
    rec({ title: 'BREAK MY SOUL', 'first-release-date': '2025-01-10' }),
    rec({ title: 'BREAK MY SOUL', 'first-release-date': '2022-06-20' }),
  ];
  assert.equal(
    earliestOriginalYear(recs, { title: 'BREAK MY SOUL', artist: 'ABBA', maxYear: 2022 }),
    2022,
  );
  assert.equal(
    earliestOriginalYear([recs[0]], { title: 'BREAK MY SOUL', artist: 'ABBA', maxYear: 2022 }),
    null,
  );
});

test('stripTitleNoise removes stacked trailing (…)/[…] groups, never to empty', () => {
  assert.equal(stripTitleNoise('Super Gremlin (Mixed)'), 'Super Gremlin');
  assert.equal(stripTitleNoise('I Like You (A Happier Song) [feat. Doja Cat] [Mixed]'), 'I Like You');
  assert.equal(stripTitleNoise('Big Energy (feat. DJ Khaled) [Remix] [Mixed]'), 'Big Energy');
  assert.equal(stripTitleNoise('Plain Title'), 'Plain Title');
  assert.equal(stripTitleNoise('(Everything I Do) I Do It for You'), '(Everything I Do) I Do It for You');
  assert.equal(stripTitleNoise('(Untitled)'), '(Untitled)'); // never strip to nothing
});
test('primaryArtist takes the first credit before feat./ft./&/,/x', () => {
  assert.equal(primaryArtist('DJ Khaled feat. Future & Lil Baby'), 'DJ Khaled');
  assert.equal(primaryArtist('Future & Gunna'), 'Future');
  assert.equal(primaryArtist('Latto & Mariah Carey'), 'Latto');
  assert.equal(primaryArtist('KAROL G, Becky G'), 'KAROL G');
  assert.equal(primaryArtist('Taylor Swift'), 'Taylor Swift');
});

// The gate reads `yearUntrusted` — the composed flag (Navidrome's compilation
// flag OR the derived anthology verdict), not the raw flag (#1418). Composition
// happens once, in the library-db row mappers.
test('only era-untrusted tracks without a resolved year qualify', () => {
  assert.equal(needsOriginalYearLookup({ yearUntrusted: true, originalYear: null, originalYearCheckedAt: null }), true);
  assert.equal(needsOriginalYearLookup({ yearUntrusted: false, originalYear: null, originalYearCheckedAt: null }), false);
  assert.equal(needsOriginalYearLookup({ yearUntrusted: null, originalYear: null, originalYearCheckedAt: null }), false);
  assert.equal(needsOriginalYearLookup({ yearUntrusted: true, originalYear: 1976, originalYearCheckedAt: '2026-01-01' }), false);
});
test('the RAW compilation flag is not read here', () => {
  // Deliberate: the flag is false on exactly the reissue anthologies this gate
  // exists for, so a call site that passed it instead of the composed value
  // would silently reopen the #1418 gap. Better to answer "no" than to accept
  // the field that caused the bug.
  assert.equal(needsOriginalYearLookup({ isCompilation: true, originalYear: null } as never), false);
});
test('a manual answer is never re-asked, even on re-enrich', () => {
  // MusicBrainz has nothing to add to an operator reading the sleeve. Belt and
  // braces beside the SQL guard in setOriginalYear.
  const manual = { yearUntrusted: true, originalYear: null, originalYearSource: 'manual', originalYearCheckedAt: null };
  assert.equal(needsOriginalYearLookup(manual), false);
  assert.equal(needsOriginalYearLookup(manual, true), false);
});
test('a checked-but-missed track is skipped unless re-enriching', () => {
  const missed = { yearUntrusted: true, originalYear: null, originalYearCheckedAt: '2026-01-01T00:00:00Z' };
  assert.equal(needsOriginalYearLookup(missed), false);
  assert.equal(needsOriginalYearLookup(missed, true), true);
});
