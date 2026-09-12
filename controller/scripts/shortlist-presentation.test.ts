import assert from 'node:assert/strict';
import test from 'node:test';
import { shortlistSourceHint } from '../src/music/shortlist-presentation.js';

test('renders shortlist provenance in listener language, not registry identifiers', () => {
  assert.equal(shortlistSourceHint(['tracksByMood']), 'Surfaced through mood and energy matching.');
  assert.equal(
    shortlistSourceHint(['tracksByMood', 'tracksThatSoundLikeThis']),
    'Surfaced through mood and energy matching and sound-alike exploration.',
  );
  assert.equal(
    shortlistSourceHint(['showPlaylistTracks', 'tracksTowardJourney', 'deepCuts']),
    'Surfaced through the show’s music selection, the station’s sonic journey, and other routes.',
  );
});

test('refuses unknown or absent source names rather than inventing a hint', () => {
  assert.equal(shortlistSourceHint(['unknown']), null);
  assert.equal(shortlistSourceHint(null), null);
});
