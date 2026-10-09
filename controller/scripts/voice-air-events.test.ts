// Air-time signalling for spoken segments (#1382): the marker, the fan-out,
// and how each degrades on a mixer that predates the marker.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

// config.ts resolves state paths at import time, so STATE_DIR comes first.
const STATE = mkdtempSync(join(tmpdir(), 'subwave-voice-'));
process.env.STATE_DIR = STATE;

const { config } = await import('../src/config.js');
const {
  parseVoiceMarker,
  pollVoiceMarker,
  awaitVoiceAir,
  resetVoiceMarkers,
} = await import('../src/broadcast/queue/voice-marker.js');
const { voiceUri, clipDurationMs, speechDurationMs, VOICE_LEADIN_MS, HANDOFF_TO_AIR_MS, airInEstimate } =
  await import('../src/broadcast/queue/voice-io.js');
const { notifySpoken, notifyQueued } = await import('../src/broadcast/voice-events.js');
// settings.js does not re-export the cache seam.
const { setCache } = await import('../src/settings/store.js');

const MARKER = config.liquidsoap.voicePlayingFile;
after(() => resetVoiceMarkers());

// awaitVoiceAir unrefs its timeout, so a test awaiting only that timer needs a
// referenced handle or Node ends the subprocess with the promise pending.
async function keepProcessAliveUntil<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

function writeMarker(m: Record<string, unknown>) {
  writeFileSync(MARKER, JSON.stringify(m));
}
function clearMarker() {
  if (existsSync(MARKER)) unlinkSync(MARKER);
}

test('parseVoiceMarker converts liquidsoap seconds to epoch ms', () => {
  const m = parseVoiceMarker(JSON.stringify({
    voiceId: 'abc123', channel: 'intro', filename: '/x.wav', startedAt: 1770000000.5,
  }));
  assert.equal(m?.voiceId, 'abc123');
  assert.equal(m?.airedAt, 1770000000500);
  assert.equal(m?.channel, 'intro');
  assert.equal(m?.filename, '/x.wav');
});

test('parseVoiceMarker rejects what it cannot use', () => {
  assert.equal(parseVoiceMarker('{ half-writ'), null, 'torn write');
  assert.equal(parseVoiceMarker('null'), null, 'literal null');
  assert.equal(parseVoiceMarker(JSON.stringify({ startedAt: 1770000000 })), null, 'no voiceId');
  assert.equal(parseVoiceMarker(JSON.stringify({ voiceId: 'a' })), null, 'no startedAt');
  assert.equal(parseVoiceMarker(JSON.stringify({ voiceId: 'a', startedAt: 0 })), null, 'zero clock');
  // An unrecognised channel is dropped rather than failing the whole marker;
  // the air TIME is the load-bearing half.
  const m = parseVoiceMarker(JSON.stringify({ voiceId: 'a', startedAt: 1, channel: 'nope' }));
  assert.equal(m?.channel, null);
  assert.equal(m?.airedAt, 1000);
});

test('voiceUri always carries the id, and keeps the gain form it always had', () => {
  assert.equal(
    voiceUri('/tmp/a.wav', 0, 'deadbeef'),
    'annotate:subwave_voice="deadbeef":/tmp/a.wav',
    'a 0 dB clip is annotated now — the id has to travel somehow',
  );
  assert.equal(
    voiceUri('/tmp/a.wav', -3, 'deadbeef'),
    'annotate:liq_amplify="-3 dB",subwave_voice="deadbeef":/tmp/a.wav',
    'the gain keeps its exact `<n> dB` spelling and stays first',
  );
  assert.equal(
    voiceUri('/tmp/a.wav', 0, 'deadbeef', 'pause123'),
    'annotate:subwave_voice="deadbeef",subwave_pause_delivery="pause123":/tmp/a.wav',
    'a pause delivery carries the stable id the mixer acknowledges',
  );
});

// 44-byte canonical WAV header: 8000 bytes of data at a byteRate of 8000 = 1s.
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

test('durationMs published to consumers is the clip, not the padded hold', () => {
  const wav = join(STATE, 'clip.wav');
  writeWav(wav, 8000, 8000);
  assert.equal(clipDurationMs(wav, 'ignored'), 1000, 'exact length from the WAV header');
  // The lead-in and duck tail belong to the chain's lock, not to the speech.
  assert.equal(speechDurationMs(wav, 'ignored') - clipDurationMs(wav, 'ignored'), VOICE_LEADIN_MS + 700);
  // A file that cannot be read at all falls back to the word-count estimate.
  assert.ok(clipDurationMs(join(STATE, 'missing.wav'), 'one two three four five') > 0);
});

// Layer III frames as [header bytes, frame length, seconds of audio]. Lengths
// follow from the header: 144 (MPEG-1) or 72 (MPEG-2) * bitrate / sample rate.
const STEREO_128K = { header: [0xff, 0xfb, 0x90, 0x00], length: 417, seconds: 1152 / 44100 };
const MONO_128K = { header: [0xff, 0xfb, 0x90, 0xc0], length: 417, seconds: 1152 / 44100 };   // what ElevenLabs sends
const STEREO_320K = { header: [0xff, 0xfb, 0xe0, 0x00], length: 1044, seconds: 1152 / 44100 };
const STEREO_32K = { header: [0xff, 0xfb, 0x10, 0x00], length: 104, seconds: 1152 / 44100 };
const MPEG2_24KHZ_64K = { header: [0xff, 0xf3, 0x84, 0xc4], length: 192, seconds: 576 / 24000 };
type Mp3Frame = typeof STEREO_128K;

// Writes the frames back to back and returns the audio length in ms.
function writeMp3(path: string, frames: Mp3Frame[], { id3Bytes = 0, tail = 0 }: { id3Bytes?: number; tail?: number } = {}): number {
  const id3 = Buffer.alloc(id3Bytes ? 10 + id3Bytes : 0);
  if (id3Bytes) {
    id3.write('ID3', 0, 'ascii');
    id3[3] = 4;
    // synchsafe size: 7 bits per byte
    id3[6] = (id3Bytes >> 21) & 0x7f; id3[7] = (id3Bytes >> 14) & 0x7f;
    id3[8] = (id3Bytes >> 7) & 0x7f; id3[9] = id3Bytes & 0x7f;
  }
  const body = frames.map(f => {
    const b = Buffer.alloc(f.length);
    b.set(f.header, 0);
    return b;
  });
  writeFileSync(path, Buffer.concat([id3, ...body, Buffer.alloc(tail, 0x41)]));
  return Math.ceil(frames.reduce((sum, f) => sum + f.seconds, 0) * 1000);
}

const FIVE_WORDS = 'one two three four five';
const ESTIMATE_MS = Math.ceil((5 / 2.3) * 1000);

test('a cloud mp3 is measured, not guessed from its word count', () => {
  const mp3 = join(STATE, 'clip.mp3');
  // ~10s of audio behind five words: the estimate says 2.2s.
  for (const [name, frame] of Object.entries({ stereo: STEREO_128K, mono: MONO_128K, 'mpeg-2 24kHz': MPEG2_24KHZ_64K })) {
    const exact = writeMp3(mp3, Array(400).fill(frame));
    assert.equal(clipDurationMs(mp3, FIVE_WORDS), exact, name);
  }
  const tagged = writeMp3(mp3, Array(383).fill(MONO_128K), { id3Bytes: 6000, tail: 128 });
  assert.equal(clipDurationMs(mp3, FIVE_WORDS), tagged, 'an ID3v2 tag and a trailing ID3v1-sized tag are skipped');
});

test('a variable-bitrate mp3 is never measured short', () => {
  // File size over the first frame's bitrate reads this 10s clip as 1.3s: the
  // next line would talk over nine seconds of this one.
  const mp3 = join(STATE, 'vbr.mp3');
  const exact = writeMp3(mp3, [STEREO_320K, ...Array(382).fill(STEREO_32K)]);
  assert.equal(clipDurationMs(mp3, FIVE_WORDS), exact);
});

test('an mp3 the walk cannot follow falls back to the estimate', () => {
  const mp3 = join(STATE, 'broken.mp3');
  // Frames, then junk the walk cannot cross: a partial length would be short.
  writeMp3(mp3, Array(40).fill(STEREO_128K), { tail: 50_000 });
  assert.equal(clipDurationMs(mp3, FIVE_WORDS), ESTIMATE_MS, 'lost sync mid-file');
  writeMp3(mp3, [STEREO_128K]);
  assert.equal(clipDurationMs(mp3, FIVE_WORDS), ESTIMATE_MS, 'one frame is not evidence of mp3');
  // Free-format (bitrate index 0) and the reserved index 15 carry no frame length.
  for (const b2 of [0x00, 0xf0]) {
    writeFileSync(mp3, Buffer.concat([Buffer.from([0xff, 0xfb, b2, 0x00]), Buffer.alloc(2000)]));
    assert.equal(clipDurationMs(mp3, FIVE_WORDS), ESTIMATE_MS, `bitrate bits ${b2.toString(16)}`);
  }
  writeFileSync(mp3, Buffer.alloc(5000, 0x41));
  assert.equal(clipDurationMs(mp3, FIVE_WORDS), ESTIMATE_MS, 'not audio at all');
});

test('no marker file at all resolves null immediately', async () => {
  resetVoiceMarkers();
  clearMarker();
  const t0 = Date.now();
  // A controller upgraded ahead of its broadcast image: waiting out the
  // timeout would delay every booth-log line and webhook by 20s.
  assert.equal(await awaitVoiceAir('nobody', 5_000), null);
  assert.ok(Date.now() - t0 < 500, 'resolved without waiting');
});

test('a marker resolves the segment that is waiting for it', async () => {
  resetVoiceMarkers();
  writeMarker({ voiceId: 'seg-1', channel: 'say', startedAt: 1770000123.25 });
  const pending = awaitVoiceAir('seg-1', 5_000);
  pollVoiceMarker();
  assert.equal(await pending, 1770000123250);
});

test('a marker seen before its waiter registers is not lost', async () => {
  resetVoiceMarkers();
  // airVoice registers only after its handoff write resolves, so a fast mixer
  // can beat it; the recent-marker buffer closes that race.
  writeMarker({ voiceId: 'seg-2', channel: 'say', startedAt: 1770000200 });
  pollVoiceMarker();
  assert.equal(await awaitVoiceAir('seg-2', 5_000), 1770000200000);
});

test('a marker is an edge, not a level', () => {
  resetVoiceMarkers();
  writeMarker({ voiceId: 'seg-3', channel: 'say', startedAt: 1770000300 });
  assert.equal(pollVoiceMarker()?.voiceId, 'seg-3');
  // The file is never deleted, so dedup is on the id, not mtime or existence.
  assert.equal(pollVoiceMarker(), null, 'same marker does not fire twice');
});

test('a clip whose marker never comes reports an unknown air time', async () => {
  resetVoiceMarkers();
  writeMarker({ voiceId: 'someone-else', channel: 'say', startedAt: 1770000400 });
  // Marker support is present, so this waits and then reports unknown rather
  // than inventing a stamp.
  assert.equal(await keepProcessAliveUntil(awaitVoiceAir('seg-4', 120)), null);
});

interface Received { event: string; body: Record<string, any> }

async function withHookServer(fn: (received: Received[]) => Promise<void>) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        received.push({ event: body.event, body });
      } catch { /* not ours */ }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  setCache({
    stream: { bufferSeconds: 22 },
    webhooks: [{
      id: 'test_hook',
      url: `http://127.0.0.1:${port}/hook`,
      events: ['dj.say', 'dj.link', 'voice.queued', 'voice.start', 'voice.end'],
      enabled: true,
      authHeader: '',
    }],
  });
  try {
    await fn(received);
  } finally {
    setCache(null);
    // undici keeps the connection alive, so close() alone never resolves.
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function waitFor(received: Received[], event: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received.find(r => r.event === event);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`no ${event} within ${timeoutMs}ms (saw: ${received.map(r => r.event).join(', ') || 'nothing'})`);
}

test('a measured segment publishes a real window, on both the new and old events', async () => {
  await withHookServer(async received => {
    const airedAt = Date.now() - 200;
    notifySpoken({
      voiceId: 'v1', kind: 'link', channel: 'intro',
      text: 'staying in the deep end', durationMs: 300, airedAt,
    });

    const start = await waitFor(received, 'voice.start');
    assert.equal(start.body.voiceId, 'v1');
    assert.equal(start.body.channel, 'intro');
    assert.equal(start.body.durationMs, 300);
    assert.equal(start.body.estimated, false);
    assert.equal(start.body.airedAt, new Date(airedAt).toISOString());
    assert.equal(start.body.endsAt, new Date(airedAt + 300).toISOString());
    // The listener offset rides along so a consumer syncing to what people
    // hear need not fetch /now-playing (#1114).
    assert.equal(start.body.streamBufferSeconds, 22);

    // The pre-existing event still fires with new fields added, not moved.
    const link = await waitFor(received, 'dj.link');
    assert.equal(link.body.text, 'staying in the deep end');
    assert.equal(link.body.voiceId, 'v1');
    assert.equal(link.body.durationMs, 300);
    assert.ok(!received.some(r => r.event === 'dj.say'), 'a link is not a say');

    const end = await waitFor(received, 'voice.end');
    assert.equal(end.body.voiceId, 'v1', 'same id pairs the window');
    assert.equal(end.body.endedAt, new Date(airedAt + 300).toISOString());
    assert.ok(!('text' in end.body), 'end is a boundary, not a second copy of the script');
  });
});

test('an unmeasured segment omits the timestamps rather than guessing', async () => {
  await withHookServer(async received => {
    notifySpoken({
      voiceId: 'v2', kind: 'station-id', channel: 'say',
      text: "you're locked into SUB/WAVE", durationMs: 120, airedAt: null,
    });
    const start = await waitFor(received, 'voice.start');
    assert.equal(start.body.estimated, true);
    // Absent, not null and not 0: "not measured" must differ from "epoch".
    assert.ok(!('airedAt' in start.body));
    assert.ok(!('endsAt' in start.body));
    assert.ok(start.body.t, 't is still there as the best available approximation');
    const say = await waitFor(received, 'dj.say');
    assert.equal(say.body.kind, 'station-id');
    // The window still closes: duration is measured even when air time is not.
    await waitFor(received, 'voice.end');
  });
});

test('a banter line keeps voice.* per line while dj.say stays one per exchange', async () => {
  await withHookServer(async received => {
    notifySpoken({
      voiceId: 'v3', kind: 'banter', channel: 'say',
      text: 'and that, listeners, is why', durationMs: 60, airedAt: Date.now(),
      legacy: false,
    });
    await waitFor(received, 'voice.start');
    await waitFor(received, 'voice.end');
    // announceExchange fires ONE aggregate dj.say for the whole conversation.
    assert.ok(!received.some(r => r.event === 'dj.say'), 'no per-line dj.say');
  });
});

// voice.queued: an explicit forecast, paired to the measured events by voiceId.

test('the forecast is the wait plus the fixed handoff-to-air head', () => {
  const now = 1_770_000_000_000;
  // Idle chain, no jingle: the floor is the poll + lead-in.
  assert.deepEqual(
    airInEstimate({ now, chainFreeAt: 0, jingleClearAt: 0 }),
    { waitMs: 0, estimatedAirInMs: HANDOFF_TO_AIR_MS },
  );
  // A segment already speaking pushes this one out by whatever it has left.
  assert.equal(
    airInEstimate({ now, chainFreeAt: now + 8_000, jingleClearAt: 0 }).estimatedAirInMs,
    8_000 + HANDOFF_TO_AIR_MS,
  );
  // The two waits overlap rather than stack: whichever clears last wins.
  assert.equal(
    airInEstimate({ now, chainFreeAt: now + 3_000, jingleClearAt: now + 9_000 }).waitMs,
    9_000,
  );
  // A stale marker must not pull the forecast into a negative wait.
  assert.equal(
    airInEstimate({ now, chainFreeAt: now - 60_000, jingleClearAt: now - 60_000 }).waitMs,
    0,
  );
});

test('voice.queued lands before the words and admits it is a forecast', async () => {
  await withHookServer(async received => {
    notifyQueued({
      voiceId: 'v4', kind: 'link', channel: 'intro',
      text: 'staying in the deep end', durationMs: 6200, estimatedAirInMs: 1300,
    });
    const q = await waitFor(received, 'voice.queued');
    // The id pairs with the voice.start/voice.end that follow.
    assert.equal(q.body.voiceId, 'v4');
    assert.equal(q.body.channel, 'intro');
    assert.equal(q.body.durationMs, 6200);
    assert.equal(q.body.estimatedAirInMs, 1300);
    assert.ok(q.body.expectedAirAt, 'the same figure as a timestamp, for convenience');
    assert.equal(q.body.estimated, true);
    // A field named for a measurement must never carry a guess.
    assert.ok(!('airedAt' in q.body), 'no airedAt on a forecast');
    assert.equal(q.body.streamBufferSeconds, 22);
    // Nothing else fires yet: the segment has not aired.
    assert.ok(!received.some(r => r.event === 'voice.start'));
    assert.ok(!received.some(r => r.event === 'dj.link'));
  });
});

test('a hook subscribed only to the measured events never sees the forecast', async () => {
  await withHookServer(async received => {
    // Same voiceId through the lifecycle; voice.queued is opt-in like every
    // other event.
    notifyQueued({
      voiceId: 'v5', kind: 'station-id', channel: 'say',
      text: "you're locked into SUB/WAVE", durationMs: 120, estimatedAirInMs: 900,
    });
    await waitFor(received, 'voice.queued');
    notifySpoken({
      voiceId: 'v5', kind: 'station-id', channel: 'say',
      text: "you're locked into SUB/WAVE", durationMs: 120, airedAt: Date.now(),
    });
    const start = await waitFor(received, 'voice.start');
    assert.equal(start.body.voiceId, 'v5', 'queued and start pair on the id');
    assert.equal(start.body.estimated, false, 'the measured event is still measured');
    const end = await waitFor(received, 'voice.end');
    assert.equal(end.body.voiceId, 'v5');
  });
});

test.after(() => {
  resetVoiceMarkers();
  rmSync(STATE, { recursive: true, force: true });
});
