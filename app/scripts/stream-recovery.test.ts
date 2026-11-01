import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  CHURN_MIN_PACE,
  NO_BACKOFF,
  PLAYED_MAX_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STAYED_UP_MS,
  StreamRecovery,
  WATCHDOG_MIN_PACE,
  WATCHDOG_MS,
  failureDelay,
  itemPlaying,
  itemReplaced,
  itemStopped,
  keptPace,
  retryDelay,
  stallDelay,
  watchdogDelay,
  type ReloadReason,
} from '../src/lib/stream-recovery.ts';

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// The native media clock: runs while the fake player plays, restarts at zero
// with every newly loaded item.
class MediaClock {
  private base = 0;
  private since: number | null = null;
  run() {
    if (this.since === null) this.since = Date.now();
  }
  freeze() {
    this.base = this.read();
    this.since = null;
  }
  jumpTo(position: number) {
    this.freeze();
    this.base = position;
  }
  read() {
    return this.base + (this.since === null ? 0 : (Date.now() - this.since) / 1000);
  }
}

interface Deferred {
  resolve: () => void;
  reject: (e: Error) => void;
}

function setup(
  t: TestContext,
  opts: { holdReloads?: boolean; failReloads?: boolean; position?: () => Promise<number> } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const clock = new MediaClock();
  const reloads: ReloadReason[] = [];
  // When each reload started, on the mocked wall clock.
  const reloadAt: number[] = [];
  const held: Deferred[] = [];
  const logs: string[] = [];
  const counts = { advancing: 0, inFlight: 0, maxInFlight: 0 };
  const recovery = new StreamRecovery({
    position: opts.position ?? (async () => clock.read()),
    reload: async (reason) => {
      reloads.push(reason);
      reloadAt.push(Date.now());
      counts.inFlight += 1;
      counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
      try {
        clock.jumpTo(0);
        if (opts.holdReloads) {
          await new Promise<void>((resolve, reject) => { held.push({ resolve, reject }); });
        }
        if (opts.failReloads) throw new Error('load failed');
      } finally {
        counts.inFlight -= 1;
      }
    },
    onAdvancing: () => { counts.advancing += 1; },
    log: (m) => { logs.push(m); },
  });
  t.after(() => recovery.tuneOut());
  // Advance in small steps so async checks and the timers they re-arm interleave.
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      t.mock.timers.tick(Math.min(250, left));
      await settle();
    }
  };
  return { recovery, clock, reloads, reloadAt, held, logs, counts, tick };
}

type Harness = ReturnType<typeof setup>;

// Tune in and reach steady playback.
async function onAir(h: Harness) {
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(10_000);
}

// A station that hangs before the response, deep into its backoff: reloads at
// 6, 12, 18, 24, 32 and 48s, and the check after those is 32s away, due at 80s.
async function hungDeep(h: Harness) {
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(60_000);
  assert.equal(h.reloads.length, 7);
}

// The gaps between the reloads from index `from` on.
function gapsFrom(h: Harness, from: number) {
  const at = h.reloadAt.slice(from);
  return at.slice(1).map((ms, i) => ms - at[i]);
}

// The gaps a hung station gets after a listener's own load, which is no failure.
// An automatic reload is the first failure, so it starts one step along.
const BACKOFF_OVER = [WATCHDOG_MS, WATCHDOG_MS, WATCHDOG_MS, WATCHDOG_MS, 8000, 16_000];

test('pace: a moving clock passes, a frozen, rewound or unknown one does not', () => {
  const from = { at: 0, position: 100 };
  assert.equal(keptPace(from, { at: 6000, position: 106 }, WATCHDOG_MIN_PACE), true);
  assert.equal(keptPace(from, { at: 6000, position: 106 }, CHURN_MIN_PACE), true);
  assert.equal(keptPace(from, { at: 6000, position: 102 }, WATCHDOG_MIN_PACE), false, 'a third of real time');
  assert.equal(keptPace(from, { at: 6000, position: 100 }, WATCHDOG_MIN_PACE), false, 'frozen');
  assert.equal(keptPace(from, { at: 6000, position: 3 }, WATCHDOG_MIN_PACE), false, 'native source restarted');
  assert.equal(keptPace(null, { at: 6000, position: 106 }, WATCHDOG_MIN_PACE), false);
  assert.equal(keptPace(from, null, WATCHDOG_MIN_PACE), false);
  assert.deepEqual([0, 1, 2, 20].map(retryDelay), [500, 1000, 2000, 60_000]);
  assert.deepEqual([0, 3, 4, 7, 20].map(watchdogDelay), [WATCHDOG_MS, WATCHDOG_MS, 8000, 60_000, 60_000]);
});

test('a stall the media clock plays through is not reloaded; the UI is reconciled (#2114, #1936)', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  // The native player starts playing, but no Playing event reaches JS.
  h.recovery.onState('loading');
  h.recovery.onState('buffering');
  h.clock.run();
  await h.tick(40_000);
  assert.deepEqual(h.reloads, ['tune']);
  assert.ok(h.counts.advancing >= 1);
  assert.ok(h.logs.some((l) => l.startsWith('hold [watchdog] state=buffering')));

  // It keeps watching: once the clock really stops, one reload follows.
  h.clock.freeze();
  await h.tick(2 * WATCHDOG_MS);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
  const line = h.logs.find((l) => l.startsWith('reload [watchdog]'));
  assert.match(line ?? '', /state=buffering: pos .* pace 0\.00/);
});

test('a hold on a stale Ready stops watching: a clock frozen with no event is not reloaded', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  // The audio plays, but the last state JS heard is Ready.
  h.recovery.onState('loading');
  h.recovery.onState('ready');
  h.clock.run();
  await h.tick(WATCHDOG_MS + 500);
  assert.ok(h.logs.some((l) => l.startsWith('hold [watchdog] state=ready')));
  // An iOS interruption stops AVPlayer without a state event.
  h.clock.freeze();
  await h.tick(60_000);
  assert.deepEqual(h.reloads, ['tune']);
});

test('a stall after a hold on a stale Ready reloads WATCHDOG_MS after it began', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  h.recovery.onState('ready');
  h.clock.run();
  await h.tick(WATCHDOG_MS + 3000); // held at 6s, still playing at 9s
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS - 250);
  assert.deepEqual(h.reloads, ['tune']);
  await h.tick(500);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
});

test('a stall with a stopped clock reloads once, WATCHDOG_MS after it began', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS - 250);
  assert.deepEqual(h.reloads, ['tune']);
  await h.tick(500);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
  await h.tick(3000);
  assert.deepEqual(h.reloads, ['tune', 'watchdog'], 'the new load is not reloaded again while loading');
});

test('a flap storm cannot postpone the check', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.clock.freeze();
  for (let i = 0; i < 11; i++) {
    h.recovery.onState(i % 2 ? 'ready' : 'buffering');
    await h.tick(500);
  }
  assert.deepEqual(h.reloads, ['tune'], 'not yet at 5.5s');
  h.recovery.onState('buffering');
  await h.tick(500);
  assert.deepEqual(h.reloads, ['tune', 'watchdog'], 'fires 6s after the first stall');
});

test('brief stalls on a healthy stream do not trip the churn guard', async (t) => {
  const h = setup(t);
  await onAir(h);
  for (let i = 0; i < 6; i++) {
    h.recovery.onState('buffering');
    h.clock.freeze();
    await h.tick(500);
    h.clock.run();
    h.recovery.onState('playing');
    await h.tick(8000);
  }
  assert.deepEqual(h.reloads, ['tune']);
  assert.ok(h.logs.some((l) => l.startsWith('hold [churn] 4 stalls')));
});

test('a starved stream still trips the churn guard (#1252)', async (t) => {
  const h = setup(t);
  await onAir(h);
  // Plays 2s, stalls 4s: too short for the watchdog, a third of real time.
  for (let i = 0; i < 4; i++) {
    h.recovery.onState('buffering');
    h.clock.freeze();
    await h.tick(4000);
    h.clock.run();
    h.recovery.onState('playing');
    await h.tick(2000);
  }
  assert.deepEqual(h.reloads, ['tune', 'churn']);
  assert.ok(h.logs.some((l) => /^reload \[churn\] #2 state=buffering: 4 stalls inside 60s/.test(l)));
});

test('a native player that keeps restarting its source trips the churn guard', async (t) => {
  const h = setup(t);
  await onAir(h);
  for (let i = 0; i < 4; i++) {
    h.recovery.onState('buffering');
    await settle();
    h.clock.jumpTo(0); // each internal retry plays the new source from zero
    await h.tick(250);
    h.clock.run();
    h.recovery.onState('playing');
    await h.tick(5000);
  }
  assert.deepEqual(h.reloads, ['tune', 'churn']);
});

test('overlapping triggers run one reload at a time', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(WATCHDOG_MS + 500); // watchdog fires with the load still in flight
  h.recovery.linkRegained();
  h.recovery.onError();
  h.recovery.retune();
  await settle();
  assert.deepEqual(h.reloads, ['tune']);
  assert.ok(h.logs.some((l) => l.startsWith('reload [watchdog] skipped')));

  h.held[0].resolve();
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'format'], 'the queued retune runs after it');
  h.held[1].resolve();
  await settle();
  assert.equal(h.counts.maxInFlight, 1);
});

test('a failure reported mid-reload belongs to the item being replaced', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('error');
  h.recovery.onError();
  h.held[0].resolve();
  await settle();
  h.recovery.onState('loading');
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(10_000);
  assert.deepEqual(h.reloads, ['tune']);
});

test('a stale Error while the stream plays is held, not reloaded', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onState('error');
  await h.tick(2000);
  assert.deepEqual(h.reloads, ['tune']);
  assert.ok(h.logs.some((l) => l.startsWith('hold [error] state=error')));
  // And stops watching: a later stall would emit Buffering.
  h.clock.freeze();
  await h.tick(60_000);
  assert.deepEqual(h.reloads, ['tune']);
});

test('a failing reload backs off while nothing plays', async (t) => {
  const h = setup(t, { failReloads: true });
  h.recovery.tuneIn();
  await h.tick(4000);
  // 0, 0.5s, 1.5s, 3.5s
  assert.deepEqual(h.reloads, ['tune', 'error', 'error', 'error']);
});

test('a station that keeps failing is backed off to the ceiling, past the watchdog', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  // Each load fails as RNTP reports it, after the load call has returned: the
  // item's Loading arms the watchdog, then a PlaybackError and the Error state.
  const at: number[] = [];
  for (let elapsed = 0; elapsed < 4 * 60_000; elapsed += 250) {
    while (at.length < h.reloads.length) {
      at.push(Date.now());
      h.recovery.onState('loading');
      h.recovery.onError();
      h.recovery.onState('error');
    }
    await h.tick(250);
  }
  const gaps = at.slice(1).map((ms, i) => ms - at[i]);
  // PlaybackError and State.Error are one failure: the first retry is 500ms.
  assert.deepEqual(gaps.slice(0, 4), [500, 1000, 2000, 4000], `gaps ${gaps.join(', ')}`);
  assert.ok(gaps[gaps.length - 1] >= RECONNECT_MAX_MS, `gaps ${gaps.join(', ')}`);
  assert.ok(h.reloads.length <= 11, `${h.reloads.length} loads in 4 minutes`);
});

test('a reload made while the item is still Loading is checked again, on a growing backoff (#2143)', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  // A connection that hangs before the response. On iOS the item stays in
  // Loading, and a reload made from there reports nothing: SwiftAudioEx drops
  // a write of the state it already holds.
  h.recovery.onState('loading');
  await h.tick(5 * 60_000);
  const gaps = h.reloadAt.slice(1).map((ms, i) => ms - h.reloadAt[i]);
  assert.deepEqual(
    gaps,
    [6000, 6000, 6000, 6000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000],
    `gaps ${gaps.join(', ')}`,
  );
  assert.ok(h.reloads.slice(1).every((r) => r === 'watchdog'));
});

test('a hung station that reports every load is backed off the same way', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  // Android: each new item reports Loading, then Buffering while it waits.
  let seen = 0;
  for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 250) {
    while (seen < h.reloads.length) {
      seen += 1;
      h.recovery.onState('loading');
      h.recovery.onState('buffering');
    }
    await h.tick(250);
  }
  const gaps = h.reloadAt.slice(1).map((ms, i) => ms - h.reloadAt[i]);
  assert.deepEqual(
    gaps,
    [6000, 6000, 6000, 6000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000],
    `gaps ${gaps.join(', ')}`,
  );
});

test('an error after hung reloads continues their backoff', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(30_000); // reloads at 6, 12, 18 and 24s: four failures
  assert.equal(h.reloads.length, 5);
  // AVFoundation gives up on the hung load at last.
  const failedAt = Date.now();
  h.recovery.onError();
  h.recovery.onState('error');
  await h.tick(10_000);
  assert.deepEqual(h.reloads.slice(5), ['error']);
  assert.equal(h.reloadAt[5] - failedAt, retryDelay(4));
});

test('a hung station that comes back is watched at WATCHDOG_MS again', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(60_000);
  assert.ok(h.reloads.length >= 6);
  // The latest load connects.
  const loads = h.reloads.length;
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(90_000);
  assert.equal(h.reloads.length, loads, 'a playing item is not reloaded');
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, loads);
  await h.tick(500);
  assert.equal(h.reloads.length, loads + 1);
});

test('a hung station whose load plays with no Playing event starts its backoff over', async (t) => {
  const h = setup(t);
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(33_000); // reloads at 6, 12, 18, 24 and 32s: five failures
  assert.equal(h.reloads.length, 6);
  // The latest load plays, but JS never hears Playing: the check at 48s holds.
  h.clock.run();
  await h.tick(29_000);
  assert.equal(h.reloads.length, 6);
  assert.ok(h.logs.some((l) => l.startsWith('hold [watchdog] state=loading')));
  // It hangs again. The hold was a sign of playback, so the reloads come
  // WATCHDOG_MS apart, not 32s.
  h.clock.freeze();
  await h.tick(20_000);
  const since = h.reloadAt.slice(6).map((ms) => ms - h.reloadAt[6]);
  assert.deepEqual(since, [0, WATCHDOG_MS, 2 * WATCHDOG_MS], `reloads at +${since.join(', +')}`);
});

test('a hold on a stale Error starts the backoff over too', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  // The latest load plays, but the last state JS hears is a stale Error.
  h.clock.run();
  h.recovery.onState('error');
  await h.tick(retryDelay(6));
  assert.ok(h.logs.some((l) => l.startsWith('hold [error] state=error')));
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 7);
  await h.tick(500);
  assert.equal(h.reloads[7], 'watchdog');
});

test('a retune starts the backoff over', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.retune();
  await settle();
  await h.tick(50_000);
  assert.equal(h.reloads[7], 'format');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER);
});

test('a regained link starts the backoff over, and its own reload counts as the first failure', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.linkRegained();
  await settle();
  await h.tick(44_000);
  assert.equal(h.reloads[7], 'link');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER.slice(1));
});

test('a regained link with no check pending starts the backoff over too', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  // A call ends with the audio left paused: the backoff stands, nothing is armed.
  h.recovery.onDuck(true);
  h.recovery.onDuck(true, true);
  await h.tick(60_000);
  assert.equal(h.reloads.length, 7);
  h.recovery.linkRegained();
  await settle();
  await h.tick(44_000);
  assert.equal(h.reloads[7], 'link');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER.slice(1));
});

test('a link regained during a call starts the backoff over when the call ends', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.onDuck(true);
  h.recovery.linkRegained(); // Wi-Fi to cellular mid-call
  await settle();
  assert.equal(h.reloads.length, 7, 'nothing reloads during the call');
  h.recovery.onDuck(false);
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 7);
  await h.tick(500);
  assert.equal(h.reloads[7], 'watchdog');
});

test('a retune during a call starts the backoff over when the call ends', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.onDuck(true);
  h.recovery.retune();
  await settle();
  assert.equal(h.reloads[7], 'format', 'a listener load still runs during the call');
  h.recovery.onDuck(false);
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 8);
  await h.tick(500);
  assert.equal(h.reloads[8], 'watchdog');
});

test('an interruption is no listener action: the check after it waits out the backoff', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.onDuck(true);
  h.recovery.onDuck(false);
  await h.tick(watchdogDelay(6) - 250);
  assert.equal(h.reloads.length, 7);
  await h.tick(500);
  assert.equal(h.reloads[7], 'watchdog');
});

test('a Playing over an interruption whose end was missed starts the backoff over', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.onDuck(true); // iOS doesn't promise the end
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(STAYED_UP_MS);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 7);
  await h.tick(500);
  assert.equal(h.reloads[7], 'watchdog');
});

test('a tune-in over a hung station starts the backoff over', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.tuneIn();
  await settle();
  await h.tick(50_000);
  assert.equal(h.reloads[7], 'tune');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER);
});

test('a stop and a tune-in start the backoff over', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.tuneOut();
  h.recovery.tuneIn();
  await settle();
  await h.tick(50_000);
  assert.equal(h.reloads[7], 'tune');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER);
});

test('an adopted stream starts the backoff over', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.adopt();
  h.recovery.onState('buffering');
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 7);
  await h.tick(500);
  assert.equal(h.reloads[7], 'watchdog');
});

test('a remote Play starts the backoff over (#2139)', async (t) => {
  const h = setup(t);
  await hungDeep(h);
  h.recovery.tuneIn('remote');
  await settle();
  await h.tick(50_000);
  assert.equal(h.reloads[7], 'remote');
  assert.deepEqual(gapsFrom(h, 7), BACKOFF_OVER);
});

for (const [name, reason, ask] of [
  ['tune-in', 'tune', (r: StreamRecovery) => r.tuneIn()],
  ['remote Play', 'remote', (r: StreamRecovery) => r.tuneIn('remote')],
  ['retune', 'format', (r: StreamRecovery) => r.retune()],
] as const) {
  test(`a ${name} queued behind a hung reload is no failure: its first error retry is the 500ms one`, async (t) => {
    const opts = { holdReloads: false };
    const h = setup(t, opts);
    await hungDeep(h);
    opts.holdReloads = true;
    await h.tick(20_000); // the reload at 80s, still in its load call
    assert.equal(h.reloads.length, 8);
    ask(h.recovery);
    await settle();
    assert.equal(h.reloads.length, 8, 'queued behind it');
    h.held[0].resolve();
    await settle();
    assert.equal(h.reloads[8], reason);
    h.held[1].resolve();
    await settle();
    h.recovery.onError();
    await h.tick(RECONNECT_BASE_MS);
    assert.equal(h.reloads[9], 'error');
    h.held[2].resolve();
    await settle();
  });
}

test('a retune queued during an interruption still loads', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onDuck(true);
  h.recovery.retune();
  await settle();
  h.held[0].resolve();
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'format']);
  h.held[1].resolve();
  await settle();
});

test('an automatic reload skipped behind one in flight is no failure', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading');
  await h.tick(WATCHDOG_MS + 500); // the watchdog fires with the load still in flight
  assert.ok(h.logs.some((l) => l.startsWith('reload [watchdog] skipped')));
  h.held[0].resolve();
  await settle();
  h.recovery.onError();
  await h.tick(RECONNECT_BASE_MS);
  assert.deepEqual(h.reloads, ['tune', 'error']);
  h.held[1].resolve();
  await settle();
});

test('an automatic reload skipped during an interruption is no failure', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true);
  h.clock.freeze();
  h.recovery.linkRegained(); // no check pending, so it asks for a reload
  await settle();
  assert.ok(h.logs.some((l) => l.startsWith('reload [link] skipped: audio interrupted')));
  h.recovery.onDuck(false);
  h.recovery.onError();
  await h.tick(RECONNECT_BASE_MS);
  assert.deepEqual(h.reloads, ['tune', 'error']);
});

test('a churn reload is a failure until it plays: an error retries one step along', async (t) => {
  const h = setup(t);
  await onAir(h);
  // As in the starved stream above, stopping short of the Playing after the trip.
  for (let i = 0; i < 3; i++) {
    h.recovery.onState('buffering');
    h.clock.freeze();
    await h.tick(4000);
    h.clock.run();
    h.recovery.onState('playing');
    await h.tick(2000);
  }
  h.recovery.onState('buffering');
  h.clock.freeze();
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'churn']);
  h.recovery.onError();
  await h.tick(retryDelay(1) - 250);
  assert.deepEqual(h.reloads, ['tune', 'churn']);
  await h.tick(500);
  assert.deepEqual(h.reloads, ['tune', 'churn', 'error']);
});

test('a remote Play reloads at once over a stream that plays, with no clock check (#2139)', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.tuneIn('remote');
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'remote']);
  assert.ok(h.logs.some((l) => l.startsWith('reload [remote] #2 state=playing')));
});

test('a remote Play during a reload waits for it, never overlapping (#2139)', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.held[0].resolve();
  await settle();
  h.recovery.onState('loading');
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(10_000);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog'], 'the watchdog reload is in flight');
  // A car connecting sends Play, twice.
  h.recovery.tuneIn('remote');
  h.recovery.tuneIn('remote');
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
  h.held[1].resolve();
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'watchdog', 'remote'], 'one load, queued behind it');
  h.held[2].resolve();
  await settle();
  assert.equal(h.counts.maxInFlight, 1);
});

test('a regained link reloads a stopped stall at once, but not a playing one', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onState('buffering');
  await h.tick(1000);
  h.recovery.linkRegained();
  await settle();
  assert.deepEqual(h.reloads, ['tune'], 'the clock still runs');

  h.clock.freeze();
  await h.tick(1000);
  h.recovery.linkRegained();
  await settle();
  assert.deepEqual(h.reloads, ['tune', 'link']);
});

test('a lock-screen resume is adopted without a reload, and still watched', async (t) => {
  const h = setup(t);
  h.recovery.adopt();
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(5000);
  assert.deepEqual(h.reloads, []);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS);
  assert.deepEqual(h.reloads, ['watchdog']);
});

test('an interruption reloads nothing while it lasts, then checks the clock when it ends', async (t) => {
  const h = setup(t);
  await onAir(h);
  // A stall is pending when a call comes in. iOS stops AVPlayer with no state
  // event, and a new item can't play during the call either.
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(2000);
  h.recovery.onDuck(true);
  let seen = h.reloads.length;
  for (let elapsed = 0; elapsed < 2 * 60_000; elapsed += 250) {
    while (seen < h.reloads.length) {
      seen += 1;
      h.recovery.onState('loading');
    }
    if (elapsed === 30_000) h.recovery.linkRegained(); // Wi-Fi to cellular mid-call
    await h.tick(250);
  }
  assert.deepEqual(h.reloads, ['tune'], 'nothing reloads during the call');
  // RNTP resumes the item, but the stall outlived the call: no new state.
  h.recovery.onDuck(false);
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
});

test('an interruption that ends with the audio back is not reloaded, or watched on', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true);
  h.clock.freeze();
  await h.tick(60_000);
  // RNTP resumes the item. The native state never left Playing: no event.
  h.recovery.onDuck(false);
  h.clock.run();
  await h.tick(30_000);
  assert.deepEqual(h.reloads, ['tune']);
  assert.equal(h.logs.filter((l) => l.startsWith('hold [watchdog] state=playing')).length, 1);
});

test('an interruption iOS ends without a resume leaves the player paused', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true);
  h.clock.freeze();
  await h.tick(30_000);
  h.recovery.onDuck(true, true);
  await h.tick(60_000);
  assert.deepEqual(h.reloads, ['tune']);
});

test('a missed interruption end does not leave the watchdog off', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true); // iOS doesn't promise the end
  h.clock.freeze();
  await h.tick(30_000);
  // The audio comes back with neither an end nor a new item reported.
  h.clock.run();
  h.recovery.onState('playing');
  await h.tick(5000);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
});

test('a tune-in ends an interruption whose end was missed', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.onDuck(true);
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('loading'); // its own item, reported while the load is in flight
  h.held[0].resolve();
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
  h.held[1].resolve();
});

test('a load made outside the module after a missed interruption end is watched before it plays', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true); // another app's audio took over, and iOS never ends it
  h.clock.freeze();
  await h.tick(30_000);
  // A load made outside the module, and the new item never starts.
  h.recovery.onState('loading');
  h.clock.jumpTo(0);
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
});

test("an interruption that begins mid-reload outlasts that reload's own Loading", async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onDuck(true);
  h.recovery.onState('loading'); // the reload's new item, reported after the duck
  h.held[0].resolve();
  await settle();
  await h.tick(2 * 60_000);
  assert.deepEqual(h.reloads, ['tune'], 'nothing reloads during the call');
  h.recovery.onDuck(false);
  await h.tick(WATCHDOG_MS + 250);
  assert.deepEqual(h.reloads, ['tune', 'watchdog']);
});

test('a watchdog armed before a tune-out never fires', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onState('buffering');
  h.clock.freeze();
  h.recovery.tuneOut();
  h.recovery.onState('stopped');
  await h.tick(70_000);
  assert.deepEqual(h.reloads, ['tune']);
});

test('a clock read that lands after a tune-out is inert', async (t) => {
  const reads: ((p: number) => void)[] = [];
  const h = setup(t, { position: () => new Promise<number>((resolve) => { reads.push(resolve); }) });
  h.recovery.tuneIn();
  await settle();
  h.recovery.onState('buffering'); // baseline read
  await h.tick(WATCHDOG_MS); // the check fires and reads again
  assert.equal(reads.length, 2);
  h.recovery.tuneOut();
  for (const resolve of reads) resolve(0);
  await h.tick(5000);
  assert.deepEqual(h.reloads, ['tune']);
});

test("a quick stop and re-tune leaves the old session's timer inert", async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onState('buffering');
  h.clock.freeze();
  await h.tick(3000);
  h.recovery.tuneOut();
  h.recovery.tuneIn();
  // The old check was due 3s from here; the new load's own is due at 6s.
  await h.tick(WATCHDOG_MS - 500);
  assert.deepEqual(h.reloads, ['tune', 'tune'], 'no watchdog from the first session');
  h.recovery.onState('loading');
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(20_000);
  assert.deepEqual(h.reloads, ['tune', 'tune']);
});

test('a reload that fails after a tune-out schedules no retry', async (t) => {
  const h = setup(t, { holdReloads: true });
  h.recovery.tuneIn();
  await settle();
  h.recovery.tuneOut();
  h.held[0].reject(new Error('load failed'));
  await h.tick(70_000);
  assert.deepEqual(h.reloads, ['tune']);
});

// What each platform reports for an item, from the native code RNTP 4.1.2 pins:
// SwiftAudioEx 1.1.0 (AVPlayerWrapper, AudioPlayer) and KotlinAudio 2.1.0
// (BaseAudioPlayer). iOS writes the `error` state and then fails, and a failure
// to play to the end fails twice over; Android reports the error, then the state.
type Platform = 'ios' | 'android';

function native(h: Harness, platform: Platform) {
  const { clock, recovery } = h;
  const failed = () => {
    if (platform === 'ios') {
      recovery.onState('error');
      recovery.onError();
      recovery.onError();
    } else {
      recovery.onError();
      recovery.onState('error');
    }
  };
  return {
    plays() {
      recovery.onState('loading');
      if (platform === 'android') recovery.onState('buffering');
      recovery.onState('ready');
      recovery.onState('playing');
      clock.run();
    },
    ended() {
      clock.freeze();
      recovery.onState('ended');
    },
    error() {
      clock.freeze();
      failed();
    },
    stalls() {
      clock.freeze();
      recovery.onState('buffering');
    },
    refused() {
      recovery.onState('loading');
      if (platform === 'android') recovery.onState('buffering');
      failed();
    },
  };
}

type Step = [wait: number, run: () => void];

// Run for `ms`, starting a fresh script of steps at each new reload. The steps
// left over from the item it replaced go with it. Every wait is a multiple of
// the harness's 250ms tick.
async function items(h: Harness, ms: number, script: (n: number) => Step[]) {
  let seen = 0;
  let due: { at: number; run: () => void }[] = [];
  for (const end = Date.now() + ms; Date.now() < end;) {
    while (seen < h.reloads.length) {
      let at = h.reloadAt[seen];
      due = script(seen).map(([wait, run]) => ({ at: (at += wait), run }));
      seen += 1;
    }
    while (due.length && due[0].at <= Date.now()) {
      due.shift()?.run();
      await settle();
    }
    if (seen === h.reloads.length && !(due.length && due[0].at <= Date.now())) await h.tick(250);
  }
}

const PLAYED_CURVE = [500, 1000, 2000, 4000, 8000, 16_000, 16_000, 16_000];
// What a stall waits on that curve: the watchdog is its floor.
const STALL_CURVE = PLAYED_CURVE.map((ms) => Math.max(ms, WATCHDOG_MS));

const PLATFORMS: Platform[] = ['ios', 'android'];

// The wait before each reload after the first, with the item's own play taken off.
function waits(h: Harness, played: number) {
  return gapsFrom(h, 0).map((ms) => ms - played);
}

async function tunedIn(h: Harness) {
  h.recovery.tuneIn();
  await settle();
}

// Eight early failures, so the count stands past the curve's ceiling. Item 8 has
// just been loaded, and its test scripts it.
async function deepCutLoop(h: Harness, platform: Platform) {
  const n = native(h, platform);
  await tunedIn(h);
  await items(h, 71_500, (i) => (i <= 7 ? [[0, n.plays], [1000, n.ended]] : []));
  assert.equal(h.reloads.length, 9);
}

// The last reload's line in the playback log.
function lastReload(h: Harness) {
  return h.logs.filter((l) => l.startsWith('reload [') && !l.includes('skipped')).at(-1) ?? '';
}

test('the rule\'s numbers', () => {
  assert.equal(STAYED_UP_MS, 4000);
  assert.equal(PLAYED_MAX_MS, 16_000);
  assert.ok(STAYED_UP_MS < WATCHDOG_MS, 'the check after an interruption always lands past the line');
});

for (const platform of PLATFORMS) {
  for (const end of ['ended', 'error'] as const) {
    for (const played of [250, 1000, 3000]) {
      test(`${platform}: an item cut ${played}ms in (${end}) grows the backoff, to 16s`, async (t) => {
        const h = setup(t);
        const n = native(h, platform);
        await tunedIn(h);
        await items(h, 100_000, () => [[0, n.plays], [played, n[end]]]);
        assert.deepEqual(waits(h, played).slice(0, PLAYED_CURVE.length), PLAYED_CURVE);
      });
    }

    for (const played of [STAYED_UP_MS, 4250, 5000]) {
      test(`${platform}: an item cut ${played}ms in (${end}) stayed up: the first retry, every time`, async (t) => {
        const h = setup(t);
        const n = native(h, platform);
        await tunedIn(h);
        await items(h, 60_000, () => [[0, n.plays], [played, n[end]]]);
        assert.ok(h.reloads.length >= 8);
        assert.ok(waits(h, played).every((ms) => ms === RECONNECT_BASE_MS), `${waits(h, played)}`);
      });
    }
  }

  test(`${platform}: a stall a moment in grows the watchdog's wait, to 16s`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 75_000, () => [[0, n.plays], [1000, n.stalls]]);
    assert.ok(h.reloads.slice(1).every((r) => r === 'watchdog'));
    assert.deepEqual(waits(h, 1000).slice(0, 7), STALL_CURVE.slice(0, 7));
  });

  test(`${platform}: a stall past the line leaves the watchdog at its 6s`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 90_000, () => [[0, n.plays], [STAYED_UP_MS, n.stalls]]);
    assert.ok(h.reloads.length >= 8);
    assert.ok(waits(h, STAYED_UP_MS).every((ms) => ms === WATCHDOG_MS), `${waits(h, STAYED_UP_MS)}`);
  });

  test(`${platform}: one outage is as quick as ever, then the curve`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 40_000, (i) => (i === 0 ? [[0, n.plays], [30_000, n.ended]] : [[0, n.refused]]));
    assert.deepEqual(gapsFrom(h, 1), [1000, 2000, 4000]);
    assert.equal(h.reloadAt[1] - h.reloadAt[0], 30_000 + RECONNECT_BASE_MS);
  });

  test(`${platform}: a long outage waits it out, and an item that stays up clears the count`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 190_000, (i) => (i < 9 ? [[0, n.refused]] : [[0, n.plays], [STAYED_UP_MS, n.ended]]));
    assert.deepEqual(gapsFrom(h, 8).slice(0, 2), [RECONNECT_MAX_MS, STAYED_UP_MS + RECONNECT_BASE_MS]);
  });

  for (const end of ['ended', 'error', 'stalls'] as const) {
    test(`${platform}: the first item back from a long outage dying (${end}) waits 16s, not a minute`, async (t) => {
      const h = setup(t);
      const n = native(h, platform);
      await tunedIn(h);
      await items(h, 205_000, (i) => (i < 9 ? [[0, n.refused]] : [[0, n.plays], [1000, n[end]]]));
      assert.equal(h.reloadAt[10] - h.reloadAt[9], 1000 + PLAYED_MAX_MS);
    });
  }

  test(`${platform}: a refused load after early closes takes the full curve`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 140_000, (i) => (i <= 7 ? [[0, n.plays], [1000, n.ended]] : [[0, n.refused]]));
    assert.equal(h.reloadAt[9] - h.reloadAt[8], RECONNECT_MAX_MS);
  });

  test(`${platform}: a refused load after early stalls starts its curve at the first step`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 80_000, (i) => (i <= 6 ? [[0, n.plays], [1000, n.stalls]] : [[0, n.refused]]));
    assert.equal(h.reloadAt[8] - h.reloadAt[7], retryDelay(1));
  });

  test(`${platform}: a source that flaps never climbs to a minute`, async (t) => {
    // 3s up, 1s down. It stalls whatever is playing, and the mount refuses the
    // reload that lands while it is down.
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    await items(h, 5 * 60_000, () => {
      const phase = (Date.now() - 1_000_000) % 4000;
      return phase >= 2750 ? [[0, n.refused]] : [[0, n.plays], [3000 - phase, n.stalls]];
    });
    assert.ok(Math.max(...gapsFrom(h, 0)) <= 2 * WATCHDOG_MS, `gaps ${gapsFrom(h, 0).join(', ')}`);
  });
}

test('an iOS cut that reports Buffering before its end is judged from the stall', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await tunedIn(h);
  await items(h, 70_000, () => [[0, n.plays], [1000, n.stalls], [500, n.ended]]);
  assert.deepEqual(waits(h, 1500).slice(0, 6), PLAYED_CURVE.slice(0, 6));
});

test('an Android error that lands past the line still counts the moment the item stalled', async (t) => {
  // ExoPlayer's own retries run first: Buffering at 1s, the error 3.5s later.
  const h = setup(t);
  const n = native(h, 'android');
  await tunedIn(h);
  await items(h, 80_000, () => [[0, n.plays], [1000, n.stalls], [3500, n.error]]);
  assert.deepEqual(waits(h, 4500).slice(0, 6), PLAYED_CURVE.slice(0, 6));
});

test('a stall that recovers clears the stop: the item is judged by when it finally ends', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await deepCutLoop(h, 'ios');
  n.plays();
  await h.tick(1000);
  n.stalls();
  await h.tick(1000);
  h.recovery.onState('playing');
  h.clock.run();
  await h.tick(3000);
  n.ended();
  await h.tick(RECONNECT_BASE_MS);
  assert.equal(h.reloads[9], 'error', 'up past the line, so the first retry');
});

test('a Playing that ends a stall keeps the item\'s clock: a slow link is no new item', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await tunedIn(h);
  await items(h, 60_000, () => [
    [0, n.plays],
    [1000, n.stalls],
    [500, () => { h.recovery.onState('playing'); h.clock.run(); }],
    [1000, n.ended],
  ]);
  assert.deepEqual(waits(h, 2500).slice(0, 5), PLAYED_CURVE.slice(0, 5));
});

test('an interruption is no stop: its check waits 6s and nothing about the item counts as early', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await deepCutLoop(h, 'ios');
  // A stall a moment into the item, then a call, and a stall reported during it.
  n.plays();
  await h.tick(1000);
  n.stalls();
  await h.tick(250);
  h.recovery.onDuck(true);
  await h.tick(250);
  h.recovery.onState('buffering');
  await h.tick(1000);
  h.recovery.onDuck(false);
  await h.tick(WATCHDOG_MS - 250);
  assert.equal(h.reloads.length, 9);
  await h.tick(250);
  assert.equal(h.reloads[9], 'watchdog');
  assert.match(lastReload(h), /\(failure 1\)$/);
});

test('a regained link in a cut loop reloads at once and starts the count over', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await deepCutLoop(h, 'ios');
  n.plays();
  await h.tick(1000);
  n.ended();
  await h.tick(1000); // a 16s wait is running
  const at = Date.now();
  h.recovery.linkRegained();
  await settle();
  assert.equal(h.reloads[9], 'link');
  assert.equal(h.reloadAt[9], at);
  assert.match(lastReload(h), /\(failure 1\)$/);
  // Its own reload is the first failure, as a hung station's is.
  n.plays();
  await h.tick(1000);
  n.ended();
  await h.tick(retryDelay(1) - 250);
  assert.equal(h.reloads.length, 10);
  await h.tick(250);
  assert.equal(h.reloads[10], 'error');
});

for (const [name, reason, ask] of [
  ['tune-in', 'tune', (r: StreamRecovery) => r.tuneIn()],
  ['remote Play', 'remote', (r: StreamRecovery) => r.tuneIn('remote')],
  ['retune', 'format', (r: StreamRecovery) => r.retune()],
] as const) {
  test(`a ${name} in a cut loop loads at once, and its first failure is the 500ms one`, async (t) => {
    const h = setup(t);
    const n = native(h, 'android');
    await deepCutLoop(h, 'android');
    n.plays();
    await h.tick(1000);
    n.ended();
    await h.tick(1000); // a 16s wait is running
    const at = Date.now();
    ask(h.recovery);
    await settle();
    assert.equal(h.reloads[9], reason);
    assert.equal(h.reloadAt[9], at);
    n.plays();
    await h.tick(1000);
    n.ended();
    await h.tick(RECONNECT_BASE_MS);
    assert.equal(h.reloads[10], 'error');
  });
}

test('the churn guard never waits for the backoff: it trips on the stall that makes four', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await deepCutLoop(h, 'ios');
  n.plays();
  for (let i = 0; i < 4; i++) {
    await h.tick(500);
    n.stalls();
    await settle();
    if (i === 3) break;
    await h.tick(500);
    h.recovery.onState('playing');
    h.clock.run();
  }
  assert.equal(h.reloads[9], 'churn');
  assert.equal(h.reloadAt[9], Date.now());
});

test('an early failure a hold shows was stale counts for nothing', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await deepCutLoop(h, 'ios');
  n.plays();
  await h.tick(1000);
  h.recovery.onState('error'); // the audio plays on through it
  await h.tick(PLAYED_MAX_MS);
  assert.equal(h.reloads.length, 9);
  assert.ok(h.logs.some((l) => l.startsWith('hold [error] state=error')));
  n.ended();
  await h.tick(RECONNECT_BASE_MS);
  assert.equal(h.reloads[9], 'error', 'up past the line, so the first retry');
});

test('a hold on a load whose Playing JS never heard stands at once', async (t) => {
  const h = setup(t);
  await deepCutLoop(h, 'ios');
  h.recovery.onState('loading');
  h.clock.run();
  await h.tick(RECONNECT_MAX_MS);
  assert.ok(h.logs.some((l) => l.startsWith('hold [watchdog] state=loading')));
  h.clock.freeze();
  await h.tick(WATCHDOG_MS);
  assert.equal(h.reloads[9], 'watchdog');
  assert.match(lastReload(h), /\(failure 1\)$/);
});

for (const platform of PLATFORMS) {
  test(`${platform}: a healthy ten minutes reloads nothing, whatever it flaps`, async (t) => {
    const h = setup(t);
    const n = native(h, platform);
    await tunedIn(h);
    n.plays();
    await h.tick(1000);
    n.stalls(); // an underrun a moment in
    await h.tick(1500);
    h.recovery.onState('playing');
    h.clock.run();
    for (let i = 0; i < 13; i++) {
      await h.tick(45_000);
      n.stalls();
      await h.tick(500);
      h.recovery.onState('playing');
      h.clock.run();
    }
    assert.deepEqual(h.reloads, ['tune']);
  });
}

test('the playback log shows the count, so a phone\'s log can show the curve', async (t) => {
  const h = setup(t);
  const n = native(h, 'ios');
  await tunedIn(h);
  await items(h, 12_000, () => [[0, n.plays], [1000, n.ended]]);
  const counts = h.logs.filter((l) => l.startsWith('reload [error]')).map((l) => /\(failure (\d+)\)$/.exec(l)?.[1]);
  assert.deepEqual(counts, ['1', '2', '3', '4']);
});

// The rule by itself: a clock that restarts or steps can't be scripted above.
const AT = 1_000_000;
const heldAt = (retries: number) => itemPlaying({ ...NO_BACKOFF, retries }, AT);

test('only the first sign of play starts an item\'s clock', () => {
  const again = itemPlaying(heldAt(3), AT + 3000);
  assert.equal(again.playingSince, AT);
  assert.equal(again.heldRetries, 3);
  assert.equal(again.retries, 0);
  assert.equal(failureDelay(again, AT + 3500), retryDelay(3));
  assert.equal(failureDelay(again, AT + STAYED_UP_MS), RECONNECT_BASE_MS);
});

test('the first stop since an item played is the one judged', () => {
  const stopped = itemStopped(itemStopped(heldAt(4), AT + 1000), AT + 9000);
  assert.equal(stopped.stoppedAt, AT + 1000);
  assert.equal(failureDelay(stopped, AT + 60_000), retryDelay(4));
  assert.equal(stallDelay(stopped, AT + 60_000), Math.max(WATCHDOG_MS, retryDelay(4)));
  // Played again, it is judged afresh, from the same first Playing.
  const back = itemPlaying(stopped, AT + 2000);
  assert.equal(back.stoppedAt, null);
  assert.equal(failureDelay(itemStopped(back, AT + STAYED_UP_MS), AT + 60_000), RECONNECT_BASE_MS);
  assert.deepEqual(itemStopped(NO_BACKOFF, AT), NO_BACKOFF, 'an item that never played has nothing to judge');
});

test('a hold dated from its baseline stands or not by the window it measured', () => {
  const load = { ...NO_BACKOFF, retries: 5 };
  const now = AT + 6000;
  assert.equal(failureDelay(itemPlaying(load, now - WATCHDOG_MS), now), RECONNECT_BASE_MS);
  assert.equal(failureDelay(itemPlaying(load, now - 500), now), retryDelay(5));
});

test('a clock stepped backwards never reads as an item that stayed up', () => {
  assert.equal(failureDelay(heldAt(3), AT - 3_600_000), retryDelay(3));
});

test('the ceiling is for an item that played: a load that never did keeps the curve', () => {
  assert.equal(failureDelay(heldAt(10), AT + 1000), PLAYED_MAX_MS);
  assert.equal(stallDelay(heldAt(10), AT + 1000), PLAYED_MAX_MS);
  const load = { ...NO_BACKOFF, retries: 10 };
  assert.equal(failureDelay(load, AT), RECONNECT_MAX_MS);
  assert.equal(stallDelay(load, AT), RECONNECT_MAX_MS);
});

test('an item replaced after a failure carries the count; one replaced after a stall keeps it back', () => {
  const failed = itemReplaced(heldAt(3), AT + 1000, true);
  assert.deepEqual(failed, { ...NO_BACKOFF, retries: 4 });
  const stalled = itemReplaced(heldAt(3), AT + 1000, false);
  assert.deepEqual(stalled, { ...NO_BACKOFF, retries: 1, heldRetries: 4 });
  assert.equal(failureDelay(itemPlaying(stalled, AT + 2000), AT + 2500), retryDelay(4));
  // Never played, so it is the load's own failure, and any held count goes with it.
  assert.deepEqual(itemReplaced(stalled, AT + 2000, false), { ...NO_BACKOFF, retries: 2 });
  // Stayed up: the reset stands either way.
  assert.deepEqual(itemReplaced(heldAt(3), AT + STAYED_UP_MS, true), { ...NO_BACKOFF, retries: 1 });
  assert.equal(itemReplaced(heldAt(3), AT + STAYED_UP_MS, false).retries, 1);
});
