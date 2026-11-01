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

test('the cap holds, and the track tags win it', () => {
  const track = Array.from({ length: 8 }, (_, i) => `t${i}`);
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const merged = mergeCrowdTags(track, artist);
  assert.equal(merged.length, 10);
  assert.deepEqual(merged.slice(0, 8), track);
  assert.deepEqual(merged.slice(8), ['a0', 'a1']);
  assert.deepEqual(mergeCrowdTags(artist, track, 3), ['a0', 'a1', 'a2']);
});

// What keeps a miss from dirtying a row: the list comes out as it went in.
test('with no track tags the artist list passes through unchanged', () => {
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  assert.deepEqual(mergeCrowdTags([], artist), artist);
  assert.deepEqual(mergeCrowdTags([], []), []);
});
