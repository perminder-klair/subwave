// LRC text → structured lyrics (music/lrc.ts), the one parse of what LRCLIB
// serves. Pure.
//
// Run: `npm test -- lrc`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, plainLyrics } from '../src/music/lrc.js';

test('a stamped line is timed at its stamp, whatever the fraction precision', () => {
  const lyrics = parseLrc('[00:12.34]hundredths\n[00:13.5]tenths\n[01:02.345]millis\n[02:03]whole');
  assert.deepEqual(lyrics, {
    synced: true,
    lines: [
      { startMs: 12_340, text: 'hundredths' },
      { startMs: 13_500, text: 'tenths' },
      { startMs: 62_345, text: 'millis' },
      { startMs: 123_000, text: 'whole' },
    ],
  });
});

test('a line stamped several times repeats at each, in time order', () => {
  const lyrics = parseLrc('[00:10.00][00:40.00]chorus\n[00:20.00]verse');
  assert.deepEqual(lyrics?.lines, [
    { startMs: 10_000, text: 'chorus' },
    { startMs: 20_000, text: 'verse' },
    { startMs: 40_000, text: 'chorus' },
  ]);
});

test('metadata is dropped and the offset tag shifts every line, positive meaning sooner', () => {
  const lyrics = parseLrc('[ar:Artist]\n[ti:Title]\n[length: 03:20]\n[offset:+500]\n[00:01.00]early\n[00:10.00]line');
  assert.deepEqual(lyrics?.lines, [
    { startMs: 500, text: 'early' },
    { startMs: 9_500, text: 'line' },
  ]);
  assert.deepEqual(parseLrc('[offset:-250]\n[00:01.00]late')?.lines, [{ startMs: 1_250, text: 'late' }]);
  assert.deepEqual(parseLrc('[offset:+5000]\n[00:01.00]clamped')?.lines, [{ startMs: 0, text: 'clamped' }]);
});

test('word-level stamps are stripped to the plain line', () => {
  assert.deepEqual(
    parseLrc('[00:05.00]<00:05.00>every <00:05.40>word <00:05.90>timed')?.lines,
    [{ startMs: 5_000, text: 'every word timed' }],
  );
});

test('an empty stamped line is kept as where the singing stops', () => {
  assert.deepEqual(parseLrc('[00:05.00]sung\n[00:09.00]')?.lines, [
    { startMs: 5_000, text: 'sung' },
    { startMs: 9_000, text: '' },
  ]);
});

test('text with no stamped line is not synced lyrics', () => {
  for (const text of ['', '   ', 'just words\nno stamps', '[ar:Only metadata]', null, undefined, 42]) {
    assert.equal(parseLrc(text), null, `${JSON.stringify(text)} has no timed line`);
  }
});

test('plain text becomes untimed lines, blank lines dropped', () => {
  const lyrics = plainLyrics('first line\n\n  second line  \r\n');
  assert.equal(lyrics?.synced, false);
  assert.deepEqual(lyrics?.lines.map((l) => l.text), ['first line', 'second line']);
  assert.ok(lyrics?.lines.every((l) => Number.isNaN(l.startMs)), 'untimed, as the music server marks them');
  assert.equal(plainLyrics('  \n '), null);
  assert.equal(plainLyrics(null), null);
});
