// Pause the music chain after an empty-room timeout while keeping mounts available. Unknown
// listener counts resume playback; telnet failures retain the current state and retry. Adopt
// the mixer gate on controller boot. #1256. The latest pause is published for the web
// player's idle skip, and only while the MP3 mount is the one it was stamped on (#2072).

import * as settings from '../settings.js';
import { warmHeavy } from '../audio/ttsHeavyClient.js';
import { broadcastMountStart, gatedListenerCount, peekListeners, refresh, setStreamIdle } from './listeners.js';
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

/** The latest idle pause as ages in ms (#2072); `endedMsAgo` is null while it lasts. */
export type IdleWindow = { startedMsAgo: number; endedMsAgo: number | null };

export function createStreamIdleMonitor(overrides: Partial<{
  idleStatus: () => Promise<boolean>;
  idleOn: () => Promise<unknown>;
  idleOff: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
  gatedListenerCount: () => number | null;
  peekListeners: () => Promise<number | null>;
  mountStart: () => string | null;
  streamSettings: () => { idleWhenEmpty?: boolean; idleAfterMinutes?: number } | undefined;
  setStreamIdle: (idle: boolean) => void;
  warmHeavy: () => Promise<unknown>;
  log: (kind: string, message: string) => void;
  showKeyAt: (ms: number) => string;
  frozenTrackShowKey: () => string | null;
  onResume: (info: ResumeInfo) => Promise<void>;
  clock: () => number;
}> = {}) {
  const deps = {
    idleStatus, idleOn, idleOff, refresh, gatedListenerCount, peekListeners, setStreamIdle, warmHeavy,
    mountStart: broadcastMountStart,
    // Monotonic: the pause window is only ever differenced, so a wall-clock
    // step must not move it.
    clock: () => performance.now(),
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
  // The latest pause (#2072). The web player sizes its skip over a woken
  // station's stale silence from it, so each stamp errs toward a skip that is
  // too small: a pause counts from the mixer acknowledging it, a resume from
  // the command going out (the mixer can resume before it answers), an adopted
  // pause from boot, and a startup release that may or may not have ended a
  // pause records nothing. A pause the monitor can no longer vouch for is
  // withdrawn (mountsRestarted), and while the room stays empty the next
  // re-assert the mixer acknowledges starts a fresh one.
  //
  // A pause is tied to the MP3 mount a committed status poll saw before it was
  // stamped (pauseMounts, Icecast's stream_start), and published only while
  // the latest committed poll still sees that mount. New mounts are younger than
  // the buffer, and a restarted mixer boots live, so their burst holds music.
  // This catches restarts the controller did not cause (a crash, `docker
  // restart`, a source reconnect), which leave telnet down for only ~1.9s and
  // so slip between ticks. Unknown never vouches: a failed poll, a missing mount
  // or field, or a pause stamped before the first poll withdraws it. What is
  // left is the time from the new mount appearing to the next committed poll:
  // while paused at most a tick less the ~2s outage (none when a poll lands in
  // it), and once the room has filled the 15s monitor's, which matters for the
  // ~20s an ended pause can still size a skip. A listener whose read lands
  // there still skips on the old pause.
  let pauseWindow: { startedAt: number; endedAt: number | null } | null = null;
  let pauseMounts: string | null = null;
  let restampOnReassert = false;

  function stampPause() {
    pauseWindow = { startedAt: deps.clock(), endedAt: null };
    pauseMounts = deps.mountStart();
  }

  // Withdraws the pause once the mounts it was stamped on are gone or unknown.
  function checkMounts() {
    if (!pauseWindow) return;
    const mounts = deps.mountStart();
    if (mounts === null || mounts !== pauseMounts) mountsRestarted();
  }

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

  // Read by GET /state as ages, never timestamps, so a listener's skewed clock
  // cannot misread them. null before the first pause since boot, and once
  // withdrawn. Checked against the latest committed poll on every read, so a
  // poll from any cadence takes effect before the next tick.
  function idleWindow(): IdleWindow | null {
    checkMounts();
    if (!pauseWindow) return null;
    const now = deps.clock();
    return {
      startedMsAgo: Math.round(now - pauseWindow.startedAt),
      endedMsAgo: pauseWindow.endedAt === null ? null : Math.round(now - pauseWindow.endedAt),
    };
  }

  // The mounts came back new (a mixer restart, the stream started, a changed
  // stream_start), or a command the mixer did not confirm left its gate
  // unknown. New mounts are younger than any buffer and a restarted mixer boots
  // live, so a new listener's burst is no longer the pause the window describes.
  function mountsRestarted() {
    pauseWindow = null;
    restampOnReassert = state.idle;
  }

  async function tick() {
    const st = deps.streamSettings();
    const enabled = !!st?.idleWhenEmpty;
    const idleAfterMin = Number(st?.idleAfterMinutes) >= 1 ? Number(st?.idleAfterMinutes) : 10;
    // Idle forces a fresh poll (the 15s cadence would add 15s to the wake-up).
    // Always read through gatedListenerCount(), never refresh()'s raw return: one
    // timed-out poll out of ~120 per pause released it (#1256).
    if (state.idle && enabled) await deps.refresh();
    checkMounts();
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
        stampPause();
        restampOnReassert = false;
        deps.log(
          'scheduler',
          `programme idle-paused — no listeners for ${idleAfterMin} min (mounts stay up, resumes on connect)`,
        );
      } else if (action === 'resume') {
        // Ended as the command goes out, not when the mixer answers: it can
        // resume first, and a /state read landing in between must not see the
        // pause still running. One the mixer does not confirm is withdrawn
        // below.
        if (state.idle && pauseWindow) pauseWindow.endedAt = deps.clock();
        await deps.idleOff();
        restampOnReassert = false;
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
        if (restampOnReassert) stampPause();
        restampOnReassert = false;
      }
    } catch {
      // Telnet unreachable — keep the current state, retry next tick. Mid-pause
      // the mixer may be restarting (it boots live) or have taken an unanswered
      // idle_off, so the pause is withdrawn.
      if (state.idle) mountsRestarted();
      return;
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
      // An adopted pause began no later than now.
      if (idle) stampPause();
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

  return { isIdle, idleWindow, mountsRestarted, tick, wakeProbe, initialize };
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
export function idleWindow() {
  return monitor.idleWindow();
}
// Called after the controller restarts the mixer or starts the stream, whether
// or not the mixer confirmed it.
export function noteMountsRestarted() {
  monitor.mountsRestarted();
}

export async function startStreamIdleMonitor(onResume: (info: ResumeInfo) => Promise<void> = async () => {}) {
  monitor = createStreamIdleMonitor({ onResume });
  await monitor.initialize();
  scheduleStreamIdleMonitor(monitor);
}
