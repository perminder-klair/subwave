// Regression test for the ident-vs-link boundary guard (boundaryCarriesTrackVoice).
// Run: `npm test -- ident-link-collision`.
//
// Issue #1258. Two talkers reach the same track boundary from different clocks:
//
//   - the station ident is WALL-CLOCK scheduled (cron at :15/:30/:45), then
//     deferred by announceAtNextTrack to the next track start;
//   - a link/intro is TRACK-TIED — it airs when its own song starts.
//
// So the ident lands exactly where a link already lives. They're different
// kinds, so no per-kind cooldown sees the pair, and airVoice's serialiser only
// stops them OVERLAPPING — back to back with no music between is what it
// produces. Reported as 16s and 25s gaps, i.e. one segment's own length.
//
// The guard answers one question — "does this boundary already speak?" — and
// airPendingVoice holds the ident for the next boundary when it does. These
// asserts pin both observed orderings and, crucially, that the ident is NOT
// suppressed at a boundary that turns out to be silent (idents must still air).
//

import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryCarriesTrackVoice } from '../src/broadcast/queue.js';

const PREV = { id: 'song-P', title: 'Previous Pulsar', artist: 'Artist P' };
const OTHER = { id: 'song-O', title: 'Other Orbit', artist: 'Artist O' };

test('untracked auto-playlist track (no queue item) → boundary is silent, ident airs', () => {
  assert.equal(boundaryCarriesTrackVoice(null, PREV), false);
  assert.equal(boundaryCarriesTrackVoice(undefined, PREV), false);
});

test('tracked item with no intro at all → boundary is silent, ident airs', () => {
  assert.equal(boundaryCarriesTrackVoice({}, PREV), false);
  assert.equal(boundaryCarriesTrackVoice({ introScript: null, introWav: null }, PREV), false);
  assert.equal(boundaryCarriesTrackVoice({ introScript: '' }, PREV), false);
});

// Example 1 in the report: 09:34:06 ident, 09:34:22 link — the link was
// waiting on the very track the ident's boundary belongs to.
test('item carrying an unaired link → boundary speaks, ident holds', () => {
  assert.equal(
    boundaryCarriesTrackVoice({ introScript: "here's something new", introKind: 'link' }, PREV),
    true);
});

test('rendered WAV but no script left on the item → still counts as speaking', () => {
  // No wavExists probe supplied — the file is assumed present.
  assert.equal(boundaryCarriesTrackVoice({ introWav: '/var/sub-wave/voices/link.wav' }, PREV), true);
});

// airIntro's own drop paths, injected via opts — each leaves the boundary
// silent, so the ident may take it after all.
test('station voice off — airIntro drops the link, boundary silent → ident airs', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "here's something new", introKind: 'link' },
      PREV, { voiceAllowed: false }),
    false);
});

test('WAV reaped and no script to re-render from → boundary silent, ident airs', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introWav: '/var/sub-wave/voices/gone.wav' },
      PREV, { wavExists: () => false }),
    false);
});

test('WAV reaped but the script survives (airIntro re-renders) → still speaks', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "here's something new", introWav: '/var/sub-wave/voices/gone.wav' },
      PREV, { wavExists: () => false }),
    true);
});

// Example 2 in the report: 09:46:18 link, 09:46:43 ident — reversed, because
// onBedStarted aired the link over the bed seconds before the song started.
// The item is still in `upcoming` with introAired already set; the listener
// has just heard it, so the ident must still stand down.
test('BED case — link already aired over the bed, item still upcoming → ident holds', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: 'up next, something warm', introKind: 'link', introAired: true },
      PREV),
    true);
});

test('listener request intro (dj-speak, never back-announces) → ident holds', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: 'this one goes out to Sam', introKind: 'dj-speak', linkPrev: null },
      PREV),
    true);
});

// airIntro drops a link that NAMES a predecessor which isn't what actually
// played (shouldDropStaleLink). That boundary ends up silent, so suppressing
// the ident there would trade one voice for none.
test('link airIntro will drop as a stale back-announce → boundary is silent, ident airs', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: 'that was Previous Pulsar, and now this', introKind: 'link', linkPrev: PREV },
      OTHER),
    false);
});

test('forward-looking link after a queue-jumping request → still speaks, ident holds', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "keeping it moving, here's the next one", introKind: 'link', linkPrev: PREV },
      OTHER),
    true);
});

test('back-announce naming the RIGHT predecessor → speaks, ident holds', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: 'that was Previous Pulsar', introKind: 'link', linkPrev: PREV },
      PREV),
    true);
});
