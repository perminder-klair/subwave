// Stream idle monitor — pause the programme while the room is empty.
//
// With settings.stream.idleWhenEmpty on and zero listeners for
// idleAfterMinutes, flip radio.liq's idle gate (telnet idle_on): the mounts
// stay up serving silence but the music chain stops being pulled, frozen
// mid-track. Any client still connects while idle, and the first connection
// resumes (idle_off) exactly where it froze. Contrast POST /stream-stop
// (stream_off), which tears the mounts down — the operator's hard off-air.
//
// Fail-OPEN: an unknown count (sustained failure, not one timed-out poll —
// #1256) never holds the station silent. Telnet failures keep the current state
// and retry next tick. State is not persisted; a mixer restart comes back live
// and the monitor re-asserts idle_on, and on controller boot the gate's state
// is adopted from Liquidsoap (idle_status). Transitions live in the pure
// nextIdleState().

import * as settings from '../settings.js';
import { warmHeavy } from '../audio/ttsHeavyClient.js';
import { gatedListenerCount, refresh, setStreamIdle } from './listeners.js';
import { idleOn, idleOff, idleStatus } from './liquidsoap-control.js';
import { queue } from './queue.js';
import { nextIdleState, type IdleState } from './stream-idle-pure.js';

// One tick every 5s. Live: read the 15s monitor's cached count. Idle: force a
// fresh poll, so a new listener waits ~5s (worst case ~8s, since the forced
// poll is single-flighted). Tightening that would re-race the two pollers
// (#1256).
const TICK_MS = 5000;

let state: IdleState = { idle: false, zeroSince: null };

// Read by GET /state so the player can tell "nobody's here" from "broken".
export function isIdle() {
  return state.idle;
}

async function tick() {
  const st = settings.get()?.stream;
  const enabled = !!st?.idleWhenEmpty;
  const idleAfterMin = Number(st?.idleAfterMinutes) >= 1 ? Number(st?.idleAfterMinutes) : 10;
  // Idle forces a fresh poll (the 15s cadence would add 15s to the wake-up).
  // Always read through gatedListenerCount(), never refresh()'s raw return: one
  // timed-out poll out of ~120 per pause released it (#1256).
  if (state.idle && enabled) await refresh();
  const count = gatedListenerCount();
  const { state: next, action } = nextIdleState(state, {
    enabled,
    count,
    now: Date.now(),
    idleAfterMs: idleAfterMin * 60_000,
  });
  try {
    if (action === 'pause') {
      await idleOn();
      queue.log(
        'scheduler',
        `programme idle-paused — no listeners for ${idleAfterMin} min (mounts stay up, resumes on connect)`,
      );
    } else if (action === 'resume') {
      await idleOff();
      // Warm the tts-heavy sidecar (#1579): a cold Chatterbox reload is
      // 30-60s, audible if it lands on the first link after the room fills.
      // Not awaited and never throws — the render path reloads on its own, so
      // this must not delay idleOff() or trip the catch into holding the pause.
      void warmHeavy();
      queue.log(
        'scheduler',
        count !== null && count > 0
          ? 'programme resumed — listener connected'
          : 'programme resumed — idle pause released',
      );
    } else if (action === 'reassert') {
      await idleOn();
    }
  } catch {
    return; // telnet unreachable — keep the current state, retry next tick
  }
  state = next;
  setStreamIdle(next.idle);
}

export function startStreamIdleMonitor() {
  void (async () => {
    // Adopt the gate's actual state: a restart mid-pause must not leave
    // Liquidsoap silent while we believe the programme is live.
    try {
      if (await idleStatus()) {
        state = { idle: true, zeroSince: null };
        setStreamIdle(true);
      }
    } catch {
      /* Liquidsoap not up yet — start live; ticks reconcile from here */
    }
    setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
  })();
}
