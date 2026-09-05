// Air-time signalling for spoken segments (#1382).
//
// The property under test is a TIMEBASE, not a feature: everything the station
// says about DJ speech used to be stamped when the clip was handed to
// Liquidsoap, which is a 0.5s poll plus a queue, a lead-in and a duck ramp
// before anyone hears a word. These tests pin the three pieces that fix it and,
// just as importantly, the way each one DEGRADES — a station whose mixer
// predates the marker must behave byte-for-byte as it did before, not stall for
// 20 seconds on every segment.
//
// Run: `npm test -- voice-air-events`.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

// config.ts resolves every state path at import time, so the temp dir has to be
// in place before anything under src/ is loaded.
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
// The settings cache seam every other test uses — settings.js itself does not
// re-export it.
const { setCache } = await import('../src/settings/store.js');

const MARKER = config.liquidsoap.voicePlayingFile;
after(() => resetVoiceMarkers());

// awaitVoiceAir deliberately unrefs its production timeout so a controller can
// shut down without waiting up to 20 seconds. A test awaiting only that timer
// needs one referenced handle of its own or Node 22 correctly ends the subprocess
// with the promise still pending. Keep that test support local to this file.
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

// --- the marker file ------------------------------------------------------

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
  // An unrecognised channel is dropped rather than failing the whole marker:
  // the air TIME is the load-bearing half, and which duck layer carried it is
  // reported by the caller anyway.
  const m = parseVoiceMarker(JSON.stringify({ voiceId: 'a', startedAt: 1, channel: 'nope' }));
  assert.equal(m?.channel, null);
  assert.equal(m?.airedAt, 1000);
});

// --- the annotate URI, which is how the id reaches the mixer ---------------

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
});

// --- duration: the clip vs the serialiser's hold --------------------------

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
  // The lead-in and duck tail belong to the voice chain's lock, not to the
  // speech — publishing the padded figure would overstate every segment by
  // ~1.5s, which is most of a short ident.
  assert.equal(speechDurationMs(wav, 'ignored') - clipDurationMs(wav, 'ignored'), VOICE_LEADIN_MS + 700);
  // Non-WAV (a cloud mp3) falls back to the word-count estimate, unchanged.
  assert.ok(clipDurationMs(join(STATE, 'missing.wav'), 'one two three four five') > 0);
});

// --- awaitVoiceAir: the resolve, and every way it degrades ----------------

test('no marker file at all resolves null immediately', async () => {
  resetVoiceMarkers();
  clearMarker();
  const t0 = Date.now();
  // The load-bearing case: a controller upgraded ahead of its broadcast image.
  // If this waited out the timeout, every booth-log line and webhook on that
  // station would arrive 20s late — a far worse regression than the early
  // stamp this feature exists to fix.
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
  // can beat it. The recent-marker buffer is what closes that race.
  writeMarker({ voiceId: 'seg-2', channel: 'say', startedAt: 1770000200 });
  pollVoiceMarker();
  assert.equal(await awaitVoiceAir('seg-2', 5_000), 1770000200000);
});

test('a marker is an edge, not a level', () => {
  resetVoiceMarkers();
  writeMarker({ voiceId: 'seg-3', channel: 'say', startedAt: 1770000300 });
  assert.equal(pollVoiceMarker()?.voiceId, 'seg-3');
  // The file is never deleted, so every subsequent tick re-reads the same clip.
  // Dedup is on the id rather than on mtime or existence.
  assert.equal(pollVoiceMarker(), null, 'same marker does not fire twice');
});

test('a clip whose marker never comes reports an unknown air time', async () => {
  resetVoiceMarkers();
  writeMarker({ voiceId: 'someone-else', channel: 'say', startedAt: 1770000400 });
  // Marker support is present (the file exists), so this one really does wait —
  // and then reports "unknown" rather than inventing a stamp.
  assert.equal(await keepProcessAliveUntil(awaitVoiceAir('seg-4', 120)), null);
});

// --- the fan-out ----------------------------------------------------------

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
    // The listener offset rides along so a consumer syncing to what people HEAR
    // doesn't have to fetch /now-playing to find it (#1114).
    assert.equal(start.body.streamBufferSeconds, 22);

    // The pre-existing event still fires, still on the right channel, with the
    // new fields added rather than the old ones moved.
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
    // Absent, not null and not 0: a consumer must be able to tell "not measured"
    // from "aired at the epoch".
    assert.ok(!('airedAt' in start.body));
    assert.ok(!('endsAt' in start.body));
    assert.ok(start.body.t, 't is still there as the best available approximation');
    const say = await waitFor(received, 'dj.say');
    assert.equal(say.body.kind, 'station-id');
    // The window still closes — the duration is measured even when the air time
    // is not, so a ducking consumer keeps working on an un-upgraded mixer.
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
    // announceExchange fires ONE aggregate dj.say for the whole conversation;
    // per-line legacy events would read as five separate segments to a relay.
    assert.ok(!received.some(r => r.event === 'dj.say'), 'no per-line dj.say');
  });
});

// --- the early warning (voice.queued) --------------------------------------
//
// The air-time fix above traded away the ~1-2s of accidental warning that
// firing at handoff used to give, which is what a consumer ducking live audio
// against the station used to plan with. voice.queued gives it back honestly:
// early, explicitly a forecast, and paired to the measured events by voiceId.

test('the forecast is the wait plus the fixed handoff-to-air head', () => {
  const now = 1_770_000_000_000;
  // Idle chain, no jingle: only the poll + lead-in stand between the handoff
  // and the first word. This is the floor — the warning is short, not absent.
  assert.deepEqual(
    airInEstimate({ now, chainFreeAt: 0, jingleClearAt: 0 }),
    { waitMs: 0, estimatedAirInMs: HANDOFF_TO_AIR_MS },
  );
  // A segment already speaking pushes this one out by whatever it has left.
  assert.equal(
    airInEstimate({ now, chainFreeAt: now + 8_000, jingleClearAt: 0 }).estimatedAirInMs,
    8_000 + HANDOFF_TO_AIR_MS,
  );
  // A jingle on air delays the handoff the same way (airVoice sleeps it out),
  // and the two waits overlap rather than stack — whichever clears last wins.
  assert.equal(
    airInEstimate({ now, chainFreeAt: now + 3_000, jingleClearAt: now + 9_000 }).waitMs,
    9_000,
  );
  // A stale marker computes a window in the past; it must not pull the forecast
  // backwards into a negative wait.
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
    // The id is the whole point: it pairs with the voice.start/voice.end that
    // follow, so a consumer never has to guess which clip fired.
    assert.equal(q.body.voiceId, 'v4');
    assert.equal(q.body.channel, 'intro');
    assert.equal(q.body.durationMs, 6200);
    assert.equal(q.body.estimatedAirInMs, 1300);
    assert.ok(q.body.expectedAirAt, 'the same figure as a timestamp, for convenience');
    // Always a forecast — the field says so rather than leaving a consumer to
    // infer it from the event name.
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
    // Same voiceId through the whole lifecycle, and voice.queued is opt-in like
    // every other event — an existing hook's payload stream is unchanged.
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
