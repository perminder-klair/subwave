// The pure rules behind track-level Last.fm tags (music/lastfm-tag-policy.ts):
// what a response is worth, what counts as noise, and how a song's tags join its
// artist's. `lastfm_tags` stays the one list every consumer reads, so the merge
// is the whole of what a consumer ever sees of this feature.
//
// Run: npm test -- lastfm-tag-policy

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTopTagsResponse,
  dropNameEchoes,
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

test('the cap holds, and the track tags win all of it but the artist\'s top three', () => {
  const track = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const merged = mergeCrowdTags(track, artist);
  assert.equal(merged.length, 10);
  assert.deepEqual(merged, [...track.slice(0, 7), 'a0', 'a1', 'a2']);
  assert.deepEqual(mergeCrowdTags(track.slice(0, 4), artist), [...track.slice(0, 4), ...artist.slice(0, 6)]);
  assert.deepEqual(mergeCrowdTags(track, ['a0']), [...track.slice(0, 9), 'a0'], 'an artist with fewer keeps what it has');
  assert.deepEqual(mergeCrowdTags(track, []), track.slice(0, 10));
  assert.deepEqual(mergeCrowdTags(track, artist, 2), ['a0', 'a1'], 'a cap under three is all reserve');
});

test('a top artist tag the song shares keeps its place and costs the song no room', () => {
  const track = ['a1', ...Array.from({ length: 11 }, (_, i) => `t${i}`)];
  assert.deepEqual(
    mergeCrowdTags(track, ['a0', 'a1', 'a2', 'a3']),
    ['a1', ...track.slice(1, 8), 'a0', 'a2'],
  );
});

// A never-play `tag` rule reads this list through show-filter.trackAllTags, and
// the blocklist is absolute: the act's own tag must not fall off a busy song.
test('a song with ten tags of its own still answers to its artist\'s top tags', () => {
  const own = Array.from({ length: 10 }, (_, i) => `own ${i}`);
  const artistTags = ['country', 'folk', 'americana', 'singer-songwriter'];
  const track = { id: 't', genres: ['Rock'], moods: [], lastfmTags: mergeCrowdTags(own, artistTags) };
  const rule = (value: string) => compileRules([{
    id: 'r', field: 'tag', values: [value], showIds: [], addedAt: '2026-01-01',
  } as unknown as BlockRule])[0];
  assert.deepEqual(track.lastfmTags.slice(-3), ['country', 'folk', 'americana']);
  assert.ok(trackAllTags(track).includes('country'));
  assert.equal(ruleMatches(rule('country'), track, null), true);
  assert.equal(ruleMatches(rule('americana'), track, null), true);
  assert.equal(ruleMatches(rule('own 6'), track, null), true);
  assert.equal(ruleMatches(rule('own 7'), track, null), false, 'the room came from the end of the song\'s own tags');
});

// What keeps a miss from dirtying a row: the list comes out as it went in.
test('with no track tags the artist list passes through unchanged', () => {
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  assert.deepEqual(mergeCrowdTags([], artist), artist);
  assert.deepEqual(mergeCrowdTags([], []), []);
});
