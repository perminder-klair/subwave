// Stream idle monitor — pause the programme while the room is empty.
//
// When settings.stream.idleWhenEmpty is on and Icecast has counted zero
// listeners for idleAfterMinutes, flip radio.liq's idle gate (telnet
// idle_on): the Icecast mounts stay up serving silence, but the music chain
// stops being pulled — no track decode, no Navidrome downloads — frozen
// mid-track. Because the mounts never disappear, any client (VLC, Sonos, the
// web player) connects normally while idle; this monitor polls the listener
// count every tick during the pause and resumes the programme (idle_off)
// within seconds of the first connection, exactly where it froze.
//
// Contrast POST /stream-stop (stream_off), which tears the mounts down and
// 404s new listeners — that's the operator's hard off-air switch; this is
// the automatic power-save.
//
// Fail-open like djCallsAllowed: an unknown count (Icecast unreachable) can
// never hold the station silent — an unobservable room resumes. Telnet
// failures keep the current state and retry next tick. Idle state is not
// persisted; a mixer restart always comes back live, and the monitor
// re-asserts idle_on (idempotent) on its next tick while the room stays
// empty. On controller boot the gate's state is adopted from Liquidsoap
// (idle_status) so a controller restart mid-pause doesn't strand the flag.
//
// The transition logic lives in the pure nextIdleState()
// (stream-idle-pure.ts) so the regression-critical branching (fail-open,
// re-assert, the empty-clock reset) is unit-pinned in
// scripts/stream-idle.test.ts.

import * as settings from '../settings.js';
import { getListenerCount, refresh, setStreamIdle } from './listeners.js';
import { idleOn, idleOff, idleStatus } from './liquidsoap-control.js';
import { queue } from './queue.js';
import { nextIdleState, type IdleState } from './stream-idle-pure.js';

// One tick every 5s: while live it just reads the 15s monitor's cached count
// (entering idle is not latency-sensitive); while idle it forces a fresh
// Icecast poll, so a new listener waits ≤ ~5s of silence before the music
// resumes.
const TICK_MS = 5000;

let state: IdleState = { idle: false, zeroSince: null };

// True while the programme is idle-paused. Read by GET /state so the player
// UI can tell "silence because nobody's here" from "stream is broken".
export function isIdle() {
  return state.idle;
}

async function tick() {
  const st = settings.get()?.stream;
  const enabled = !!st?.idleWhenEmpty;
  const idleAfterMin = Number(st?.idleAfterMinutes) >= 1 ? Number(st?.idleAfterMinutes) : 10;
  // While idle, force a fresh Icecast poll — the 15s monitor cadence would
  // add up to 15s to the wake-up. While live, the cached count is plenty.
  const count = state.idle && enabled ? await refresh() : getListenerCount();
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
    // Adopt the gate's actual state: a controller restart mid-pause must not
    // leave Liquidsoap silent while we believe the programme is live.
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
