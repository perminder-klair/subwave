// Plays through a woken station's stale idle silence fast (#2072). The policy
// (how much, and whether at all) is lib/idleSkip.ts; this is the mechanism.
//
// It raises playbackRate rather than setting currentTime. Measured against
// Icecast-KH 2.4.0-kh22 + Liquidsoap 2.4.6 (MP3 192k, 22s buffer) in
// Playwright's engines: 8x took Chromium and Firefox through 17s of silence in
// ~2.2s, on the one connection, with no `waiting`. A forward seek works in
// Chromium (its `seekable` is [0, ∞) and the burst sits in its cache), but
// Firefox clamps it to `seekable`, which grows only as the burst is parsed, and
// it fires seeking/waiting/seeked, which the stall watchdog reads as a stall. A
// rate keeps the media clock continuous, so `advancingSince` still means what
// it says. WebKit's GStreamer build does neither: the seek lands where it
// started, and playbackRate reads 8 while the clock runs at 1x, with no other
// effect. Safari's own media stack could not be measured here.
//
// So the lag actually shed is measured, not assumed: media time gained minus
// wall time spent. An engine that ignores the rate sheds nothing, is put back
// to 1x after STALL_MS, and reports no trim, leaving the listener exactly where
// today's player leaves them.
//
// The stop is a timer, so a check that runs late (a long task, a throttled
// tab) overshoots by its lateness times the rate the gap closes at: the shed's
// rate minus 1, plus 1 more while a wake behind the listener shrinks the
// target. At 8x that is ~8x the lateness, and a woken-moments-ago listener has
// only the 1s music margin. So the last SLOW_SHED_SECONDS go at SLOW_RATE: a
// fast-phase check up to ~185ms late still lands inside it, and a late
// slow-phase check overshoots by at most 2x its lateness (0.3s at 150ms). A
// hidden tab ends the skip outright, since browsers may clamp its timers to 1s.

import { idleSkipSeconds, type IdleSkipInput } from './idleSkip';
import type { IdleWindow } from './types';

export const SKIP_RATE = 8;
/** The last stretch of the shed, in seconds, runs at SLOW_RATE. */
export const SLOW_SHED_SECONDS = 1.5;
export const SLOW_RATE = 2;
// How often the fast-forward re-checks, at most.
const CHECK_MS = 50;
// No measurable progress for this long: the engine is not honouring the rate.
const STALL_MS = 1500;
// Less than this is clock jitter from an engine that ignored the rate.
const MIN_TRIM_MS = 100;
// A /state read that takes longer is abandoned; idleSkipSeconds would have
// shrunk most of the skip away by then anyway.
const READ_TIMEOUT_MS = 8000;
// HTMLMediaElement.HAVE_METADATA / HAVE_FUTURE_DATA.
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

export interface IdleSkipOptions {
  /** The station's advertised stream.bufferSeconds. */
  bufferSeconds: number;
  /** A fresh GET /state; only `streamIdleWindow` is read. */
  readState: (signal: AbortSignal) => Promise<{ streamIdleWindow?: IdleWindow | null }>;
  /** Called once, if any lag was shed, with how much in ms. */
  onTrim: (ms: number) => void;
  now?: () => number;
  /** Whether the page is hidden, and when that changes; `document` by default. */
  page?: PageVisibility | null;
}

export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Start sizing and running the skip for the connection `el` has just opened.
 *  Call right after setting its src. Returns a cancel that restores 1x and
 *  reports nothing; the caller cancels on any new connection, pause or stop. */
export function skipIdleSilence(el: HTMLAudioElement, opts: IdleSkipOptions): () => void {
  const now = opts.now ?? (() => performance.now());
  const page = opts.page !== undefined ? opts.page : typeof document === 'undefined' ? null : document;
  const requestedAt = now();
  const abort = new AbortController();
  const cleanups: (() => void)[] = [];
  let cancelled = false;
  let fast = false;
  // Ends a fast-forward in progress the way `waiting` does.
  let stopFastForward: (() => void) | null = null;

  const once = (event: string, ready: () => boolean) => new Promise<void>(resolve => {
    if (ready()) return resolve();
    const on = () => resolve();
    el.addEventListener(event, on, { once: true });
    cleanups.push(() => el.removeEventListener(event, on));
  });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    abort.abort();
    for (const fn of cleanups.splice(0)) fn();
    if (fast) el.playbackRate = 1;
    fast = false;
  };
  // Hiding the tab ends the run for good: a fast-forward stops with what it has
  // shed, and one not yet started never starts.
  const onVisibility = () => {
    if (page?.hidden) (stopFastForward ?? cancel)();
  };
  if (page) {
    page.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => page.removeEventListener('visibilitychange', onVisibility));
  }

  (async () => {
    await once('loadedmetadata', () => el.readyState >= HAVE_METADATA);
    if (cancelled) return;
    const firstAudioAt = now();
    const readSentAt = now();
    const timer = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
    let idleWindow: IdleWindow | null | undefined;
    try {
      idleWindow = (await opts.readState(abort.signal))?.streamIdleWindow;
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
    if (cancelled) return;
    const at: Omit<IdleSkipInput, 'now'> = {
      bufferSeconds: opts.bufferSeconds, window: idleWindow, requestedAt, firstAudioAt, readSentAt, readReceivedAt: now(),
    };
    const target = () => idleSkipSeconds({ ...at, now: now() });
    if (target() <= 0) return;

    await once('playing', () => !el.paused && el.readyState >= HAVE_FUTURE_DATA);
    if (cancelled || target() <= 0 || page?.hidden) return;
    await fastForward(target);
  })().catch(() => {}).finally(cancel);

  // Shed lag at SKIP_RATE, then SLOW_RATE for the last SLOW_SHED_SECONDS, until
  // the (shrinking) target is met, the buffer runs dry (`waiting`), the tab is
  // hidden, or the engine stops making progress.
  function fastForward(target: () => number) {
    return new Promise<void>(resolve => {
      const t0 = now();
      const ct0 = el.currentTime;
      const shed = () => (el.currentTime - ct0) - (now() - t0) / 1000;
      let best = 0;
      let bestAt = t0;
      let rate = 1;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        el.removeEventListener('waiting', finish);
        if (cancelled) return resolve();
        el.playbackRate = 1;
        fast = false;
        const ms = Math.round(Math.max(0, shed()) * 1000);
        cancel();
        if (ms >= MIN_TRIM_MS) opts.onTrim(ms);
        resolve();
      };
      const check = () => {
        if (cancelled) return finish();
        const done = shed();
        const left = target() - done;
        if (left <= 0) return finish();
        if (done > best + 0.05) {
          best = done;
          bestAt = now();
        } else if (now() - bestAt > STALL_MS) {
          return finish();
        }
        const fastLeft = left - SLOW_SHED_SECONDS;
        const nextRate = fastLeft > 0 ? SKIP_RATE : SLOW_RATE;
        if (nextRate !== rate) el.playbackRate = rate = nextRate;
        // Aimed where the phase ends if the target is shrinking too, so the gap
        // closes at the rate itself and a punctual check never overshoots.
        const due = fastLeft > 0 ? fastLeft / SKIP_RATE : left / SLOW_RATE;
        timer = setTimeout(check, Math.min(CHECK_MS, due * 1000));
      };
      el.addEventListener('waiting', finish);
      stopFastForward = finish;
      cleanups.push(() => {
        if (timer !== null) clearTimeout(timer);
        el.removeEventListener('waiting', finish);
        resolve();
      });
      fast = true;
      check();
    });
  }

  return cancel;
}
