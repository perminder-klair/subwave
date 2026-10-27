// Pause the music chain after an empty-room timeout while keeping mounts available. Unknown
// listener counts resume playback; telnet failures retain the current state and retry. Adopt
// the mixer gate on controller boot. #1256.

import * as settings from '../settings.js';
import { warmHeavy } from '../audio/ttsHeavyClient.js';
import { gatedListenerCount, peekListeners, refresh, setStreamIdle } from './listeners.js';
import { idleOn, idleOff, idleStatus } from './liquidsoap-control.js';
import { queue } from './queue.js';
import { nextIdleState, type IdleState } from './stream-idle-pure.js';
import { showKeyAt } from './show-boundary.js';
import { programmeShowKey } from './resume-show.js';

// One tick every 5s. Live: read the 15s monitor's cached count. Idle: force a
// fresh poll. Only committed polls (this tick's, the 15s monitor's, a
// request's) count toward the fail-open budget, so it keeps this cadence:
// polling faster would shorten the ~20s an outage needs to release the pause
// (#1256).
const TICK_MS = 5000;

// While idle, a wake probe reads Icecast every second and runs the tick as soon
// as it sees a listener (#2072). It is positive evidence only: it commits
// nothing (listeners.peekListeners), so a failed or empty probe changes
// nothing, and the tick still decides from its own committed poll. A new
// listener waits ~1s instead of ~5s, on top of the burst-on-connect, which
// while idle is bufferSeconds of silence (docs/internals/broadcast.md). A probe
// that times out stops probing for one tick, leaving a slow Icecast to the tick.
const WAKE_PROBE_MS = 1000;

// Inject external controls for transition tests; production shares this same
// monitor. The resume callback is supplied by server to avoid an import cycle.
export type ResumeInfo = {
  /** The track frozen by the pause started under a different show than the one on air now. */
  showChanged: boolean;
};

export function createStreamIdleMonitor(overrides: Partial<{
  idleStatus: () => Promise<boolean>;
  idleOn: () => Promise<unknown>;
  idleOff: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
  gatedListenerCount: () => number | null;
  peekListeners: () => Promise<number | null>;
  streamSettings: () => { idleWhenEmpty?: boolean; idleAfterMinutes?: number } | undefined;
  setStreamIdle: (idle: boolean) => void;
  warmHeavy: () => Promise<unknown>;
  log: (kind: string, message: string) => void;
  showKeyAt: (ms: number) => string;
  frozenTrackShowKey: () => string | null;
  onResume: (info: ResumeInfo) => Promise<void>;
}> = {}) {
  const deps = {
    idleStatus, idleOn, idleOff, refresh, gatedListenerCount, peekListeners, setStreamIdle, warmHeavy,
    streamSettings: () => settings.get()?.stream,
    log: (kind: string, message: string) => queue.log(kind, message),
    showKeyAt,
    // queue.json keeps `current` across a controller restart, so this still
    // answers for a pause the previous process started. A queued pick carries
    // the show it was chosen for; a track the fallback started does not, and
    // is judged by when it started.
    frozenTrackShowKey: () => programmeShowKey(queue.current),
    onResume: async (_info: ResumeInfo) => {},
    ...overrides,
  };
  let state: IdleState = { idle: false, zeroSince: null };
  let startupReleasePending = false;

  // The track frozen by the pause was chosen for one show; hours later another
  // can be on air. Asked of the track rather than remembered from the pause,
  // so a restart mid-pause does not lose it. The same show again after others
  // (A, B, A) counts as no change: its music still fits.
  function frozenTrackIsFromAnotherShow() {
    const key = deps.frozenTrackShowKey();
    return key !== null && key !== deps.showKeyAt(Date.now());
  }

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
    // An unknown startup gate needs releasing, but proves no programme was paused.
    const showChanged = action === 'resume' && state.idle && frozenTrackIsFromAnotherShow();
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
      // Playback is already live. Failures here must not roll the idle state
      // back, delay the frozen track, or prevent later monitor ticks.
      void Promise.resolve()
        .then(() => deps.onResume({ showChanged }))
        .catch(err => deps.log('error', `Work after resume failed: ${err.message}`));
    }
  }

  // True when the room may have filled since the last tick. No I/O while live
  // or with pausing off; the caller brings the tick forward on true.
  async function wakeProbe() {
    if (!state.idle || !deps.streamSettings()?.idleWhenEmpty) return false;
    const seen = await deps.peekListeners();
    return seen !== null && seen > 0;
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

  return { isIdle, tick, wakeProbe, initialize };
}

// Drive both cadences. The probe keeps its own guard so a slow one never costs
// the tick its slot (listeners.ts holds the tick's poll until a probe in flight
// is done, at most its 1s deadline), and it stands aside while a tick is
// already polling.
export function scheduleStreamIdleMonitor(
  m: Pick<ReturnType<typeof createStreamIdleMonitor>, 'tick' | 'wakeProbe'>,
  every: (run: () => void, ms: number) => unknown = setInterval,
) {
  let ticking = false;
  let probing = false;
  const runTick = () => {
    if (ticking) return;
    ticking = true;
    m.tick().catch(() => {}).finally(() => { ticking = false; });
  };
  every(runTick, TICK_MS);
  every(() => {
    if (probing || ticking) return;
    probing = true;
    m.wakeProbe()
      .then(seen => { if (seen) runTick(); })
      .catch(() => {})
      .finally(() => { probing = false; });
  }, WAKE_PROBE_MS);
}

let monitor = createStreamIdleMonitor();
export function isIdle() {
  return monitor.isIdle();
}

export async function startStreamIdleMonitor(onResume: (info: ResumeInfo) => Promise<void> = async () => {}) {
  monitor = createStreamIdleMonitor({ onResume });
  await monitor.initialize();
  scheduleStreamIdleMonitor(monitor);
}
