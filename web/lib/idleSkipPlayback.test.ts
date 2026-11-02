// The mechanism behind the web player's skip over a woken station's stale idle
// silence (#2072): it reads /state only after the first audio, leaves a live
// station's playback untouched, sheds lag by playbackRate and reports what it
// measured, and an engine that ignores the rate (WebKit's GStreamer build) gets
// today's behaviour. A late check overshoots by at most twice its lateness, a
// hidden tab ends the skip, and no run, however it ends, leaves its
// visibilitychange listener on the page. A fake element runs on the real
// clock, so each test takes a second or two at a small buffer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MUSIC_MARGIN_SECONDS, SKIP_CUSHION_SECONDS } from './idleSkip';
import { SKIP_RATE, SLOW_RATE, skipIdleSilence } from './idleSkipPlayback';
import type { IdleWindow } from './types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const IDLE: IdleWindow = { startedMsAgo: 10 * 60_000, endedMsAgo: null };

// A media element whose clock runs at playbackRate, unless the engine ignores it.
// `lateMs` blocks the main thread that long whenever the skip reads the clock
// above 1x, which is every check firing that late: the media clock keeps
// running while no script does.
class FakeAudio extends EventTarget {
  readyState = 0;
  paused = true;
  honoursRate = true;
  lateMs = 0;
  rates: number[] = [];
  private base = 0;
  private since = performance.now();
  private rate = 1;
  private clock() {
    if (this.paused) return this.base;
    return this.base + ((performance.now() - this.since) / 1000) * (this.honoursRate ? this.rate : 1);
  }
  get currentTime() {
    if (this.lateMs && this.rate > 1) {
      const end = performance.now() + this.lateMs;
      while (performance.now() < end);
    }
    return this.clock();
  }
  get playbackRate() { return this.rate; }
  set playbackRate(r: number) {
    this.base = this.clock();
    this.since = performance.now();
    this.rate = r;
    this.rates.push(r);
  }
  start() {
    this.readyState = 4;
    this.paused = false;
    this.since = performance.now();
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('playing'));
  }
}

// `listening` counts its visibilitychange listeners: `document` outlives every
// connection, so a run that leaves one behind leaks it and its element.
class FakePage extends EventTarget {
  hidden = false;
  private listeners = new Set<unknown>();
  get listening() { return this.listeners.size; }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean) {
    this.listeners.add(cb);
    super.addEventListener(type, cb, opts);
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: EventListenerOptions | boolean) {
    this.listeners.delete(cb);
    super.removeEventListener(type, cb, opts);
  }
}

function run(opts: { buffer?: number; window?: IdleWindow | null; read?: () => Promise<unknown>; page?: FakePage } = {}) {
  const el = new FakeAudio();
  const log: string[] = [];
  const trims: number[] = [];
  let readAt = 0;
  let trimAt = 0;
  const cancel = skipIdleSilence(el as unknown as HTMLAudioElement, {
    bufferSeconds: opts.buffer ?? SKIP_CUSHION_SECONDS + 2.5,
    readState: async () => {
      log.push(`read@${el.readyState}`);
      readAt = performance.now();
      if (opts.read) return opts.read() as never;
      return { streamIdleWindow: opts.window === undefined ? IDLE : opts.window };
    },
    onTrim: ms => {
      trims.push(ms);
      trimAt = performance.now();
    },
    page: opts.page ?? null,
  });
  return { el, log, trims, cancel, readAt: () => readAt, trimAt: () => trimAt };
}

// How far the shed went past what the planner allowed when it stopped, in s.
function overshoot(r: ReturnType<typeof run>, buffer: number, endedMsAgo: number | null) {
  const resumedAgo = ((endedMsAgo ?? 0) + (r.trimAt() - r.readAt())) / 1000;
  const allowed = buffer - Math.max(SKIP_CUSHION_SECONDS, resumedAgo + MUSIC_MARGIN_SECONDS);
  return (r.trims[0] ?? 0) / 1000 - allowed;
}

test('a live station is read after the first audio and its playback left alone', async () => {
  for (const window of [null, { startedMsAgo: 900_000, endedMsAgo: 300_000 }]) {
    const r = run({ window });
    await sleep(20);
    assert.deepEqual(r.log, [], 'nothing is read before the first audio');
    r.el.start();
    await sleep(200);
    assert.deepEqual(r.log, ['read@4']);
    assert.deepEqual(r.el.rates, [], 'the rate is never touched');
    assert.deepEqual(r.trims, []);
    r.cancel();
    assert.deepEqual(r.el.rates, []);
  }
});

test('an idle tune-in sheds down to the cushion and reports what it measured', async () => {
  const r = run();
  r.el.start();
  // 2.5s to shed: 1s at 8x, then the last 1.5s at 2x.
  await sleep(2_200);
  assert.deepEqual(r.el.rates, [SKIP_RATE, SLOW_RATE, 1]);
  assert.equal(r.trims.length, 1);
  const trim = r.trims[0] ?? 0;
  assert.ok(trim >= 2_500 && trim < 2_800, String(trim));
});

test('a check that runs 150ms late overshoots by at most twice that, well inside the margin', async () => {
  // The cushion case (still paused at the read: the target holds) and a wake
  // 8s behind the listener (the target shrinks 1s per second, so the gap
  // closes faster). At 8x throughout, these overshot by ~0.86s and ~1.03s.
  for (const [buffer, endedMsAgo] of [[SKIP_CUSHION_SECONDS + 2.5, null], [22, 8_000]] as const) {
    const r = run({ buffer, window: { startedMsAgo: 10 * 60_000, endedMsAgo } });
    r.el.lateMs = 150;
    r.el.start();
    while (!r.trims.length) await sleep(50);
    const over = overshoot(r, buffer, endedMsAgo);
    assert.ok(over < 0.45, `${buffer}s/${endedMsAgo}: overshoot ${over.toFixed(3)}s`);
    assert.deepEqual(r.el.rates, [SKIP_RATE, SLOW_RATE, 1]);
  }
});

test('hiding the tab ends the skip with what was shed, and showing it does not resume it', async () => {
  const page = new FakePage();
  const r = run({ buffer: 30, page });
  r.el.start();
  await sleep(150);
  page.setHidden(true);
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
  assert.equal(r.trims.length, 1);
  const trim = r.trims[0] ?? 0;
  assert.ok(trim > 300 && trim < 2_000, String(trim));
  page.setHidden(false);
  await sleep(300);
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
  assert.equal(r.trims.length, 1);
});

test('a tab hidden before the fast-forward never starts it', async () => {
  const page = new FakePage();
  let answer!: (v: unknown) => void;
  const r = run({ page, read: () => new Promise(res => { answer = res; }) });
  r.el.start();
  await sleep(20);
  page.setHidden(true);
  answer({ streamIdleWindow: IDLE });
  page.setHidden(false);
  await sleep(200);
  assert.deepEqual(r.el.rates, []);
  assert.deepEqual(r.trims, []);

  // Already hidden at tune-in (a lock-screen or media-key play).
  const hiddenPage = new FakePage();
  hiddenPage.hidden = true;
  const h = run({ page: hiddenPage });
  h.el.start();
  await sleep(200);
  assert.deepEqual(h.el.rates, []);
  assert.deepEqual(h.trims, []);
});

test('the visibility listener goes with the run, however it ends', async () => {
  const ended = async (name: string, page: FakePage, settle: () => Promise<unknown>) => {
    await settle();
    assert.equal(page.listening, 0, `${name}: listener left on the page`);
  };

  let page = new FakePage();
  const live = run({ window: null, page });
  assert.equal(page.listening, 1);
  live.el.start();
  await ended('a live station', page, () => sleep(100));

  page = new FakePage();
  const failed = run({ read: () => Promise.reject(new Error('offline')), page });
  failed.el.start();
  await ended('a failed read', page, () => sleep(100));

  page = new FakePage();
  const early = run({ page });
  early.cancel();
  await ended('cancelled before the first audio', page, async () => {});

  page = new FakePage();
  const done = run({ page });
  done.el.start();
  await ended('a finished skip', page, async () => { while (!done.trims.length) await sleep(50); });

  page = new FakePage();
  const dry = run({ buffer: 30, page });
  dry.el.start();
  await sleep(150);
  assert.equal(page.listening, 1);
  dry.el.dispatchEvent(new Event('waiting'));
  await ended('`waiting`', page, async () => {});

  page = new FakePage();
  const cancelled = run({ buffer: 30, page });
  cancelled.el.start();
  await sleep(150);
  cancelled.cancel();
  await ended('cancelled mid-skip', page, async () => {});

  page = new FakePage();
  const ignored = run({ page });
  ignored.el.honoursRate = false;
  ignored.el.start();
  await ended('an engine that ignores the rate', page, () => sleep(1_800));
});

test('an engine that ignores the rate is put back to 1x and reports nothing', async () => {
  const r = run();
  r.el.honoursRate = false;
  r.el.start();
  await sleep(2_000);
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
  assert.deepEqual(r.trims, []);
});

test('running out of buffer ends the skip with what was shed', async () => {
  const r = run({ buffer: 30 });
  r.el.start();
  await sleep(150);
  r.el.dispatchEvent(new Event('waiting'));
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
  assert.equal(r.trims.length, 1);
  const trim = r.trims[0] ?? 0;
  assert.ok(trim > 300 && trim < 2_000, String(trim));
});

test('cancelling mid-skip restores 1x and reports nothing', async () => {
  const r = run({ buffer: 30 });
  r.el.start();
  await sleep(150);
  r.cancel();
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
  await sleep(300);
  assert.deepEqual(r.trims, []);
  assert.deepEqual(r.el.rates, [SKIP_RATE, 1]);
});

test('a failed read, or one cancelled in flight, skips nothing', async () => {
  const failed = run({ read: () => Promise.reject(new Error('offline')) });
  failed.el.start();
  await sleep(100);
  assert.deepEqual(failed.el.rates, []);

  let answer!: (v: unknown) => void;
  const pending = run({ read: () => new Promise(r => { answer = r; }) });
  pending.el.start();
  await sleep(20);
  pending.cancel();
  answer({ streamIdleWindow: IDLE });
  await sleep(100);
  assert.deepEqual(pending.el.rates, []);
  assert.deepEqual(pending.trims, []);
});
