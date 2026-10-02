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

// Inject external controls for transition tests; production shares this same
// monitor. The resume callback is supplied by server to avoid an import cycle.
export function createStreamIdleMonitor(overrides: Partial<{
  idleStatus: () => Promise<boolean>;
  idleOn: () => Promise<unknown>;
  idleOff: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
  gatedListenerCount: () => number | null;
  streamSettings: () => { idleWhenEmpty?: boolean; idleAfterMinutes?: number } | undefined;
  setStreamIdle: (idle: boolean) => void;
  warmHeavy: () => Promise<unknown>;
  log: (kind: string, message: string) => void;
  onResume: () => Promise<void>;
}> = {}) {
  const deps = {
    idleStatus, idleOn, idleOff, refresh, gatedListenerCount, setStreamIdle, warmHeavy,
    streamSettings: () => settings.get()?.stream,
    log: (kind: string, message: string) => queue.log(kind, message),
    onResume: async () => {},
    ...overrides,
  };
  let state: IdleState = { idle: false, zeroSince: null };
  let startupReleasePending = false;

  // Read by GET /state so the player can tell "nobody's here" from "broken".
  function isIdle() {
    return state.idle;
  }

  async function tick() {
    const st = deps.streamSettings();
    const enabled = !!st?.idleWhenEmpty;
    const idleAfterMin = Number(st?.idleAfterMinutes) >= 1 ? Number(st?.idleAfterMinutes) : 10;
    // Idle forces a fresh poll (the 15s cadence would add 15s to the wake-up).
    // Always read through gatedListenerCount(), never refresh()'s raw return: one
    // timed-out poll out of ~120 per pause released it (#1256).
    if (state.idle && enabled) await deps.refresh();
    const count = deps.gatedListenerCount();
    const input = {
      enabled,
      count,
      now: Date.now(),
      idleAfterMs: idleAfterMin * 60_000,
    };
    const { state: next, action: plannedAction } = nextIdleState(state, input);
    // An unknown startup gate must fail open in the mixer too. Release it
    // before starting a fresh empty-room grace window, and retry on failure
    // without waiting for the original status read to finish.
    const action = startupReleasePending ? 'resume' : plannedAction;
    try {
      if (action === 'pause') {
        await deps.idleOn();
        deps.log(
          'scheduler',
          `programme idle-paused — no listeners for ${idleAfterMin} min (mounts stay up, resumes on connect)`,
        );
      } else if (action === 'resume') {
        await deps.idleOff();
        // Warm the tts-heavy sidecar (#1579): a cold Chatterbox reload is
        // 30-60s, audible if it lands on the first link after the room fills.
        // Not awaited and never throws — the render path reloads on its own, so
        // this must not delay idleOff() or trip the catch into holding the pause.
        void deps.warmHeavy();
        deps.log(
          'scheduler',
          count !== null && count > 0
            ? 'programme resumed — listener connected'
            : 'programme resumed — idle pause released',
        );
      } else if (action === 'reassert') {
        await deps.idleOn();
      }
    } catch {
      return; // telnet unreachable — keep the current state, retry next tick
    }
    // A forced release overrides the whole transition, not just its command.
    // Start the empty-room clock only after idle_off succeeds, even if retries
    // (or the command itself) lasted longer than the previous grace window.
    state = startupReleasePending
      ? nextIdleState({ idle: false, zeroSince: null }, { ...input, now: Date.now() }).state
      : next;
    startupReleasePending = false;
    deps.setStreamIdle(state.idle);
    if (action === 'resume') {
      // Playback is already live. Catalogue failures must not roll the idle
      // state back, delay the frozen track, or prevent later monitor ticks.
      void Promise.resolve().then(() => deps.onResume()).catch(err =>
        deps.log('error', `Auto-playlist refresh after resume failed: ${err.message}`));
    }
  }

  async function initialize(timeoutMs = 2500) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the whole operation, including DNS/connect and a peer that never
      // finishes a response. A late result is not allowed to re-adopt a pause.
      const idle = await Promise.race([
        deps.idleStatus(),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => reject(new Error('idle status timeout')), timeoutMs);
        }),
      ]);
      state = { idle, zeroSince: null };
      startupReleasePending = false;
      deps.setStreamIdle(idle);
    } catch {
      // The surviving mixer may still be paused. Boot stays bounded and
      // logically live; ticks retry idle_off until the physical gate agrees.
      state = { idle: false, zeroSince: null };
      startupReleasePending = true;
      deps.setStreamIdle(false);
    } finally {
      clearTimeout(timer);
    }
  }

  return { isIdle, tick, initialize };
}

let monitor = createStreamIdleMonitor();
export function isIdle() {
  return monitor.isIdle();
}

export async function startStreamIdleMonitor(onResume: () => Promise<void> = async () => {}) {
  monitor = createStreamIdleMonitor({ onResume });
  await monitor.initialize();
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    monitor.tick().catch(() => {}).finally(() => { ticking = false; });
  }, TICK_MS);
}
