// A multi-voice exchange must hand the mixer its next line BEFORE the current
// one finishes playing. The mixer ducks the music while its voice queue is
// non-empty, so writing each line only after the previous one's playback hold
// let the queue drain between speakers: the music ramped up and back down, an
// audible pump through every exchange. Preloading the next handoff keeps the
// queue busy, and continuation lines carry subwave_no_leadin so the mixer skips
// their silent pre-roll — the gap between speakers is just the clips' padding.
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
const { VOICE_LEADIN_MS } = await import('../src/broadcast/queue/voice-io.js');

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

// Advance mock time in small steps until the next handoff lands: a single
// large tick cannot carry a chain of sleeps more than one step.
async function untilHandoff(t: { mock: { timers: { tick: (ms: number) => void } } }) {
  for (let i = 0; i < 40 && !existsSync(config.liquidsoap.sayFile); i++) {
    t.mock.timers.tick(50);
    await flush();
  }
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
  assert.doesNotMatch(firstUri, /subwave_no_leadin/, 'the opening line keeps its lead-in: the duck starts up');
  assert.equal(queued.length, 2, 'every line is announced before any of it airs');
  assert.equal(
    queued[1].estimatedAirInMs - queued[0].estimatedAirInMs,
    1000,
    'the second forecast follows the first clip alone — no lead-in between them',
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
  assert.match(secondUri, /subwave_no_leadin="true"/, 'a continuation line tells the mixer to skip the dead-air lead-in');
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
  assert.equal(checks, 2, 'the gate is asked again after the handoff wait');
  assert.ok(handoffs[0], 'the line that already landed airs');
  assert.equal(handoffs[1], null);
  assert.equal(handoffs[2], null);
  assert.equal(existsSync(config.liquidsoap.sayFile), false, 'nothing further reaches the mixer');

  // The one landed line holds for its clip (1 s) + lead-in (0.8 s) + tail
  // (0.7 s). Counting the two cancelled lines would hold until 5.9 s and stall
  // the very handoff that claimed the boundary.
  t.mock.timers.tick(3_000);
  await flush();
  assert.equal(voiceBusy(), false, 'the cancelled lines do not hold the voice channel');
});

// A stand-in for poll_voice + voice_queue + voice_marker: consumes say.txt,
// queues the lead-in unless the clip carries subwave_no_leadin, and writes each
// clip's marker to voice-playing.json at the moment that clip starts.
function fakeMixer(durations: Map<string, number>) {
  let queueEndAt = 0;
  const pending: { at: number; voiceId: string }[] = [];
  const starts: number[] = [];
  return {
    starts,
    step(now: number) {
      if (existsSync(config.liquidsoap.sayFile)) {
        const uri = readFileSync(config.liquidsoap.sayFile, 'utf8');
        unlinkSync(config.liquidsoap.sayFile);
        const voiceId = /subwave_voice="([^"]+)"/.exec(uri)![1];
        const wav = uri.slice(uri.lastIndexOf(':') + 1);
        const leadin = uri.includes('subwave_no_leadin="true"') ? 0 : VOICE_LEADIN_MS;
        const at = Math.max(now, queueEndAt) + leadin;
        queueEndAt = at + durations.get(wav)!;
        pending.push({ at, voiceId });
        starts.push(at);
      }
      while (pending.length && pending[0].at <= now) {
        const { at, voiceId } = pending.shift()!;
        writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId, startedAt: at / 1000 }));
      }
    },
  };
}

test('a short middle line keeps its air marker: every line airs, in spoken order, with no timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  // Line 2 is shorter than the marker reader's 500 ms poll. Sweeping line 1's
  // length moves line 2's moment on air across every phase of that poll.
  for (const firstMs of [1000, 1100, 1200, 1300, 1400]) {
    resetVoiceMarkers();
    clearHandoff();
    // A mixer that has spoken before, so every line waits for its marker.
    writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId: 'earlier', startedAt: Date.now() / 1000 }));
    const durations = new Map<string, number>();
    const wavs = [firstMs, 300, 1000].map((ms, i) => {
      const wav = join(STATE, `short-${firstMs}-${i}.wav`);
      writeWav(wav, ms * 8, 8000);
      durations.set(wav, ms);
      return wav;
    });
    const mixer = fakeMixer(durations);
    const airedOrder: number[] = [];
    const airedAt: (number | null)[] = [null, null, null];
    void airVoiceExchange(config.liquidsoap.sayFile, wavs.map((wavPath, i) => ({ wavPath, text: `Line ${i}.`, gainDb: 0 })))
      .then(handoffs => handoffs.forEach((h, i) => h?.aired.then(at => { airedOrder.push(i); airedAt[i] = at; })));
    // Well short of the 20 s air timeout, and past the whole conversation.
    for (let ms = 0; ms < 6_000; ms += 50) {
      t.mock.timers.tick(50);
      await flush();
      mixer.step(Date.now());
      await flush();
    }
    assert.deepEqual(airedOrder, [0, 1, 2], `line 1 at ${firstMs} ms: every line resolves, in the order it was spoken`);
    assert.deepEqual(airedAt, mixer.starts, `line 1 at ${firstMs} ms: each air time is the mixer's own start`);
    t.mock.timers.tick(10_000);
    await flush();
  }
});

test('only a line after a measured, long-enough line skips its lead-in', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const long = join(STATE, 'long.wav');
  const short = join(STATE, 'short.wav');
  writeWav(long, 8000, 8000);    // 1 s
  writeWav(short, 2400, 8000);   // 0.3 s
  const notAWav = join(STATE, 'missing.wav'); // unmeasurable: its length is only an estimate
  writeFileSync(notAWav, 'not audio');
  clearHandoff();
  const uris: string[] = [];
  const exchange = airVoiceExchange(config.liquidsoap.sayFile, [
    { wavPath: long, text: 'One.', gainDb: 0 },
    { wavPath: short, text: 'Two.', gainDb: 0 },
    { wavPath: long, text: 'Three.', gainDb: 0 },
    { wavPath: notAWav, text: 'Four words of text.', gainDb: 0 },
    { wavPath: long, text: 'Five.', gainDb: 0 },
  ]);
  await flush();
  for (let i = 0; i < 5; i++) {
    await untilHandoff(t);
    uris.push(readFileSync(config.liquidsoap.sayFile, 'utf8'));
    unlinkSync(config.liquidsoap.sayFile);
  }
  await exchange;
  assert.deepEqual(
    uris.map(u => u.includes('subwave_no_leadin="true"')),
    [false, true, false, true, false],
    'the opener, the line after a short one and the line after an unmeasured one keep their lead-in',
  );
  t.mock.timers.tick(30_000);
  await flush();
});
