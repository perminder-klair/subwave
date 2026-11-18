// Unit tests for the musical signal that goes into the embed text (#1246).
// Run: `npm test -- similarity-signal` (folded into `npm test`).
//
// All pure, and it fails SILENTLY in production if it regresses: a dropped
// Sound line just means similarity quietly goes back to ranking artist names,
// and a changed text shape with no version bump means new vectors drift from
// old ones inside the same KNN space. Nothing throws, so the asserts here are
// the only alarm.
//
// The issue's SECOND finding (artistKey ignoring featured credits) is not
// here: #1251 / PR #1261 fixes it with a separate `artistRootKey`, keeping
// artistKey as the identity key that trackKey depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_TEXT_VERSION,
  formatTrackText,
  resolveIndexTextFormat,
  soundDescriptors,
} from '../src/music/embeddings.js';

test('audio moods lead, then tempo, then mode', () => {
  // Stable order matters: the same input must always produce the same vector.
  assert.deepEqual(
    soundDescriptors({ audioMoods: ['dreamy', 'melancholic'], bpm: 92, musicalKey: '8A' }),
    ['dreamy', 'melancholic', 'mid-tempo', 'minor key'],
  );
});

test('tempo bands', () => {
  assert.deepEqual(soundDescriptors({ bpm: 62 }), ['slow tempo']);
  assert.deepEqual(soundDescriptors({ bpm: 92 }), ['mid-tempo']);
  assert.deepEqual(soundDescriptors({ bpm: 124 }), ['upbeat tempo']);
  assert.deepEqual(soundDescriptors({ bpm: 174 }), ['fast tempo']);
});

test('an unknown bpm is never described as slow', () => {
  // ID3 writes bpm 0 for "not set"; treating it as a tempo would cluster every
  // untagged track as "slow".
  assert.deepEqual(soundDescriptors({ bpm: 0 }), []);
  assert.deepEqual(soundDescriptors({ bpm: -1 }), []);
  assert.deepEqual(soundDescriptors({ bpm: null }), []);
  assert.deepEqual(soundDescriptors({ bpm: Number.NaN }), []);
});

test('Camelot codes become a mode, never a raw token', () => {
  // "8A" embeds as an arbitrary token; "minor key" is the musically legible
  // half. The tonic NUMBER is deliberately dropped.
  assert.deepEqual(soundDescriptors({ musicalKey: '8A' }), ['minor key']);
  assert.deepEqual(soundDescriptors({ musicalKey: '11B' }), ['major key']);
  assert.deepEqual(soundDescriptors({ musicalKey: '8a' }), ['minor key']);
  // Anything that isn't a Camelot code contributes nothing rather than noise.
  assert.deepEqual(soundDescriptors({ musicalKey: 'A minor' }), []);
  assert.deepEqual(soundDescriptors({ musicalKey: '' }), []);
  // The wheel is 1–12; out-of-range numbers aren't Camelot codes either.
  assert.deepEqual(soundDescriptors({ musicalKey: '0A' }), []);
  assert.deepEqual(soundDescriptors({ musicalKey: '13B' }), []);
  assert.deepEqual(soundDescriptors({ musicalKey: '12B' }), ['major key']);
  assert.deepEqual(soundDescriptors({ musicalKey: '1A' }), ['minor key']);
});

test('nothing analysed yields no words at all', () => {
  assert.deepEqual(soundDescriptors(null), []);
  assert.deepEqual(soundDescriptors({}), []);
  assert.deepEqual(soundDescriptors({ audioMoods: [] }), []);
});

test('only measured-instrumental speaks; vocal tracks get no word', () => {
  // [] is a MEASUREMENT (Demucs found no vocals); null is its absence. And
  // "vocal" on ~80% of a library would be shared noise, so it stays silent.
  assert.deepEqual(soundDescriptors({ vocalRanges: [] }), ['instrumental']);
  assert.deepEqual(soundDescriptors({ vocalRanges: [{ startMs: 0, endMs: 1000 }] }), ['instrumental']);
  assert.deepEqual(soundDescriptors({ vocalRanges: [{ startMs: 0, endMs: 5000 }] }), []);
  assert.deepEqual(soundDescriptors({ vocalRanges: null }), []);
});

test('full descriptor order is moods, tempo, mode, instrumental', () => {
  assert.deepEqual(
    soundDescriptors({
      audioMoods: ['dreamy'], bpm: 92, musicalKey: '8A', vocalRanges: [],
    }),
    ['dreamy', 'mid-tempo', 'minor key', 'instrumental'],
  );
});

const song = { title: 'Parasite', artist: 'Nick Drake', album: 'Pink Moon', year: 2013, genres: ['Folk'] };

test('un-enriched, un-analysed text is unchanged from v1', () => {
  // The whole install base is embedded at this shape — it must stay
  // byte-identical or every existing vector silently mismatches new ones.
  assert.equal(
    formatTrackText(song),
    'Nick Drake — Parasite · Pink Moon (2013) [Folk]',
  );
  assert.equal(formatTrackText(song, null, null), formatTrackText(song));
  // An acoustics object with nothing IN it must also change nothing — the
  // common case while analysis is still backfilling.
  assert.equal(formatTrackText(song, null, { bpm: null }), formatTrackText(song));
});

test('measured sound is appended as its own line', () => {
  const text = formatTrackText(song, null, { audioMoods: ['wistful'], bpm: 88, musicalKey: '8A' });
  assert.match(text, /\nSound: wistful, mid-tempo, minor key$/);
  // and the head line is untouched
  assert.match(text, /^Nick Drake — Parasite/);
});

test('the Sound line sits after the enrichment lines', () => {
  const text = formatTrackText(
    song,
    { lastfmTags: ['folk', 'acoustic'], lyricExcerpt: 'take a look at you now' },
    { bpm: 88 },
  );
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^Last\.fm:/);
  assert.match(lines[2], /^Lyrics:/);
  assert.match(lines[3], /^Sound:/);
});

test('the formatter is deterministic — same input, same string', () => {
  const a = { audioMoods: ['dreamy', 'warm'], bpm: 92, musicalKey: '8A' };
  assert.equal(formatTrackText(song, null, a), formatTrackText(song, null, { ...a }));
});

test('a resolved era becomes a decade word on its own line, last', () => {
  // eraYear comes from show-filter.resolveEraYear at the call sites — the
  // formatter never reads raw `year` for this (a compilation's year is the
  // compilation's own release date).
  const text = formatTrackText({ ...song, eraYear: 1994 }, null, { bpm: 88 });
  assert.match(text, /\nEra: 1990s$/);
  assert.match(text, /\nSound: mid-tempo\n/);
  // No resolved era (null = unknown) → no line, and junk years stay silent.
  assert.doesNotMatch(formatTrackText(song, null, { bpm: 88 }), /Era:/);
  assert.doesNotMatch(formatTrackText({ ...song, eraYear: 7 }, null, null), /Era:/);
});

test('an empty index adopts the current format', () => {
  // A fresh install uses the current format, so it never shows the advisory.
  assert.equal(resolveIndexTextFormat(null, 0), EMBED_TEXT_VERSION);
  assert.equal(resolveIndexTextFormat(1, 0), EMBED_TEXT_VERSION);
});

test('a populated index keeps its older format — the advisory must persist', () => {
  // A forward run only embeds tracks with no vector, so the index becomes a
  // MIX. Recording the current version would erase the one signal that a
  // re-embed is worth running.
  assert.equal(resolveIndexTextFormat(1, 20_000), 1);
  assert.equal(resolveIndexTextFormat(null, 20_000), 1);
});

test('a reseed adopts the current format — it rebuilt every vector', () => {
  assert.equal(resolveIndexTextFormat(1, 20_000, true), EMBED_TEXT_VERSION);
});

test('a format from the future clamps to this build\'s version', () => {
  // A downgraded controller embeds any NEW vectors at its own (older) shape,
  // so the index becomes a mix whose oldest shape is this build's — record
  // that, and the newer controller sees the mix and re-raises the advisory
  // once it's restored.
  assert.equal(resolveIndexTextFormat(99, 20_000), EMBED_TEXT_VERSION);
});
