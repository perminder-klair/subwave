// Voice clips are trimmed toward one level at the handoff to the mixer.
//
// Run: npx tsx scripts/clip-level.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  VOICE_TARGET_LUFS, VOICE_TRIM_MAX_DB,
  levelTrimDb, levelledGainDb, measureClipLevel, parseIntegratedLufs, stampedGainDb, trimDbFor,
} from '../src/audio/clip-level.js';

const SUMMARY = `[Parsed_ebur128_0 @ 0x55] t: 2.9  M: -24.1 S:-120.7  I: -30.0 LUFS  LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -25.1 LUFS
    Threshold: -35.4 LUFS

  Loudness range:
    LRA:         2.1 LU
`;

test('reads the summary figure, not a running one', () => {
  assert.equal(parseIntegratedLufs(SUMMARY), -25.1);
  assert.equal(parseIntegratedLufs('ffmpeg: not a summary'), null);
  assert.equal(parseIntegratedLufs(SUMMARY.replace('Summary:', 'Totals:')), null, 'a running I: line is not the result');
  assert.equal(parseIntegratedLufs(SUMMARY.replace('-25.1', '-70.0')), null, 'silence is not a level');
});

test('a quiet take is lifted and a hot one pulled back, both within the cap', () => {
  assert.equal(trimDbFor(-25.1), 7.1);
  assert.equal(trimDbFor(-13.1), -4.9);
  assert.equal(trimDbFor(VOICE_TARGET_LUFS), 0);
  assert.equal(trimDbFor(-45), VOICE_TRIM_MAX_DB);
  assert.equal(trimDbFor(0), -VOICE_TRIM_MAX_DB);
  assert.equal(trimDbFor(null), 0, 'an unmeasured clip airs as it always did');
});

test('an unreadable clip is unmeasured, never an error', async () => {
  assert.equal(await measureClipLevel('/nonexistent/clip.mp3'), null);
  assert.equal(levelTrimDb('/nonexistent/clip.mp3'), 0);
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('two takes of one voice 9 dB apart leave for the mixer at the same level', { skip: ffmpeg ? false : 'ffmpeg not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'subwave-clip-level-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (name: string, volumeDb: number) => {
    const path = join(dir, name);
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
      '-af', `volume=${volumeDb}dB`, '-ar', '44100', '-ac', '1', '-y', path]);
    assert.equal(made.status, 0, String(made.stderr));
    return path;
  };
  // lavfi's sine sits near -22 LUFS: these land about where a quiet and a normal take do.
  const quiet = make('quiet.mp3', -5);
  const loud = make('loud.wav', 4);
  const [a, b] = [await measureClipLevel(quiet), await measureClipLevel(loud)];
  assert.ok(a != null && b != null);
  assert.ok(Math.abs((b - a) - 9) < 1, `measured ${a} and ${b}`);
  assert.ok(Math.abs((a + levelTrimDb(quiet)) - (b + levelTrimDb(loud))) < 0.2, 'the trims did not meet');
  assert.ok(Math.abs(a + levelTrimDb(quiet) - VOICE_TARGET_LUFS) < 0.2);
  // The operator's gain rides on top of the trim, and an unmeasured clip keeps it alone.
  assert.equal(levelledGainDb(quiet, 3), stampedGainDb(3, levelTrimDb(quiet)));
  assert.ok(levelledGainDb(quiet, 3) > 3);
  assert.equal(levelledGainDb(quiet, 12), 12, 'a voice at the top of the dial is not pushed past it');
  assert.equal(levelledGainDb('/never/measured.mp3', 3), 3);
});

test('the stamped gain never leaves the operator\'s own range', () => {
  assert.equal(stampedGainDb(3, 4.2), 7.2);
  assert.equal(stampedGainDb(12, 7), 12);
  assert.equal(stampedGainDb(-12, -7), -12);
  assert.equal(stampedGainDb(12, -7), 5, 'a cut still comes off a high gain');
  assert.equal(stampedGainDb(0, 0), 0);
});
