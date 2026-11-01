// When the app reloads the live stream (#2114, #1936). A reload is not free: the
// new connection gets Icecast's burst-on-connect again, ~22s of audio the
// listener may already have heard, and a reload that overlaps another counts
// as a second listener at the station. So no automatic trigger reloads audio
// the native player is still playing. The watchdog, the churn guard and the
// error backoff each read the native media clock first (TrackPlayer.getProgress),
// as the web player's advancingSince() does (#1232). A regained link brings a
// pending check forward, so it reads the clock too; with none pending it
// reloads at once, and usePlayer reports a regained link only while the UI
// isn't showing playback. A native state event cannot decide a reload alone:
// Buffering is an instant, not a verdict, and the last state JS hears can be
// stale (SwiftAudioEx's `.ready` is a check-then-set that can land after
// `.playing`). An iOS audio interruption (a call, Siri) stops AVPlayer with no
// state event at all, so no check or automatic reload runs while RemoteDuck
// says one lasts (onDuck).
//
// A listener's own loads come through here too: a tune-in, a retune, and a
// Play from the lock screen, a headset, CarPlay or Bluetooth while the app's
// player is mounted (#2139, src/lib/remote-play.ts). Those always load, with
// no clock check, and queue behind a reload in flight rather than overlap it.
//
// Every load is checked, whether or not the new item reports a state. iOS
// drops a state write equal to the current one (SwiftAudioEx), so a reload
// made while the item is still Loading emits nothing (#2143). An automatic
// reload counts as a failure until its item has stayed up, so a station that
// hangs without erroring is retried on the error backoff's curve, never more
// often than WATCHDOG_MS.
//
// A Playing alone proves little. Something in front of Icecast can cut every
// connection a moment into the audio (a proxy that stops after so many bytes),
// and when Playing cleared the count for good each such item started the curve
// over: this module ran at about 35 reloads a minute on a 1s cut and 60 on a
// 0.25s cut, on fake timers. So the reset on an item's first Playing is provisional.
// An item that stops within STAYED_UP_MS of it takes the reset back, and the
// reload that replaces it counts one more.
//
// What is judged is the moment the item stopped, the first Buffering, error or
// end since it last played, never the reload. The watchdog fires WATCHDOG_MS
// after a stall begins, so "how long since Playing" at the reload would call
// every stalled item a success, and a stream that stalls a second in would hold
// the curve at its floor as a closing one did. An iOS cut can also report
// Buffering before its end. Buffering is still only an instant: a Playing that
// ends the stall clears the stop, though not the item's clock, which is
// wall-clock from its first Playing, never the media clock.
//
// A stall's count stays out of a refused load's way. A cut closes the item, but
// a source that flaps stalls it, and then the mount refuses the reload. If the
// count reached that refusal, a listener on a source 3s up and 1s down would
// climb to a minute of silence (2% sound against 22%, on fake timers). So the
// reload of a stalled item keeps the count for the next item that plays, and a
// load that never plays starts its own curve from the first step. A long run of
// stalls with no refusal between them still grows, which is what a stream that
// stalls a moment in looks like, and it can't be told from a flap whose reloads
// all land while the source is up.
//
// A hold counts as that item's Playing, dated from the sample the clock kept
// pace from. JS can miss the real one (a stale Ready or Error is all it hears),
// and then a hold is the only sign the item played (#2143), so it can't simply
// stop resetting; a window as long as the watchdog's stands at once. It also
// clears a stop, so a stale Error doesn't count against audio still playing.
//
// A reload that follows an item that played waits at most PLAYED_MAX_MS. That
// item proved the station is up, so only load argues for longer, and 16s holds
// a 1s cut to 3.5 reloads a minute. It also bounds the price of the rule: an
// item that dies just after a long outage waits 16s, not the outage's minute.
// The count keeps climbing, so a load that never plays takes the full curve.
//
// Normal recovery waits what it always did. The first failure after an item
// stayed up takes the curve's first step. A regained link and a listener's own
// load start the count over, and the churn guard's reload never waits. An
// interruption is never a stop, since it freezes the clock on purpose, and the
// check after it fires at least WATCHDOG_MS after any Playing.
//
// One reload runs at a time. Every timer and async continuation carries the
// listening session and reload attempt it was armed in, and does nothing once
// either has moved on, so a tune-out, a retune or a newer reload leaves it
// inert. usePlayer drives this; the decisions all live here.

// How long a stall (Buffering/Loading), or a new load, may run before the media
// clock is checked. The first stall of an episode sets the deadline and later
// ones never push it back, so a storm of state flaps cannot postpone the check.
// After automatic reloads that failed it waits the error backoff instead, once
// that is the longer (watchdogDelay, stallDelay). WATCHDOG_MS is always the floor.
export const WATCHDOG_MS = 6000;

// Reconnect backoff: doubles from 500ms to a 60s ceiling.
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 60_000;
// How long after its first Playing an item must still be playing for the reset
// to stand, and the most a reload waits once its item reached Playing.
export const STAYED_UP_MS = 4000;
export const PLAYED_MAX_MS = 16_000;

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

/** How long a new load waits for its clock check: WATCHDOG_MS, or the backoff
 *  once failed reloads have pushed it past that. */
export function watchdogDelay(retries: number): number {
  return Math.max(WATCHDOG_MS, retryDelay(retries));
}

export interface Backoff {
  /** Automatic reloads that failed in a row. An item that played clears it. */
  retries: number;
  /** What that cleared, kept until the item is judged, and what a stalled item
   *  leaves for the next item that plays. */
  heldRetries: number;
  /** When this item first played; null until it does. */
  playingSince: number | null;
  /** When it stopped, if it hasn't played since. */
  stoppedAt: number | null;
}

export const NO_BACKOFF: Backoff = { retries: 0, heldRetries: 0, playingSince: null, stoppedAt: null };

/** The item is playing, and has been since `at`. Only the first sign starts its
 *  clock, or a slow link's Playing after each stall would look like a new item. */
export function itemPlaying(backoff: Backoff, at: number): Backoff {
  if (backoff.playingSince !== null) return { ...backoff, stoppedAt: null };
  const heldRetries = Math.max(backoff.retries, backoff.heldRetries);
  return { retries: 0, heldRetries, playingSince: at, stoppedAt: null };
}

/** A stall or a failure. The first stop since the item last played is the one
 *  judged, so an error that follows a stall can't move it past the line. */
export function itemStopped(backoff: Backoff, at: number): Backoff {
  if (backoff.playingSince === null || backoff.stoppedAt !== null) return backoff;
  return { ...backoff, stoppedAt: at };
}

/** The count this item leaves if it fails now. A clock stepped backwards reads
 *  as early, never as an item that stayed up. */
function failures({ retries, heldRetries, playingSince, stoppedAt }: Backoff, now: number): number {
  if (playingSince === null) return retries;
  return (stoppedAt ?? now) - playingSince < STAYED_UP_MS ? heldRetries : 0;
}

/** How long an error waits before its reload. */
export function failureDelay(backoff: Backoff, now: number): number {
  const delay = retryDelay(failures(backoff, now));
  return backoff.playingSince === null ? delay : Math.min(delay, PLAYED_MAX_MS);
}

/** How long a stall waits for its clock check. */
export function stallDelay(backoff: Backoff, now: number): number {
  return Math.max(WATCHDOG_MS, failureDelay(backoff, now));
}

/** An automatic reload replaces the item: one failure more than it leaves.
 *  `failed` is an item that reported its own failure. One that played and only
 *  stalled keeps the count from the new load, which may yet be refused. */
export function itemReplaced(backoff: Backoff, now: number, failed: boolean): Backoff {
  const count = failures(backoff, now) + 1;
  if (backoff.playingSince !== null && !failed) return { ...NO_BACKOFF, retries: 1, heldRetries: count };
  return { ...NO_BACKOFF, retries: count };
}

function describe(from: ProgressSample | null, to: ProgressSample | null): string {
  if (!from || !to) return 'media clock unknown';
  const p = pace(from, to);
  return `pos ${from.position.toFixed(1)}→${to.position.toFixed(1)}s over ${(
    (to.at - from.at) / 1000
  ).toFixed(1)}s, pace ${p === null ? '—' : p.toFixed(2)}`;
}

export type ReloadReason = 'tune' | 'remote' | 'format' | 'watchdog' | 'error' | 'link' | 'churn';
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
  // Automatic reloads, each a failure until its item stays up; drives the backoff.
  private backoff = NO_BACKOFF;
  // The episode whose deadline an error's backoff has already set.
  private erroredEpisode = -1;
  private reloading = false;
  // Between an interruption's RemoteDuck pause and its end, or the next sign
  // the listener wants audio (a tune-in, a remote Play, a Playing, a load
  // made outside this module).
  private interrupted = false;
  // An explicit reload (tune, remote, format) asked for while one was in flight.
  private queued: ReloadReason | null = null;
  private lastState: string | null = null;

  constructor(deps: StreamRecoveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** A fresh tune-in: a new session that loads the stream. `remote` is a Play
   *  from the lock screen, a headset, CarPlay or Bluetooth, which loads the
   *  same way: the listener asking for audio, so it reloads even over a
   *  stream that plays, and the backoff starts over. */
  tuneIn(reason: 'tune' | 'remote' = 'tune'): void {
    this.begin();
    void this.reload(reason, null, true);
  }

  /** Playback this hook didn't start (service.ts loaded it while the player
   *  wasn't mounted): watch it, no reload. */
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
        this.backoff = itemPlaying(this.backoff, this.now());
        // Audio is back, whether or not an interruption's end was reported.
        this.interrupted = false;
        return;
      case 'buffering':
      case 'loading':
        // A new item this module didn't load is the listener asking for audio
        // again (a load made outside it), so like a tune-in it ends an
        // interruption whose end iOS never reported.
        if (state === 'loading' && !this.reloading) this.interrupted = false;
        // Only stalls out of Playing count. Loading always means a new item (a
        // tune-in or reload, both platforms), never a mid-stream stall.
        if (prev === 'playing' && state === 'buffering') this.recordFlap();
        this.noteStop();
        this.arm('watchdog', stallDelay(this.backoff, this.now()));
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
   *  to the item being replaced; the new load arms a check of its own. */
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
      this.backoff = { ...this.backoff, stoppedAt: null };
    } else if (was) {
      this.deps.log(`interruption over${paused ? ', left paused' : ', resumed: checking the clock'}`);
      if (!paused) this.arm('watchdog', watchdogDelay(this.backoff.retries));
    }
  }

  /** The device regained a network link while the UI isn't showing playback:
   *  check now rather than wait out the pending check, or with none pending,
   *  reload now. */
  linkRegained(): void {
    this.backoff = NO_BACKOFF;
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
    this.backoff = NO_BACKOFF;
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
  // every load arms a watchdog of its own, and the error, not that, says when
  // to retry. Once per episode, which keeps the deadline bounded, so
  // PlaybackError and State.Error, which arrive as a pair, set it once. The
  // reload the check makes counts the failure, as a stalled load's does.
  private armRetry(): void {
    this.noteStop();
    const replace = this.erroredEpisode !== this.episode;
    if (this.arm('error', failureDelay(this.backoff, this.now()), undefined, replace)) {
      this.erroredEpisode = this.episode;
    }
  }

  private noteStop(): void {
    if (!this.interrupted) this.backoff = itemStopped(this.backoff, this.now());
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
    if (from && to && keptPace(from, to, WATCHDOG_MIN_PACE)) {
      this.deps.log(`hold [${check.reason}] state=${state}: ${describe(from, to)} — playing, not reloading`);
      this.backoff = itemPlaying(this.backoff, from.at);
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

  // `explicit` is a load the listener asked for (tune, remote, format).
  private async reload(reason: ReloadReason, detail: string | null, explicit = false): Promise<void> {
    if (!this.active) return;
    // A tune or retune still runs during an interruption; nothing automatic
    // does (a churn trip or a regained link), since the new item can't play.
    if (this.interrupted && !explicit) {
      this.deps.log(`reload [${reason}] skipped: audio interrupted`);
      return;
    }
    if (this.reloading) {
      if (explicit) this.queued = reason;
      this.deps.log(`reload [${reason}] skipped: one in flight${explicit ? ', queued after it' : ''}`);
      return;
    }
    this.reloading = true;
    this.endEpisode();
    this.flaps = [];
    // A failure until its item stays up. The listener's own load is none.
    this.backoff = explicit ? NO_BACKOFF : itemReplaced(this.backoff, this.now(), reason === 'error');
    const session = this.session;
    this.attempt += 1;
    this.deps.log(
      `reload [${reason}] #${this.attempt} state=${this.lastState ?? 'none'}${detail ? `: ${detail}` : ''}${
        explicit ? '' : ` (failure ${Math.max(this.backoff.retries, this.backoff.heldRetries)})`
      }`,
    );
    try {
      await this.deps.reload(reason);
      // Check the new item even if it reports nothing: on iOS a reload made
      // while the old item was Loading emits no new Loading (#2143). Its own
      // Loading or Buffering keeps whichever deadline is earlier.
      if (session === this.session) this.arm('watchdog', watchdogDelay(this.backoff.retries));
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
