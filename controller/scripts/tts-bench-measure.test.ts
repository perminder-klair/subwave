// Pins the pure measurement behind tts-bench (scripts/tts-bench/measure.ts):
// engine specs, the ffmpeg clip-analysis parse, the pace outliers and the
// per-engine summary.
//
// Run: `npm test -- tts-bench-measure`.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipFlags, flagPace, median, parseDurationSec, parseEdgeSilenceMs, parseEngineSpec, parseTruePeakDb,
  percentile, summarize, type BenchRecord,
} from './tts-bench/measure.js';

test('engine specs: the voice is everything after the engine, or after a cloud provider', () => {
  assert.deepEqual(parseEngineSpec('piper'), { label: 'piper', engine: 'piper', voice: '' });
  assert.deepEqual(parseEngineSpec('kokoro:af_heart'), { label: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart' });
  // A Remote server's vocabulary keeps its own colons.
  assert.deepEqual(parseEngineSpec('remote:studio:alba'), { label: 'remote:studio:alba', engine: 'remote', voice: 'studio:alba' });
  assert.deepEqual(parseEngineSpec('cloud:openai:alloy'), {
    label: 'cloud:openai:alloy', engine: 'cloud', voice: 'alloy', cloudProvider: 'openai',
  });
  assert.deepEqual(parseEngineSpec('cloud:elevenlabs'), {
    label: 'cloud:elevenlabs', engine: 'cloud', voice: '', cloudProvider: 'elevenlabs',
  });
  assert.equal(parseEngineSpec('cloud').cloudProvider, undefined);
  assert.equal(parseEngineSpec(' piper:en_US-amy-medium.onnx ').voice, 'en_US-amy-medium.onnx');
});

// Real ffmpeg 8.1 output for a rendered voice clip (framelog lines removed).
const FFMPEG8 = `Input #0, wav, from 'k.wav':
  Duration: 00:00:04.09, bitrate: 384 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 24000 Hz, 1 channels, s16, 384 kb/s
[Parsed_silencedetect_0 @ 0x7813444900] silence_start: 0
[Parsed_silencedetect_0 @ 0x7813444900] silence_end: 0.462208 | silence_duration: 0.462208
[Parsed_silencedetect_0 @ 0x7813444900] silence_start: 1.267375
[Parsed_silencedetect_0 @ 0x7813444900] silence_end: 1.318042 | silence_duration: 0.0506667
[Parsed_silencedetect_0 @ 0x7813444900] silence_start: 3.892292
[Parsed_silencedetect_0 @ 0x7813444900] silence_end: 4.091667 | silence_duration: 0.199375
[Parsed_ebur128_1 @ 0x78134449c0] Summary:

  Integrated loudness:
    I:         -20.8 LUFS
    Threshold: -31.1 LUFS

  Loudness range:
    LRA:         1.9 LU

  True peak:
    Peak:       -2.5 dBFS
`;

test('clip analysis: duration, true peak and edge silence from one ffmpeg pass', () => {
  assert.equal(parseDurationSec(FFMPEG8), 4.09);
  assert.equal(parseDurationSec('  Duration: 01:02:03.50, start: 0'), 3723.5);
  assert.equal(parseDurationSec('  Duration: N/A, bitrate: N/A'), null);

  assert.equal(parseTruePeakDb(FFMPEG8), -2.5);
  assert.equal(parseTruePeakDb('Summary:\n  True peak:\n    Peak:       -inf dBFS'), null);
  assert.equal(parseTruePeakDb('  True peak:\n    Peak: -1.0 dBFS'), null, 'only the summary counts');

  // The mid-clip pause is not an edge; the run that closes at end-of-file is.
  assert.deepEqual(parseEdgeSilenceMs(FFMPEG8, 4.09), { leadMs: 462, trailMs: 198 });
});

test('edge silence: ffmpeg 5.1 leaves a run that reaches the end open', () => {
  const open = 'silence_start: 0.01\nsilence_end: 0.2 | silence_duration: 0.19\nsilence_start: 2.5\n';
  assert.deepEqual(parseEdgeSilenceMs(open, 3), { leadMs: 190, trailMs: 500 });
  assert.deepEqual(parseEdgeSilenceMs('', 3), { leadMs: 0, trailMs: 0 });
  // Starts with voice, ends with voice, one pause inside.
  assert.deepEqual(parseEdgeSilenceMs('silence_start: 1\nsilence_end: 1.4\n', 3), { leadMs: 0, trailMs: 0 });
  // An end with no start before it began at 0.
  assert.deepEqual(parseEdgeSilenceMs('silence_end: 0.3 | silence_duration: 0.3\n', 3), { leadMs: 300, trailMs: 0 });
  // All silence.
  assert.deepEqual(parseEdgeSilenceMs('silence_start: 0\n', 2), { leadMs: 2000, trailMs: 2000 });
});

test('clip flags: long edges and a true peak over full scale', () => {
  assert.deepEqual(clipFlags({ leadMs: 120, trailMs: 300, truePeakDb: -1.5 }), []);
  assert.deepEqual(clipFlags({ leadMs: 600, trailMs: 900, truePeakDb: 0.2 }), ['long-lead', 'long-tail', 'peak-over']);
  // Exactly full scale is Piper's normalisation, not an over.
  assert.deepEqual(clipFlags({ truePeakDb: 0 }), []);
  assert.deepEqual(clipFlags({}), []);
});

test('median and percentile', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5], 95), 5);
});

function rec(engine: string, line: string, extra: Partial<BenchRecord> = {}): BenchRecord {
  return {
    engine, line, category: 'link', iteration: 1, cold: false, outcome: 'ok', ms: 1000, chars: 60, flags: [], ...extra,
  };
}

test('pace: an engine that is simply faster is not flagged, a clip far off its own pace is', () => {
  // `fast` speaks 1.5x faster than `slow` on every line; neither is broken.
  const records = [
    rec('slow', 'a', { cps: 10 }), rec('slow', 'b', { cps: 12 }), rec('slow', 'c', { cps: 14 }),
    rec('fast', 'a', { cps: 15 }), rec('fast', 'b', { cps: 18 }), rec('fast', 'c', { cps: 21 }),
    rec('third', 'a', { cps: 11 }), rec('third', 'b', { cps: 13 }), rec('third', 'c', { cps: 15 }),
  ];
  flagPace(records);
  assert.ok(records.every((r) => r.flags.length === 0), JSON.stringify(records.map((r) => [r.engine, r.line, r.paceRatio])));

  // `third` cut line b short: double its usual pace for that line.
  const broken = records.map((r) => ({ ...r, flags: [] as string[] }));
  broken.find((r) => r.engine === 'third' && r.line === 'b')!.cps = 26;
  broken.find((r) => r.engine === 'slow' && r.line === 'c')!.cps = 5;
  flagPace(broken);
  assert.deepEqual(broken.find((r) => r.engine === 'third' && r.line === 'b')!.flags, ['pace-fast']);
  assert.deepEqual(broken.find((r) => r.engine === 'slow' && r.line === 'c')!.flags, ['pace-slow']);
});

test('pace: records that did not render are left alone', () => {
  const records = [rec('x', 'a', { cps: 10 }), rec('x', 'b', { outcome: 'thrown' }), rec('x', 'c', { outcome: 'fell-back', cps: 40 })];
  flagPace(records);
  assert.equal(records[1].paceRatio, undefined);
  assert.equal(records[2].paceRatio, undefined);
});

test('summary: cold kept out of warm figures, rescues counted as failures', () => {
  const records = [
    rec('piper', 'a', { cold: true, ms: 900, rtf: 0.5, cps: 14, lufs: -20, truePeakDb: -3, leadMs: 40, trailMs: 60 }),
    rec('piper', 'b', { ms: 100, rtf: 0.05, cps: 15, lufs: -18, truePeakDb: -1, leadMs: 40, trailMs: 80, flags: ['long-tail'] }),
    rec('piper', 'c', { ms: 200, rtf: 0.1, cps: 16, lufs: -22, truePeakDb: -2, leadMs: 60, trailMs: 70 }),
    rec('piper', 'd', { outcome: 'fell-back', ms: 50 }),
    rec('piper', 'e', { outcome: 'thrown', ms: 10 }),
    rec('kokoro', '-', { outcome: 'unavailable', ms: 0 }),
  ];
  const [piper, kokoro] = summarize(records);
  assert.equal(piper.engine, 'piper');
  assert.equal(piper.ok, 3);
  assert.equal(piper.failed, 2);
  assert.equal(piper.coldMs, 900);
  assert.equal(piper.warmP50Ms, 100);
  assert.equal(piper.warmP95Ms, 200);
  assert.equal(piper.rtfP50, 0.075);
  assert.equal(piper.lufs, -20);
  assert.equal(piper.lufsSpread, 4);
  assert.equal(piper.peakMaxDb, -1);
  assert.equal(piper.flagged, 1);
  assert.equal(piper.unavailable, false);
  assert.equal(kokoro.unavailable, true);
  assert.equal(kokoro.coldMs, null);
});
