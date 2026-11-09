// A multi-voice exchange must hand the mixer its next line BEFORE the current
// one finishes playing. The mixer ducks the music while its voice queue is
// non-empty, so writing each line only after the previous one's playback hold
// let the queue drain between speakers: the music ramped up and back down, an
// audible pump through every exchange. Preloading the next handoff keeps the
// queue busy — the gap between speakers is then just the silent lead-in.
//
// Run: npm test -- exchange-air-gap

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

// config.ts resolves state paths at import time, so STATE_DIR comes first.
const STATE = mkdtempSync(join(tmpdir(), 'subwave-exchange-gap-'));
process.env.STATE_DIR = STATE;

const { config } = await import('../src/config.js');
const { airVoiceExchange, voiceBusy } = await import('../src/broadcast/queue/voice-io.js');
const { resetVoiceMarkers } = await import('../src/broadcast/queue/voice-marker.js');

after(async () => {
  resetVoiceMarkers();
  await removeTempDir(STATE);
});

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

// 44-byte canonical WAV header: `dataBytes` of audio at `byteRate` = 1s.
function writeWav(path: string, dataBytes: number, byteRate: number) {
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(byteRate, 24);    // sample rate
  buf.writeUInt32LE(byteRate, 28);    // byteRate (fmt body offset 8)
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  writeFileSync(path, buf);
}

function clearHandoff() {
  if (existsSync(config.liquidsoap.sayFile)) unlinkSync(config.liquidsoap.sayFile);
}

test('the next line is handed over before the current one finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const first = join(STATE, 'first.wav');
  const second = join(STATE, 'second.wav');
  writeWav(first, 8000, 8000);
  writeWav(second, 8000, 8000);
  clearHandoff();

  const queued: { voiceId: string; clipMs: number; estimatedAirInMs: number }[] = [];
  const exchange = airVoiceExchange(config.liquidsoap.sayFile, [
    { wavPath: first, text: 'The host opens.', gainDb: 0, onQueued: q => queued.push(q) },
    { wavPath: second, text: 'The guest answers.', gainDb: -10, onQueued: q => queued.push(q) },
  ]);
  await flush();

  assert.ok(existsSync(config.liquidsoap.sayFile), 'the first line reaches say.txt');
  const firstUri = readFileSync(config.liquidsoap.sayFile, 'utf8');
  assert.match(firstUri, /first\.wav/);
  assert.equal(queued.length, 2, 'every line is announced before any of it airs');
  assert.equal(
    queued[1].estimatedAirInMs - queued[0].estimatedAirInMs,
    1000 + 800,
    'the second forecast follows the first clip plus its lead-in',
  );

  // poll_voice consumes the file. The next line must land straight away: the
  // first is still inside its playback hold (clip + lead-in + tail > 1s).
  unlinkSync(config.liquidsoap.sayFile);
  t.mock.timers.tick(150);   // the handoff reader's 100 ms consumption poll
  await flush();

  assert.ok(existsSync(config.liquidsoap.sayFile), 'the second line is preloaded behind the first');
  const secondUri = readFileSync(config.liquidsoap.sayFile, 'utf8');
  assert.match(secondUri, /second\.wav/);
  assert.match(secondUri, /liq_amplify="-10 dB"/, 'the second speaker keeps their gain');
  assert.notEqual(secondUri, firstUri, 'each line carries its own voice id');

  const handoffs = await exchange;
  assert.equal(handoffs.length, 2);
  assert.ok(handoffs[0] && handoffs[1]);
  assert.notEqual(handoffs[0]!.voiceId, handoffs[1]!.voiceId);
  assert.equal(handoffs[0]!.clipMs, 1000);
  assert.equal(handoffs[1]!.clipMs, 1000);
  assert.equal(voiceBusy(), true, 'one reservation covers the whole conversation');

  unlinkSync(config.liquidsoap.sayFile);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(voiceBusy(), false, 'the lock is released after the last line');
});

test('a boundary claimed mid-exchange drops the lines that have not landed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const wav = join(STATE, 'gate.wav');
  writeWav(wav, 8000, 8000);
  clearHandoff();

  let checks = 0;
  const exchange = airVoiceExchange(config.liquidsoap.sayFile, [
    { wavPath: wav, text: 'One.', gainDb: 0 },
    { wavPath: wav, text: 'Two.', gainDb: 0 },
    { wavPath: wav, text: 'Three.', gainDb: 0 },
  ], { beforeWrite: () => ++checks === 1 });
  await flush();

  unlinkSync(config.liquidsoap.sayFile);
  t.mock.timers.tick(150);
  await flush();

  const handoffs = await exchange;
  assert.equal(checks, 2, 'the gate is asked again before the second line');
  assert.ok(handoffs[0], 'the line that already landed airs');
  assert.equal(handoffs[1], null);
  assert.equal(handoffs[2], null);
  assert.equal(existsSync(config.liquidsoap.sayFile), false, 'nothing further reaches the mixer');

  t.mock.timers.tick(10_000);
  await flush();
});
