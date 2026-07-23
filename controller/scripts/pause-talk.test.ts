// Unit tests for pause-then-talk's pure helpers (broadcast/pause-talk.ts) and
// the WAV silence padder (audio/wav-pad.ts). node:assert-via-tsx style,
// matching scripts/programme.test.ts.
// Run: `tsx scripts/pause-talk.test.ts` (or `npm run test:pausetalk`).

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  wantsPauseTalk,
  padTimesFor,
  talkTooShort,
  talkUri,
  TALK_EXIT_CROSS_SEC,
  TALK_HEAD_PAD_MS,
  TALK_TAIL_PAD_MS,
} from '../src/broadcast/pause-talk.js';
import { padWavSilence } from '../src/audio/wav-pad.js';

// ── wantsPauseTalk ───────────────────────────────────────────────────────────

// Long enough, opted in, enabled → gap.
assert.equal(
  wantsPauseTalk({ enabled: true, gapEligible: true, wavMs: 25_000, thresholdSec: 20 }),
  true,
  'over threshold on an enabled, opted-in show → gap',
);

// Exactly at the threshold → gap (>= boundary).
assert.equal(
  wantsPauseTalk({ enabled: true, gapEligible: true, wavMs: 20_000, thresholdSec: 20 }),
  true,
  'exactly at threshold → gap',
);

// One ms under → duck.
assert.equal(
  wantsPauseTalk({ enabled: true, gapEligible: true, wavMs: 19_999, thresholdSec: 20 }),
  false,
  'just under threshold → duck',
);

// Show toggle off → always duck.
assert.equal(
  wantsPauseTalk({ enabled: false, gapEligible: true, wavMs: 60_000, thresholdSec: 20 }),
  false,
  'disabled show never gaps',
);

// Caller did not opt in (non-skill call site) → duck.
assert.equal(
  wantsPauseTalk({ enabled: true, gapEligible: false, wavMs: 60_000, thresholdSec: 20 }),
  false,
  'not gap-eligible never gaps',
);

// Non-WAV clip (cloud mp3, null wavMs) → duck, even when long.
assert.equal(
  wantsPauseTalk({ enabled: true, gapEligible: true, wavMs: null, thresholdSec: 20 }),
  false,
  'null wavMs (cloud mp3) falls back to duck',
);

// ── padTimesFor ──────────────────────────────────────────────────────────────

{
  const { headMs, tailMs } = padTimesFor({ entryCrossSec: 8 });
  assert.equal(headMs, 8 * 1000 + TALK_HEAD_PAD_MS, 'head = entry cross + breath');
  assert.equal(tailMs, TALK_EXIT_CROSS_SEC * 1000 + TALK_TAIL_PAD_MS, 'tail = exit cross + margin');
}

{
  // A NaN/undefined entry cross degrades to just the breath, never NaN.
  const { headMs, tailMs } = padTimesFor({ entryCrossSec: Number.NaN });
  assert.equal(headMs, TALK_HEAD_PAD_MS, 'non-finite entry cross → breath only');
  assert.ok(Number.isFinite(tailMs), 'tail stays finite');
}

// ── talkTooShort ─────────────────────────────────────────────────────────────

// A 25s padded clip against an 8s entry cross is comfortably safe.
assert.equal(talkTooShort(25_000, 8), false, 'long clip clears the sanity guard');
// A clip barely longer than its entry cross would glitch cross() → too short.
assert.equal(talkTooShort(9_000, 8), true, 'clip within entry+5s is flagged too short');

// ── talkUri ──────────────────────────────────────────────────────────────────

{
  const uri = talkUri('/var/sub-wave/piper/talk-123.wav');
  assert.ok(uri.startsWith('annotate:subwave_kind="talk"'), 'carries the talk kind');
  assert.ok(uri.includes('liq_cross_duration="1.50"'), 'stamps its own exit cross');
  assert.ok(!uri.includes('liq_amplify'), 'no amplify when gain is zero');
  assert.ok(uri.endsWith(':/var/sub-wave/piper/talk-123.wav'), 'path trails the annotation');
}

{
  const uri = talkUri('/tmp/x.wav', { gainDb: -3 });
  assert.ok(uri.includes('liq_amplify="-3 dB"'), 'amplify present when gain is non-zero');
}

// ── padWavSilence ────────────────────────────────────────────────────────────

// Build a minimal canonical 16-bit mono PCM WAV: `frames` samples at `rate`.
function makeWav(frames: number, rate = 16_000): Buffer {
  const dataLen = frames * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  // Fill the body with a recognisable non-zero sine-ish pattern.
  for (let i = 0; i < frames; i++) buf.writeInt16LE(((i % 100) - 50) * 100, 44 + i * 2);
  return buf;
}

{
  const dir = mkdtempSync(join(tmpdir(), 'pause-talk-'));
  try {
    const rate = 16_000;
    const srcFrames = rate; // 1.0s of audio
    const src = join(dir, 'src.wav');
    const dest = join(dir, 'dest.wav');
    const original = makeWav(srcFrames, rate);
    writeFileSync(src, original);

    const out = await padWavSilence(src, dest, { headMs: 500, tailMs: 250 });
    assert.equal(out, dest, 'returns the destination path on success');

    // Original untouched — a ducked fallback may still need it.
    assert.deepEqual(readFileSync(src), original, 'source WAV is never mutated');

    const padded = readFileSync(dest);
    // 500ms head + 250ms tail at 16kHz mono 16-bit = (8000 + 4000) frames * 2 bytes.
    const headBytes = Math.floor((rate * 500) / 1000) * 2;
    const tailBytes = Math.floor((rate * 250) / 1000) * 2;
    const expectedDataLen = srcFrames * 2 + headBytes + tailBytes;
    assert.equal(padded.readUInt32LE(40), expectedDataLen, 'data chunk size reflects the padding');
    assert.equal(padded.readUInt32LE(4), 36 + expectedDataLen, 'RIFF size reflects the padding');
    assert.equal(padded.length, 44 + expectedDataLen, 'file length reflects the padding');

    // Head bytes are zero (silence); the original body follows immediately after.
    for (let i = 0; i < headBytes; i++) assert.equal(padded[44 + i], 0, 'head is silent');
    assert.equal(
      padded.readInt16LE(44 + headBytes),
      original.readInt16LE(44),
      'original body starts right after the head padding',
    );

    // A non-WAV (mp3-ish) source returns null → caller ducks.
    const bogus = join(dir, 'cloud.mp3.wav');
    writeFileSync(bogus, Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]));
    assert.equal(
      await padWavSilence(bogus, join(dir, 'out2.wav'), { headMs: 100, tailMs: 100 }),
      null,
      'non-WAV source returns null',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\x1b[32m✓ pause-talk pure helpers + wav-pad\x1b[0m');
