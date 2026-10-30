import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  CHURN_MIN_PACE,
  RECONNECT_MAX_MS,
  StreamRecovery,
  WATCHDOG_MIN_PACE,
  WATCHDOG_MS,
  keptPace,
  retryDelay,
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
  const held: Deferred[] = [];
  const logs: string[] = [];
  const counts = { advancing: 0, inFlight: 0, maxInFlight: 0 };
  const recovery = new StreamRecovery({
    position: opts.position ?? (async () => clock.read()),
    reload: async (reason) => {
      reloads.push(reason);
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
  return { recovery, clock, reloads, held, logs, counts, tick };
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

test('a lock-screen Play after a missed interruption end is watched before it plays', async (t) => {
  const h = setup(t);
  await onAir(h);
  h.recovery.onDuck(true); // another app's audio took over, and iOS never ends it
  h.clock.freeze();
  await h.tick(30_000);
  // service.ts reloads the stream, but the new item never starts.
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
  await h.tick(20_000);
  assert.deepEqual(h.reloads, ['tune', 'tune'], 'no watchdog from the first session');
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
