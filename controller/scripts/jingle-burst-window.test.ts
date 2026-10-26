// What the controller makes of jingle-playing.json when two jingles are fed back
// to back, replayed against the marker timeline a real mixer writes.
//
// cross reads ahead of the air: it takes a jingle shorter than the crossfade
// whole and then the head of whatever follows, so the next jingle is fed
// milliseconds after the first but airs only once the first has ended. The file
// holds the latest marker only, and the first one's is overwritten before the
// controller can read it, so radio.liq stamps how long each jingle waits
// (`queuedSec`) and jingleWindow() opens the window that much later. Offsets
// measured on savonet/liquidsoap:v2.4.6 through radio.liq's own jingle code,
// lifted into a reduced chain (jingle_now switch, cross at the default 10s):
// two 3s presses that a bed had held aired at the next boundary, the first fed
// at T and pulled whole, the second fed at T+0.06s:
//
//   - the first audible from T+10.04s to T+13.02s, the second from T+13.02s to
//     T+16.02s;
//   - the marker left on disk names the second, startedAt T+0.06s, durationSec
//     3, and queuedSec 2.94 (an older mixer writes no queuedSec).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-jingle-burst-window-'));

const { config } = await import('../src/config.js');
const { airInEstimate, jingleWaitMs, jingleWindow } = await import('../src/broadcast/queue/voice-io.js');
const settings = await import('../src/settings.js');

// The timeline was measured at the station's default crossfade.
assert.equal(settings.get().crossfadeDuration, 10);

const T = 1_800_000_000_000;
const s = (sec: number) => T + Math.round(sec * 1000);

const SECOND_FED = 0.06;
const SECOND_AUDIBLE = [13.02, 16.02] as const;
const QUEUED_SEC = 2.938;

function marker(extra: Record<string, unknown> = {}) {
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify({
    filename: '/j/J3.wav', durationSec: 3, startedAt: s(SECOND_FED) / 1000, ...extra,
  }));
}

// How long airVoice would hold a clip handed over at `atSec`.
function holdMs(atSec: number) {
  const { clearAtMs, windowMs } = jingleWindow();
  return jingleWaitMs(s(atSec), clearAtMs, windowMs);
}

// Every 0.25s from the second jingle's feed to its audible end.
const instants: number[] = [];
for (let t = SECOND_FED; t <= SECOND_AUDIBLE[1]; t += 0.25) instants.push(t);

test('a back-to-back jingle\'s wait holds the DJ for all of it, and not long past it', () => {
  marker({ queuedSec: QUEUED_SEC });
  for (const t of instants) {
    assert.ok(s(t) + holdMs(t) >= s(SECOND_AUDIBLE[1]),
      `a clip handed over at T+${t.toFixed(2)}s waits until the second jingle has ended`);
  }
  assert.equal(holdMs(SECOND_AUDIBLE[1] + 2), 0, 'two seconds after it, nothing holds the DJ');
});

test('the voice.queued forecast waits as long as the hold does', () => {
  marker({ queuedSec: QUEUED_SEC });
  const { clearAtMs, windowMs } = jingleWindow();
  for (const t of instants) {
    const { waitMs } = airInEstimate({ now: s(t), chainFreeAt: 0, jingleClearAt: clearAtMs, jingleWindowMs: windowMs });
    assert.ok(s(t) + waitMs >= s(SECOND_AUDIBLE[1]), `forecast at T+${t.toFixed(2)}s`);
  }
});

// What the marker alone gave before the mixer stamped the wait: kept so the
// reason for it stays checkable.
test('stamped at its own feed with no wait, the second jingle\'s tail is unheld', () => {
  marker();
  const releasedAt = (s(SECOND_FED) + holdMs(SECOND_FED) - T) / 1000;
  assert.ok(SECOND_AUDIBLE[1] - releasedAt > 1.5,
    `a clip handed over at its feed airs at T+${releasedAt.toFixed(2)}s, over the jingle's last ~2s`);
});

// The targeted skip (#2017) widens the cross term to the longest outgoing tail
// a jingle can wait behind; the wait stacks on whichever pad the caller asks for.
test('the wait stacks on a caller\'s wider cross term', () => {
  marker({ queuedSec: QUEUED_SEC });
  const station = jingleWindow();
  const wide = jingleWindow(14);
  assert.equal(wide.windowMs - station.windowMs, 4_000, 'only the cross term differs');
  const expected = s(SECOND_FED) + QUEUED_SEC * 1000 + 3_000 + 14_000 + 1_000;
  assert.ok(Math.abs(wide.clearAtMs - expected) < 1, 'feed + wait + clip + the wider pad + tail');
});

// An older broadcast image writes no queuedSec; a bad value must not move the
// window either way.
test('a marker without a usable queuedSec keeps the old window', () => {
  marker();
  const old = jingleWindow();
  assert.equal(old.windowMs, 3_000 + 10_000 + 1_000, 'clip + crossfade + tail, as before');
  assert.equal(old.clearAtMs, s(SECOND_FED) + old.windowMs);
  for (const queuedSec of [0, -2, 'abc', null, Number.POSITIVE_INFINITY]) {
    marker({ queuedSec });
    assert.deepEqual(jingleWindow(), old, `queuedSec ${String(queuedSec)}`);
  }
});
