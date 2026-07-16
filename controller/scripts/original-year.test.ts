// Unit pins for the original-year resolution behind issue #842 — the pure
// candidate filtering in music/musicbrainz.ts (earliest first-release-date
// across recordings that genuinely match) and the lookup-scope predicate
// shared by phase-0 enrichment and the retag route. No network: recordings are
// literal fixtures shaped like MB search results.
//
// Run: npm test -- original-year

import assert from 'node:assert/strict';
import {
  earliestOriginalYear,
  needsOriginalYearLookup,
  type MbRecording,
} from '../src/music/musicbrainz.js';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

const rec = (over: Partial<MbRecording>): MbRecording => ({
  score: 100,
  title: 'Dancing Queen',
  'artist-credit': [{ name: 'ABBA' }],
  ...over,
});

console.log('earliestOriginalYear (MB candidate filtering):');
await test('takes the EARLIEST plausible year across matching recordings', () => {
  const recs = [
    rec({ 'first-release-date': '2011-04-04' }), // remaster/comp appearance
    rec({ 'first-release-date': '1976-08-15' }), // the original
    rec({ 'first-release-date': '1997' }),
    rec({}),                                     // no date at all
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
await test('low-score and off-title/off-artist candidates are ignored', () => {
  const recs = [
    rec({ score: 60, 'first-release-date': '1950' }),                      // weak match
    rec({ title: 'Completely Different Song', 'first-release-date': '1960' }),
    rec({ 'artist-credit': [{ name: 'Some Cover Band' }], 'first-release-date': '1965' }),
    rec({ 'first-release-date': '1976' }),
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
await test('normalised title matching survives remaster suffixes and punctuation', () => {
  const recs = [rec({ title: 'Dancing Queen (Remastered)', 'first-release-date': '1976' })];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), 1976);
});
await test('implausible years (pre-1900, far-future, junk) never resolve', () => {
  const recs = [
    rec({ 'first-release-date': '1899' }),
    rec({ 'first-release-date': '3000' }),
    rec({ 'first-release-date': 'unknown' }),
  ];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA' }), null);
});
await test('trusted (MBID) lookups skip the score/title/artist gate but keep the year sanity window', () => {
  const recs = [rec({ score: 0, title: 'Totally Renamed', 'first-release-date': '1976' })];
  assert.equal(earliestOriginalYear(recs, { title: 'Dancing Queen', artist: 'ABBA', trusted: true }), 1976);
  assert.equal(earliestOriginalYear([rec({ score: 0, 'first-release-date': '1850' })], { title: 'x', artist: 'y', trusted: true }), null);
});
await test('empty / no-match input resolves null (caller records a checked miss)', () => {
  assert.equal(earliestOriginalYear([], { title: 'Dancing Queen', artist: 'ABBA' }), null);
});

console.log('needsOriginalYearLookup (enrichment scope, shared with retag):');
await test('only compilation tracks without a resolved year qualify', () => {
  assert.equal(needsOriginalYearLookup({ isCompilation: true, originalYear: null, originalYearCheckedAt: null }), true);
  assert.equal(needsOriginalYearLookup({ isCompilation: false, originalYear: null, originalYearCheckedAt: null }), false);
  assert.equal(needsOriginalYearLookup({ isCompilation: null, originalYear: null, originalYearCheckedAt: null }), false);
  assert.equal(needsOriginalYearLookup({ isCompilation: true, originalYear: 1976, originalYearCheckedAt: '2026-01-01' }), false);
});
await test('a checked-but-missed track is skipped unless re-enriching', () => {
  const missed = { isCompilation: true, originalYear: null, originalYearCheckedAt: '2026-01-01T00:00:00Z' };
  assert.equal(needsOriginalYearLookup(missed), false);
  assert.equal(needsOriginalYearLookup(missed, true), true);
});

if (failures) {
  console.error(`\n${failures} original-year test(s) failed.`);
  process.exit(1);
}
console.log('\nall original-year tests passed');
