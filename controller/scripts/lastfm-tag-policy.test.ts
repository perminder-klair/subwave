// The pure rules behind track-level Last.fm tags (music/lastfm-tag-policy.ts):
// what a response is worth, what counts as noise, and how a song's tags join its
// artist's. `lastfm_tags` stays the one list every consumer reads, so the merge
// is the whole of what a consumer ever sees of this feature.
//
// Run: npm test -- lastfm-tag-policy

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TRACK_TAGS,
  classifyTopTagsResponse,
  dropNameEchoes,
  keepStoredTags,
  listAfterArtistLookup,
  mergeCrowdTags,
} from '../src/music/lastfm-tag-policy.js';
import { compileRules, ruleMatches, type BlockRule } from '../src/music/blocklist-rules.js';
import { trackAllTags } from '../src/music/show-filter.js';

const toptags = { toptags: { tag: [{ name: 'dream pop', count: 100 }] } };

test('a tag list, or an answer with no tags on it, is an answer', () => {
  assert.equal(classifyTopTagsResponse(200, toptags), 'answer');
  assert.equal(classifyTopTagsResponse(200, { toptags: { '#text': ' ', '@attr': { artist: 'x' } } }), 'answer');
  assert.equal(classifyTopTagsResponse(200, { toptags: {} }), 'answer');
});

test('an unknown track is a miss, under a 200 or a 4xx', () => {
  assert.equal(classifyTopTagsResponse(200, { error: 6, message: 'Track not found' }), 'miss');
  assert.equal(classifyTopTagsResponse(400, { error: 6, message: 'Track not found' }), 'miss');
  assert.equal(classifyTopTagsResponse(404, { error: 7, message: 'Invalid resource specified' }), 'miss');
});

test('429 and error 29 are rate limiting, whatever the other half says', () => {
  assert.equal(classifyTopTagsResponse(429, null), 'rate-limited');
  assert.equal(classifyTopTagsResponse(200, { error: 29, message: 'Rate limit exceeded' }), 'rate-limited');
  assert.equal(classifyTopTagsResponse(403, { error: 29 }), 'rate-limited');
});

// Each of these would mark a track done on an answer Last.fm never gave. The
// bad-key cases matter most: stamped, one typo finishes a whole library.
test('everything else is transient, so it can never stamp a row', () => {
  for (const [status, body] of [
    [500, null], [502, null], [503, { error: 11, message: 'Service offline' }],
    [200, { error: 8, message: 'Operation failed' }],
    [200, { error: 11 }], [200, { error: 16 }],
    [403, { error: 10, message: 'Invalid API key' }], [403, { error: 26, message: 'Suspended' }],
    [200, { error: 4 }],
    [404, null], [200, null], [200, {}], [200, 'nonsense'], [200, { toptags: 'nonsense' }],
    [204, null],
  ] as Array<[number, unknown]>) {
    assert.equal(classifyTopTagsResponse(status, body), 'transient', JSON.stringify([status, body]));
  }
});

test('a tag that only repeats the artist or the title goes, through the shared name fold', () => {
  assert.deepEqual(
    dropNameEchoes(['Slowdive', 'alison', 'shoegaze', 'souvlaki'], { artist: 'Slowdive', title: 'Alison' }),
    ['shoegaze', 'souvlaki'],
  );
  // recency.nameKey folds apostrophes and whitespace as well as case.
  assert.deepEqual(
    dropNameEchoes(['guns n’ roses', 'don’t  cry', 'rock'], { artist: "Guns N' Roses", title: "Don't Cry" }),
    ['rock'],
  );
});

test('a tag merely containing a name stays: this is equality, not a junk list', () => {
  assert.deepEqual(
    dropNameEchoes(['slowdive covers', 'seen slowdive live'], { artist: 'Slowdive', title: 'Alison' }),
    ['slowdive covers', 'seen slowdive live'],
  );
});

test('track tags lead, artist tags fill, and a repeat is kept once at its first position', () => {
  assert.deepEqual(
    mergeCrowdTags(['dream pop', 'Shoegaze'], ['shoegaze', 'british', 'DREAM POP', 'indie']),
    ['dream pop', 'Shoegaze', 'british', 'indie'],
  );
});

test('at most five of a song\'s own tags lead, in Last.fm\'s order, and the artist\'s whole list follows', () => {
  const track = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  assert.equal(MAX_TRACK_TAGS, 5);
  const merged = mergeCrowdTags(track, artist);
  assert.equal(merged.length, 15);
  assert.deepEqual(merged, [...track.slice(0, MAX_TRACK_TAGS), ...artist]);
  assert.deepEqual(mergeCrowdTags(track.slice(0, 4), artist), [...track.slice(0, 4), ...artist]);
  assert.deepEqual(mergeCrowdTags(track, ['a0']), [...track.slice(0, MAX_TRACK_TAGS), 'a0'], 'an artist with fewer keeps what it has');
  assert.deepEqual(mergeCrowdTags(track, []), track.slice(0, MAX_TRACK_TAGS));
});

test('a tag the song shares with its artist is kept once, in the song\'s place', () => {
  assert.deepEqual(mergeCrowdTags(['a1', 't0'], ['a0', 'a1', 'a2']), ['a1', 't0', 'a0', 'a2']);
});

// The blocklist is absolute, and a `tag` rule reads this list through
// show-filter.trackAllTags, so these run the rule itself, not the list's length.
const matches = (value: string, lastfmTags: string[]) => ruleMatches(
  compileRules([{ id: 'r', field: 'tag', values: [value], showIds: [], addedAt: '2026-01-01' } as unknown as BlockRule])[0],
  { id: 't', genres: [], moods: [], lastfmTags },
  null,
);

test('a rule on any one of the artist\'s ten tags still matches a song with a full list of its own', () => {
  const own = Array.from({ length: 12 }, (_, i) => `own ${i}`);
  const artistTags = ['country', 'folk', 'americana', 'singer-songwriter', 'acoustic',
    'bluegrass', 'roots', 'alt-country', 'outlaw', 'nashville'];
  const lastfmTags = mergeCrowdTags(own, artistTags);
  assert.ok(trackAllTags({ id: 't', genres: [], moods: [], lastfmTags }).includes('nashville'));
  for (const tag of artistTags) assert.equal(matches(tag, lastfmTags), true, tag);
  assert.equal(matches('own 4', lastfmTags), true);
  assert.equal(matches('own 5', lastfmTags), false, 'past the song\'s five is simply not on the list');
});

// Every artist length against every song length at every overlap, so nothing here
// depends on a generator. The spellings collide on purpose: the merge keeps one of
// each fold, so this also holds it to the fold a rule compares through.
test('a rule can only ever match more with track tags on, never less', () => {
  const pool = ['rock', 'Rock', ' rock ', 'hip  hop', 'hip hop', 'hip-hop', "rock 'n' roll", 'rock ’n’ roll',
    'Café', 'Café', 'trip-hop', 'trip hop', ...Array.from({ length: 24 }, (_, i) => `tag ${i}`)];
  let held = 0;
  for (let artistLength = 0; artistLength <= 10; artistLength += 1) {
    const artistTags = pool.slice(0, artistLength);
    for (let ownLength = 0; ownLength <= 12; ownLength += 1) {
      for (let overlap = 0; overlap < pool.length; overlap += 1) {
        const own = [...pool.slice(overlap), ...pool.slice(0, overlap)].slice(0, ownLength);
        const lastfmTags = mergeCrowdTags(own, artistTags);
        for (const value of pool) {
          if (!matches(value, artistTags)) continue;
          held += 1;
          assert.equal(matches(value, lastfmTags), true, JSON.stringify({ value, artistTags, lastfmTags }));
        }
      }
    }
  }
  assert.ok(held > 10000, `the grid has to exercise the property, held ${held}`);
});

test('a stored list stays behind the answer, once per fold', () => {
  assert.deepEqual(keepStoredTags(['own', 'a0'], ['A0', 'old tail']), ['own', 'a0', 'old tail']);
  assert.deepEqual(keepStoredTags(['a0', 'a1'], ['a0', 'a1']), ['a0', 'a1'], 'nothing moved, so nothing changes');
  assert.deepEqual(keepStoredTags(['own'], []), ['own']);
});

// What keeps a miss from dirtying a row: the list comes out as it went in.
test('with no track tags the artist list passes through unchanged', () => {
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  assert.deepEqual(mergeCrowdTags([], artist), artist);
  assert.deepEqual(mergeCrowdTags([], []), []);
});

// The artist-only lookup can't tell an outage from an act with no tags (#2295).
test('only an artist answer with tags on it replaces a stored list, and replaces it whole', () => {
  assert.deepEqual(listAfterArtistLookup(['rock', 'indie'], ['pop']), ['pop']);
  assert.deepEqual(listAfterArtistLookup(['rock', 'indie'], []), ['rock', 'indie']);
  assert.deepEqual(listAfterArtistLookup(['rock', 'indie'], null), ['rock', 'indie']);
  assert.deepEqual(listAfterArtistLookup(['rock', 'indie'], undefined), ['rock', 'indie']);
  assert.deepEqual(listAfterArtistLookup(null, ['pop']), ['pop']);
  assert.equal(listAfterArtistLookup(null, []), null);
});
