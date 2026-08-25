// The #997 collision guard's arithmetic, and where the clip length comes from.
//
// Sized when every jingle was a <=10s stinger. The on-demand path (#1468) airs
// a sponsor spot or a two-minute announcement, so both halves had to change:
// the wait can no longer be clamped to a fixed minute, and the length can no
// longer come from a RIFF parse alone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-jingle-guard-'));
process.env.STATE_DIR = STATE;

const { config } = await import('../src/config.js');
const { jingleWaitMs, jingleWindow } = await import('../src/broadcast/queue/voice-io.js');
const settings = await import('../src/settings.js');

const CROSS_SEC = Number(settings.get()?.crossfadeDuration) || 10;
const CROSS_MS = CROSS_SEC * 1000;
const TAIL_MS = 1_000;
const CEILING_MS = 600_000;
const NOW = 1_800_000_000_000;

// A RIFF header for a WAV of a known length, so the fallback path is exercised
// against a real parse rather than a stub.
function writeWav(path: string, seconds: number) {
  const rate = 44_100, bytesPerSample = 2;
  const dataLen = Math.round(seconds * rate * bytesPerSample);
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * bytesPerSample, 28);
  b.writeUInt16LE(bytesPerSample, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  writeFileSync(path, b);
}

const jingleDir = join(STATE, 'jingles');
mkdirSync(jingleDir, { recursive: true });
const WAV = join(jingleDir, 'ident.wav');
writeWav(WAV, 6);
const MP3 = join(jingleDir, 'announcement.mp3');
writeFileSync(MP3, Buffer.alloc(1024)); // not RIFF — wavDurationMs cannot read it

function writeMarker(m: Record<string, unknown>) {
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify(m));
}

// --- the bound itself -------------------------------------------------------

test('a two-minute announcement is waited out, not cut off at a fixed minute', () => {
  const windowMs = 120_000 + CROSS_MS + TAIL_MS;
  // The regression: this used to clamp to 60_000, and the next ident was handed
  // over the remaining minute of the clip at heavy duck.
  assert.equal(jingleWaitMs(NOW, NOW + windowMs, windowMs), windowMs);
  assert.ok(windowMs > 60_000, 'the case only exists because the clip outlives the old cap');
});

test('a startedAt dated into the future buys at most one clip', () => {
  const windowMs = 8_000;
  // Marker claims the clip clears an hour out — clock skew, or a corrupt file.
  assert.equal(jingleWaitMs(NOW, NOW + 3_600_000, windowMs), windowMs);
});

test('an implausibly long clip is capped by the ceiling', () => {
  const windowMs = 45 * 60 * 1000; // a 45-minute "jingle"
  assert.equal(jingleWaitMs(NOW, NOW + windowMs, windowMs), CEILING_MS);
});

test('a clip that already cleared is not waited on at all', () => {
  assert.equal(jingleWaitMs(NOW, NOW - 60_000, 20_000), 0);
  assert.equal(jingleWaitMs(NOW, NOW, 20_000), 0);
});

// --- where the length comes from --------------------------------------------

test("Liquidsoap's measurement is preferred over the RIFF parse", () => {
  // The file on disk really is 6s; the mixer measured 90. The marker wins,
  // because it is the side that can measure the file that is actually airing.
  writeMarker({ filename: WAV, durationSec: 90, startedAt: NOW / 1000 });
  assert.equal(jingleWindow().windowMs, 90_000 + CROSS_MS + TAIL_MS);
});

test('a non-WAV announcement is measured, where the RIFF parse could only guess', () => {
  writeMarker({ filename: MP3, durationSec: 90, startedAt: NOW / 1000 });
  assert.equal(jingleWindow().windowMs, 90_000 + CROSS_MS + TAIL_MS);

  // Without durationSec — a marker from an older broadcast image — the same
  // clip falls back to the blind 15s guess, which is the bug being fixed.
  writeMarker({ filename: MP3, startedAt: NOW / 1000 });
  assert.equal(jingleWindow().windowMs, 15_000 + CROSS_MS + TAIL_MS);
});

test('an older image\'s marker still gets the RIFF parse', () => {
  writeMarker({ filename: WAV, startedAt: NOW / 1000 });
  assert.equal(jingleWindow().windowMs, 6_000 + CROSS_MS + TAIL_MS);
});

test('an unmeasurable duration degrades rather than distorting the window', () => {
  // 0. is what jingle_duration writes when request.duration raises.
  writeMarker({ filename: MP3, durationSec: 0, startedAt: NOW / 1000 });
  assert.equal(jingleWindow().windowMs, 15_000 + CROSS_MS + TAIL_MS);
  for (const bad of [-5, 'ninety', null]) {
    writeMarker({ filename: MP3, durationSec: bad, startedAt: NOW / 1000 });
    assert.equal(jingleWindow().windowMs, 15_000 + CROSS_MS + TAIL_MS, `durationSec=${bad}`);
  }
});

test('no marker, or an unreadable one, means nothing to wait for', () => {
  rmSync(config.liquidsoap.jinglePlayingFile, { force: true });
  assert.deepEqual(jingleWindow(), { clearAtMs: 0, windowMs: 0 });
  writeFileSync(config.liquidsoap.jinglePlayingFile, 'not json');
  assert.deepEqual(jingleWindow(), { clearAtMs: 0, windowMs: 0 });
  writeMarker({ filename: WAV }); // no startedAt
  assert.deepEqual(jingleWindow(), { clearAtMs: 0, windowMs: 0 });
});

test.after(() => rmSync(STATE, { recursive: true, force: true }));
