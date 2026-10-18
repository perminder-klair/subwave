// Pins the cue-landing prediction (music/cue-landing.ts, #2003): where
// Liquidsoap 2.4.x really starts a track cued in with liq_cue_in.
//
// The expected values are the measured Liquidsoap 2.4.6 landings from
// `scripts/stem-seam-test.sh cuein` (docs/stem-transitions-research.md,
// "Cue-in landing"), restated as packet grids: e.g. a 4096-sample FLAC cued at
// 11.7 s starts on the block at 516096, 126 samples past 515970.
// Run: `tsx scripts/cue-landing.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  CODEC_RULES, CUE_LATE_MAX_SEC, cueLateSec, parseProbeJson, probeCueLanding, probeCueLate, redactSource,
} from '../src/music/cue-landing.js';
import { createTempDir } from './test-utils/temp-dir.js';

const SR = 44100;
const grid = (block: number, fromSample: number, count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({ pts: (Math.floor(fromSample / block) * block + i * block + offset) / SR }));
const samples = (sec: number | null) => (sec == null ? null : Math.round(sec * SR * 1000) / 1000);

test('a 4096-sample FLAC cued at 11.7 s lands 126 samples late (the reported seam)', () => {
  assert.equal(samples(cueLateSec(grid(4096, 500000, 8), 11.7, CODEC_RULES.flac)), 126);
});

test('a cue exactly on a block boundary lands on it', () => {
  // 40.96 s = 1806336 samples = 441 × 4096.
  assert.equal(samples(cueLateSec(grid(4096, 1800000, 8), 40.96, CODEC_RULES.flac)), 0);
});

test('a cue one sample past a boundary waits for the next block', () => {
  const cue = (1806336 + 1) / SR;
  assert.equal(samples(cueLateSec(grid(4096, 1800000, 8), cue, CODEC_RULES.flac)), 4095);
});

test('the offset follows the block size, not a constant', () => {
  // ffmpeg's default 4608 block and a 1152 frame both put 12.0 s 720 samples
  // late; 4096 blocks put it 3280 late (measured).
  assert.equal(samples(cueLateSec(grid(4608, 520000, 8), 12.0, CODEC_RULES.flac)), 720);
  assert.equal(samples(cueLateSec(grid(1152, 520000, 20), 12.0, CODEC_RULES.flac)), 720);
  assert.equal(samples(cueLateSec(grid(4096, 520000, 8), 12.0, CODEC_RULES.flac)), 3280);
});

test('an AAC packet exactly on the cue is dropped too (Liquidsoap 2.4.6)', () => {
  assert.equal(samples(cueLateSec(grid(1024, 1800000, 16), 40.96, CODEC_RULES.aac)), 1024);
  assert.equal(samples(cueLateSec(grid(1024, 510000, 16), 11.7, CODEC_RULES.aac)), 126);
});

test('an MP3 subtracts its encoder delay, and an early landing is not stamped', () => {
  // LAME: start_time 1105 samples. Packet 1108 samples past the cue → Y
  // starts 3 samples late on the gapless timeline; 126 past → 979 EARLY,
  // which no delay can fix.
  const start = 1105 / SR;
  const cue = 40.961;
  const late = cueLateSec(grid(1152, 1800000, 20), cue, CODEC_RULES.mp3, start);
  assert.ok(late != null && Math.abs(late * SR - (1806336 + 1152 - cue * SR - 1105)) < 1e-6, `got ${late}`);
  assert.equal(cueLateSec(grid(1152, 500000, 20), 11.7, CODEC_RULES.mp3, start), null);
  // Without a LAME header (start_time 0) the packet rule stands as is.
  assert.equal(samples(cueLateSec(grid(1152, 500000, 20), 11.7, CODEC_RULES.mp3, 0)), 126);
});

test('no packet at or after the cue, or a landing past the bound, is null', () => {
  assert.equal(cueLateSec(grid(4096, 0, 4), 11.7, CODEC_RULES.flac), null);
  // A 16384-sample block can put the cue 0.37 s early of its start.
  assert.equal(cueLateSec([{ pts: 0 }, { pts: (515970 + 0.2 * SR) / SR }], 11.7, CODEC_RULES.flac), null);
  assert.ok(CUE_LATE_MAX_SEC <= 0.15);
});

test('a codec without a validated rule gets no prediction', () => {
  assert.equal(cueLateSec(grid(4096, 500000, 8), 11.7, CODEC_RULES.vorbis), null);
  assert.equal(cueLateSec(grid(4096, 500000, 8), 11.7, undefined), null);
  for (const unvalidated of ['vorbis', 'opus', 'pcm_s16le']) assert.ok(!(unvalidated in CODEC_RULES), unvalidated);
});

test('ffprobe JSON is read from integer pts × time_base, not the 6-dp pts_time', () => {
  const probe = parseProbeJson(JSON.stringify({
    streams: [{ codec_name: 'mp3', sample_rate: '44100', time_base: '1/14112000', start_time: '0.025057' }],
    packets: [{ pts: 165150720, pts_time: '11.702857' }],
  }));
  assert.equal(probe?.codec, 'mp3');
  assert.equal(probe?.packets[0].pts, 165150720 / 14112000);
  assert.equal(probe?.startTimeSec, 0.025057);
  assert.equal(parseProbeJson('not json'), null);
  assert.equal(parseProbeJson('{"streams":[]}'), null);
});

test('Subsonic credentials never reach a log line', () => {
  const url = 'https://navidrome.example/rest/stream?id=abc&format=raw&u=dj&t=0123abcd&s=salt99#subwave_probe=x';
  const red = redactSource(`${url}: Server returned 404 Not Found`);
  for (const secret of ['u=dj', 't=0123abcd', 's=salt99', 'subwave_probe']) assert.ok(!red.includes(secret), red);
  assert.ok(red.includes('navidrome.example/rest/stream?[redacted]'), red);
  assert.ok(!redactSource('stream u=dj&t=deadbeef&s=pepper').includes('deadbeef'));
});

test('probeCueLate is null, never a throw, without ffprobe', async () => {
  const dir = createTempDir(path.join(tmpdir(), 'cue-landing-'));
  const savedPath = process.env.PATH;
  process.env.PATH = dir; // no ffprobe anywhere on PATH
  try {
    assert.equal(await probeCueLate(path.join(dir, 'y.flac'), 11.7), null);
    const landing = await probeCueLanding('https://h/rest/stream?u=dj&t=tok&s=salt', 11.7);
    assert.equal(landing.ok, false);
    assert.ok(!landing.ok && !/tok|salt/.test(landing.reason), JSON.stringify(landing));
  } finally {
    process.env.PATH = savedPath;
  }
});

test('probeCueLate is null for a file ffprobe cannot read, and for a timeout', async () => {
  const dir = createTempDir(path.join(tmpdir(), 'cue-landing-'));
  const junk = path.join(dir, 'not-audio.flac');
  writeFileSync(junk, 'definitely not audio');
  // Stub ffprobes: one fails loudly, one hangs past the timeout.
  const fail = path.join(dir, 'fail');
  const hang = path.join(dir, 'hang');
  for (const [d, body] of [[fail, 'echo "u=dj&t=tok bad" >&2; exit 1'], [hang, 'exec sleep 5']] as const) {
    mkdirSync(d, { recursive: true });
    const bin = path.join(d, 'ffprobe');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
  }
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${fail}:${savedPath}`;
    const failed = await probeCueLanding(junk, 11.7);
    assert.ok(!failed.ok && /exit 1/.test(failed.reason) && !failed.reason.includes('tok'), JSON.stringify(failed));
    process.env.PATH = `${hang}:${savedPath}`;
    const started = Date.now();
    assert.equal(await probeCueLate(junk, 11.7, { timeoutMs: 200 }), null);
    assert.ok(Date.now() - started < 3000, 'the timeout bounds the probe');
  } finally {
    process.env.PATH = savedPath;
  }
});
