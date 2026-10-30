// When the app reloads the live stream (#2114, #1936). A reload is not free: the
// new connection gets Icecast's burst-on-connect again, ~22s of audio the
// listener may already have heard, and a reload that overlaps another counts
// as a second listener at the station. So no automatic trigger reloads audio
// the native player is still playing. The watchdog, the churn guard, the error
// backoff and a regained link each read the native media clock first
// (TrackPlayer.getProgress), as the web player's advancingSince() does (#1232).
// A native state event cannot decide it alone: Buffering is an instant, not a
// verdict, and the last state JS hears can be stale (SwiftAudioEx's `.ready` is
// a check-then-set that can land after `.playing`). An iOS audio interruption
// (a call, Siri) stops AVPlayer with no state event at all, so no check or
// automatic reload runs while RemoteDuck says one lasts (onDuck).
//
// One reload runs at a time. Every timer and async continuation carries the
// listening session and reload attempt it was armed in, and does nothing once
// either has moved on, so a tune-out, a retune or a newer reload leaves it
// inert. usePlayer drives this; the decisions all live here.

// How long a stall (Buffering/Loading) may run before the media clock is
// checked. The first stall of an episode sets the deadline and later ones never
// push it back, so a storm of state flaps cannot postpone the check.
export const WATCHDOG_MS = 6000;

// Error-path reconnect backoff: doubles from 500ms to a 60s ceiling.
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 60_000;

// Buffering-churn guard (#1252). On a throttled network the native player
// retries the same URL internally every ~9s forever — Buffering→Playing flaps
// too short for the watchdog and with no PlaybackError, each abandoned
// connection lingering at Icecast as a phantom listener. Past CHURN_LIMIT
// entries into Buffering from Playing inside CHURN_WINDOW_MS, force a full
// reload to release the wedged native source. Any reload starts the window
// over: it has already replaced the source, and the media clock restarts with
// the new item, so positions either side of it don't compare.
export const CHURN_WINDOW_MS = 60_000;
export const CHURN_LIMIT = 4;

// Pace: media seconds played per wall-clock second. A stall window passes at
// half pace, because the listener heard most of it and a Playing event that
// never reached JS is likelier than a dead stream. The churn window must hold
// 0.8: a starved link (#1252) can't sustain that, while the brief flaps of a
// healthy one (#2114) each cost it only a moment. A clock that stood still or
// went backwards (the native player restarted its own source) never passes.
export const WATCHDOG_MIN_PACE = 0.5;
export const CHURN_MIN_PACE = 0.8;

export interface ProgressSample {
  /** Wall clock, ms. */
  at: number;
  /** Native media clock, seconds. */
  position: number;
}

/** Media seconds per wall second between two samples; null when unmeasurable. */
export function pace(from: ProgressSample | null, to: ProgressSample | null): number | null {
  if (!from || !to) return null;
  const wallS = (to.at - from.at) / 1000;
  return wallS > 0 ? (to.position - from.position) / wallS : null;
}

/** Did the media clock move forward between the samples, at no less than
 *  `minPace`? An unknown sample says no, which falls back to reloading. */
export function keptPace(
  from: ProgressSample | null,
  to: ProgressSample | null,
  minPace: number,
): boolean {
  if (!from || !to) return false;
  const advancedS = to.position - from.position;
  return advancedS > 0 && advancedS >= (minPace * (to.at - from.at)) / 1000;
}

export function retryDelay(retries: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** retries, RECONNECT_MAX_MS);
}

function describe(from: ProgressSample | null, to: ProgressSample | null): string {
  if (!from || !to) return 'media clock unknown';
  const p = pace(from, to);
  return `pos ${from.position.toFixed(1)}→${to.position.toFixed(1)}s over ${(
    (to.at - from.at) / 1000
  ).toFixed(1)}s, pace ${p === null ? '—' : p.toFixed(2)}`;
}

export type ReloadReason = 'tune' | 'format' | 'watchdog' | 'error' | 'link' | 'churn';
type CheckReason = 'watchdog' | 'error' | 'link';

export interface StreamRecoveryDeps {
  /** The native media clock in seconds (TrackPlayer.getProgress().position).
   *  A rejection or a non-finite value reads as unknown. */
  position(): Promise<number>;
  /** Load the stream afresh. A throw schedules a backoff retry, since it may
   *  not surface as a PlaybackError event. */
  reload(reason: ReloadReason): Promise<void>;
  /** The clock kept pace while the native state said otherwise: show playing. */
  onAdvancing(): void;
  log(msg: string): void;
  now?: () => number;
}

interface PendingCheck {
  token: number;
  reason: CheckReason;
  due: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Flap {
  at: number;
  position: number | null;
}

export class StreamRecovery {
  private readonly deps: StreamRecoveryDeps;
  private readonly now: () => number;
  private active = false;
  // Bumped by every tune-in, adopt and tune-out.
  private session = 0;
  // Bumped by every reload.
  private attempt = 0;
  // Bumped whenever the pending check and its baseline stop applying.
  private episode = 0;
  private token = 0;
  private check: PendingCheck | null = null;
  private baseline: ProgressSample | null = null;
  // Recent entries into Buffering from Playing. Not reset on Playing: brief
  // recoveries between flaps are what the churn guard exists to see through.
  private flaps: Flap[] = [];
  // Consecutive failures since the last sign of playback; drives the backoff.
  private retries = 0;
  // The episode whose deadline an error's backoff has already set.
  private erroredEpisode = -1;
  private reloading = false;
  // Between an interruption's RemoteDuck pause and its end, or the next sign
  // the listener wants audio (a tune-in, a Playing, a load from service.ts).
  private interrupted = false;
  // An explicit reload (tune, format) asked for while one was in flight.
  private queued: ReloadReason | null = null;
  private lastState: string | null = null;

  constructor(deps: StreamRecoveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** A fresh tune-in: a new session that loads the stream. */
  tuneIn(): void {
    this.begin();
    void this.reload('tune', null, true);
  }

  /** Playback this hook didn't start (a lock-screen Play): watch it, no reload. */
  adopt(): void {
    this.begin();
  }

  /** A tune-out of any kind. Everything pending goes inert. */
  tuneOut(): void {
    this.session += 1;
    this.active = false;
    this.reset();
  }

  /** Every native PlaybackState, tuned in or not, so the churn guard knows
   *  which state a stall came out of. */
  onState(state: string): void {
    const prev = this.lastState;
    this.lastState = state;
    if (!this.active) return;
    switch (state) {
      case 'playing':
        this.endEpisode();
        this.retries = 0;
        // Audio is back, whether or not an interruption's end was reported.
        this.interrupted = false;
        return;
      case 'buffering':
      case 'loading':
        // A new item this module didn't load is the listener asking for audio
        // again (a lock-screen or headset Play reloads through service.ts), so
        // like a tune-in it ends an interruption whose end iOS never reported.
        if (state === 'loading' && !this.reloading) this.interrupted = false;
        // Only stalls out of Playing count. Loading always means a new item (a
        // tune-in or reload, both platforms), never a mid-stream stall.
        if (prev === 'playing' && state === 'buffering') this.recordFlap();
        this.arm('watchdog', WATCHDOG_MS);
        return;
      case 'error':
      case 'ended':
      case 'stopped':
        // A live stream shouldn't "end"; if it does while tuned in, reconnect.
        this.onError();
        return;
    }
  }

  /** A PlaybackError event, or a failed state. One reported mid-reload belongs
   *  to the item being replaced; the new item's own Loading arms the watchdog. */
  onError(): void {
    if (this.active && !this.reloading) this.armRetry();
  }

  /** RNTP's RemoteDuck: on iOS, an audio-session interruption (a call, Siri,
   *  an alarm). RNTP pauses nothing for it, so AVPlayer stops with no state
   *  event and the clock stands still for as long as it lasts. A check would
   *  reload, and a new item can't play during it either, so it would be
   *  reloaded every WATCHDOG_MS until the call ended: nothing is armed until
   *  it ends. `paused: false` is the end with playback resumed by RNTP
   *  (autoHandleInterruptions), and a stall that outlived it sends no new
   *  state, so the clock is checked again. `permanent` is an end iOS wants
   *  left paused. Android doesn't emit it here: ExoPlayer takes audio focus. */
  onDuck(paused: boolean, permanent = false): void {
    const was = this.interrupted;
    this.interrupted = paused && !permanent;
    if (this.interrupted) {
      this.deps.log('interrupted: no checks or reloads until it ends');
      this.endEpisode();
      // The clock stands still on purpose, so stalls either side don't compare.
      this.flaps = [];
    } else if (was) {
      this.deps.log(`interruption over${paused ? ', left paused' : ', resumed: checking the clock'}`);
      if (!paused) this.arm('watchdog', WATCHDOG_MS);
    }
  }

  /** The device regained a network link while the UI isn't showing playback:
   *  check now rather than wait out the pending check. */
  linkRegained(): void {
    this.retries = 0;
    if (!this.active) return;
    const check = this.check;
    if (!check) {
      void this.reload('link', null);
      return;
    }
    clearTimeout(check.timer);
    check.reason = 'link';
    void this.fire(check.token);
  }

  /** The listener picked another mount: reload onto it, after any reload in flight. */
  retune(): void {
    this.retries = 0;
    void this.reload('format', null, true);
  }

  private begin(): void {
    this.session += 1;
    this.active = true;
    // The listener asking for audio. iOS doesn't promise an interruption's
    // end, and a missed one mustn't leave the watchdog off for good.
    this.interrupted = false;
    this.reset();
  }

  private reset(): void {
    this.endEpisode();
    this.flaps = [];
    this.retries = 0;
    this.queued = null;
  }

  private endEpisode(): void {
    if (this.check) clearTimeout(this.check.timer);
    this.check = null;
    this.baseline = null;
    this.episode += 1;
  }

  private async sample(): Promise<ProgressSample | null> {
    try {
      const position = await this.deps.position();
      return Number.isFinite(position) ? { at: this.now(), position } : null;
    } catch {
      return null;
    }
  }

  // An error is a verdict on the attempt where a stall is only an instant, so
  // its backoff replaces the pending check even when that would fire sooner:
  // every load's own Loading arms the watchdog, and without this a station that
  // keeps failing would be retried at the watchdog's pace, never backing off
  // past it. Once per episode, which keeps the deadline bounded and counts
  // PlaybackError and State.Error, which arrive as a pair, as one failure.
  private armRetry(): void {
    const replace = this.erroredEpisode !== this.episode;
    if (this.arm('error', retryDelay(this.retries), undefined, replace)) {
      this.retries += 1;
      this.erroredEpisode = this.episode;
    }
  }

  /** Schedule a media-clock check. An earlier pending check stands unless
   *  `replace`. Returns whether this call set the deadline. */
  private arm(reason: CheckReason, delay: number, baseline?: ProgressSample, replace = false): boolean {
    if (!this.active || this.interrupted) return false;
    const due = this.now() + delay;
    if (this.check && this.check.due <= due && !replace) return false;
    if (this.check) {
      // A new deadline for the same episode; its baseline still applies.
      clearTimeout(this.check.timer);
    } else {
      this.episode += 1;
      this.baseline = baseline ?? null;
      if (!baseline) {
        const episode = this.episode;
        void this.sample().then((s) => {
          if (episode === this.episode) this.baseline = s;
        });
      }
    }
    const token = ++this.token;
    this.check = {
      token,
      reason,
      due,
      timer: setTimeout(() => { void this.fire(token); }, delay),
    };
    return true;
  }

  private async fire(token: number): Promise<void> {
    if (this.check?.token !== token) return;
    const from = this.baseline;
    const to = await this.sample();
    // The check stays pending through the read, so a stall landing meanwhile
    // can't start a later one; anything that ended the episode replaced it.
    const check = this.check;
    if (!check || check.token !== token) return;
    this.check = null;
    const state = this.lastState ?? 'none';
    if (to && keptPace(from, to, WATCHDOG_MIN_PACE)) {
      this.deps.log(`hold [${check.reason}] state=${state}: ${describe(from, to)} — playing, not reloading`);
      this.retries = 0;
      this.deps.onAdvancing();
      // Keep watching only while the native state still says stalled. From any
      // other state (a stale Ready or Error) a later stall emits Buffering and
      // arms a check of its own, and a check left pending would read a clock
      // that an iOS interruption froze without an event.
      if (state === 'buffering' || state === 'loading') this.arm('watchdog', WATCHDOG_MS, to);
      return;
    }
    void this.reload(check.reason, describe(from, to));
  }

  private recordFlap(): void {
    const at = this.now();
    const flap: Flap = { at, position: null };
    this.flaps = this.flaps.filter((f) => at - f.at < CHURN_WINDOW_MS);
    this.flaps.push(flap);
    const first = this.flaps[0];
    const tripped = this.flaps.length >= CHURN_LIMIT;
    const { session, attempt } = this;
    // Read straight after the stall began, while the clock is frozen at it.
    void this.sample().then((s) => {
      if (s) flap.position = s.position;
      if (!tripped || session !== this.session || attempt !== this.attempt || !this.active) return;
      const from = first.position === null ? null : { at: first.at, position: first.position };
      const to = flap.position === null ? null : { at, position: flap.position };
      const detail = `${this.flaps.length} stalls inside ${CHURN_WINDOW_MS / 1000}s, ${describe(from, to)}`;
      if (keptPace(from, to, CHURN_MIN_PACE)) {
        this.deps.log(`hold [churn] ${detail} — kept pace, not reloading`);
        return;
      }
      void this.reload('churn', detail);
    });
  }

  private async reload(reason: ReloadReason, detail: string | null, queueIfBusy = false): Promise<void> {
    if (!this.active) return;
    // A tune or retune still runs during an interruption; nothing automatic
    // does (a churn trip or a regained link), since the new item can't play.
    if (this.interrupted && !queueIfBusy) {
      this.deps.log(`reload [${reason}] skipped: audio interrupted`);
      return;
    }
    if (this.reloading) {
      if (queueIfBusy) this.queued = reason;
      this.deps.log(`reload [${reason}] skipped: one in flight${queueIfBusy ? ', queued after it' : ''}`);
      return;
    }
    this.reloading = true;
    this.endEpisode();
    this.flaps = [];
    const session = this.session;
    this.attempt += 1;
    this.deps.log(
      `reload [${reason}] #${this.attempt} state=${this.lastState ?? 'none'}${detail ? `: ${detail}` : ''}`,
    );
    try {
      await this.deps.reload(reason);
    } catch {
      if (session === this.session) this.armRetry();
    } finally {
      this.reloading = false;
      const next = this.queued;
      this.queued = null;
      if (next) void this.reload(next, null, true);
    }
  }
}
