// What the controller makes of jingle-playing.json, replayed against the marker
// timelines a real mixer writes around one automatic 14s stinger.
//
// The controller reads the marker at face value — it cannot tell a marker for a
// clip on air from one for a clip the mixer has only STARTED — so where
// radio.liq writes it decides two things: which seam the #1829 record calls
// "After jingle", and when airVoice holds the DJ off the jingle (#997). Both
// timelines below are offsets measured on savonet/liquidsoap:v2.4.6 through
// radio.liq's own jingle code, lifted into a reduced chain (rotate, jingle_now
// fallback, cross at the default 10s), around a jingle fed at T:
//
//   - the song after it wrote now-playing.json 0.05s BEFORE the jingle fed
//     (its request was already started when the rotate chose the jingle);
//   - the jingle was audible from T+9.76s to T+23.71s, the song after it from
//     T+23.76s, and the song after THAT wrote now-playing.json at T+38.87s;
//   - with the writer on the rotate's playlist, the jingle's own airing wrote
//     NOTHING. The playlist had started it at the end of the previous rotate
//     jingle, N tracks earlier, and at T+19.99s it started the NEXT clip (3s)
//     and stamped that one instead;
//   - with the writer on the source cross reads, the jingle was stamped as
//     itself at T+0.00s, on disk by T+0.09s.
//
// The controller sees a song start on its 1.5s now-playing poll; these replay
// it half a poll late.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-jingle-marker-timeline-'));

const { config } = await import('../src/config.js');
const { interposedSince, jingleWaitMs, jingleWindow } = await import('../src/broadcast/queue/voice-io.js');
const { seamRecordAtPlay } = await import('../src/broadcast/queue/pure.js');
const settings = await import('../src/settings.js');

// The timelines were measured at the station's default crossfade.
assert.equal(settings.get().crossfadeDuration, 10);

const T = 1_800_000_000_000;
const s = (sec: number) => T + Math.round(sec * 1000);
const POLL_LAG = 0.75;

const JINGLE_AUDIBLE = [9.76, 23.71] as const;
const AFTER_SONG_NP = -0.05;     // the song after the jingle
const NEXT_SONG_NP = 38.87;      // the song after that
const PREVIOUS_SONG_NP = -25.05; // the song before the jingle

interface Marker { at: number; filename: string; durationSec: number }
// The jingle's own marker, written where it goes on air.
const ON_AIR: Marker[] = [{ at: 0, filename: '/j/J14.wav', durationSec: 14 }];
// The previous rotate jingle's end started THIS one (N tracks back), and this
// one's end started the next.
const ON_SOURCE: Marker[] = [
  { at: -3600, filename: '/j/J14.wav', durationSec: 14 },
  { at: 19.99, filename: '/j/J3.wav', durationSec: 3 },
];

// The marker file as the controller would read it at `atSec`: the latest write.
function onDiskAt(markers: Marker[], atSec: number) {
  const m = markers.filter(x => x.at <= atSec).at(-1);
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify(m
    ? { filename: m.filename, durationSec: m.durationSec, startedAt: s(m.at) / 1000 }
    : {}));
}

// The seam label the #1829 record writes for a song that started at `npSec`
// after one that started at `prevNpSec`, both seen half a poll late.
function seamLabel(markers: Marker[], prevNpSec: number, npSec: number) {
  const seenAt = npSec + POLL_LAG;
  onDiskAt(markers, seenAt);
  const interposed = interposedSince(s(prevNpSec + POLL_LAG), s(seenAt));
  return seamRecordAtPlay({ track: {} } as never, { track: { sweep: true } } as never, interposed);
}

// How long airVoice would hold a clip handed over at `atSec`.
function voiceHoldMs(markers: Marker[], atSec: number) {
  onDiskAt(markers, atSec);
  const { clearAtMs, windowMs } = jingleWindow();
  return jingleWaitMs(s(atSec), clearAtMs, windowMs);
}

// Every 0.25s of the jingle's audible span.
const audibleInstants: number[] = [];
for (let t = JINGLE_AUDIBLE[0]; t <= JINGLE_AUDIBLE[1]; t += 0.25) audibleInstants.push(t);

test('a marker stamped where the jingle goes on air labels the seam the jingle sat in', () => {
  assert.deepEqual(seamLabel(ON_AIR, PREVIOUS_SONG_NP, AFTER_SONG_NP),
    { label: 'After jingle', stranded: ['sweep'] }, 'the song after the jingle came in after it');
  assert.deepEqual(seamLabel(ON_AIR, AFTER_SONG_NP, NEXT_SONG_NP),
    { label: 'Sweep', stranded: [] }, 'and the song after that came straight in');
});

test('a marker stamped where the jingle goes on air holds the DJ for all of it, and not past it', () => {
  for (const t of audibleInstants) {
    const heldMs = voiceHoldMs(ON_AIR, t);
    assert.ok(s(t) + heldMs >= s(JINGLE_AUDIBLE[1]),
      `a clip handed over at T+${t.toFixed(2)}s waits until the jingle has ended`);
  }
  const clear = JINGLE_AUDIBLE[1] + 2;
  assert.equal(voiceHoldMs(ON_AIR, clear), 0, 'two seconds into the next song, nothing holds the DJ');
});

// The measured consequences of the old placement, kept so the reason for it
// stays checkable: every one of these comes from the marker alone.
test('a marker stamped on the jingle source shifts the seam record one song late', () => {
  assert.deepEqual(seamLabel(ON_SOURCE, PREVIOUS_SONG_NP, AFTER_SONG_NP),
    { label: 'Sweep', stranded: [] }, 'the seam that had the jingle is recorded as a straight sweep');
  assert.deepEqual(seamLabel(ON_SOURCE, AFTER_SONG_NP, NEXT_SONG_NP),
    { label: 'After jingle', stranded: ['sweep'] }, 'and the next seam, which had none, as after a jingle');
});

test('a marker stamped on the jingle source leaves the jingle unheld and holds the song after it', () => {
  const unheld = audibleInstants.filter(t => voiceHoldMs(ON_SOURCE, t) === 0);
  assert.ok(unheld.length > 0 && unheld[0] === JINGLE_AUDIBLE[0], 'the DJ may start over the jingle');
  assert.ok(unheld.at(-1)! >= 19.75, 'for its first ten seconds');
  assert.ok(voiceHoldMs(ON_SOURCE, JINGLE_AUDIBLE[1] + 2) > 8_000,
    'and is held for most of ten seconds into the next song, with no jingle on air');
});
