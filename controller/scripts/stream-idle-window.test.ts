// GET /state's `streamIdleWindow` (#2072): the latest idle pause as ages, from
// which the web player sizes its skip over a woken station's stale silence.
// Each stamp errs toward a smaller skip: a pause counts from the mixer
// acknowledging it, a resume from the command going out, and a pause the
// monitor can no longer vouch for is withdrawn: new mounts (a restart the
// controller made, or a committed status poll showing the MP3 mount's
// stream_start changed or unknown) and a command the mixer did not confirm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamIdleMonitor } from '../src/broadcast/stream-idle.js';

// Icecast-KH 2.4.0-kh22's stream_start, as the rig gave it.
const MOUNT_A = '29/Oct/2026:11:58:12 +0000';
const MOUNT_B = '29/Oct/2026:11:58:22 +0000';
const MOUNT_C = '29/Oct/2026:11:58:31 +0000';

function fixture(opts: { status?: Promise<boolean>; failOn?: boolean } = {}) {
  let now = 50_000;
  let count: number | null = 0;
  let enabled = true;
  let failOn = opts.failOn ?? false;
  let failOff = false;
  // While set, idle_off's answer waits for it (holdOff).
  let offAnswer: Promise<void> | null = null;
  // The MP3 mount's stream_start as the last committed poll saw it.
  let mounts: string | null = MOUNT_A;
  // What the coming refresh() polls will see, in order; none queued, unchanged.
  const polls: (string | null)[] = [];
  const monitor = createStreamIdleMonitor({
    clock: () => now,
    idleStatus: () => opts.status ?? Promise.resolve(false),
    idleOn: async () => {
      // The command takes a moment: the stamp is when the mixer answered.
      now += 30;
      if (failOn) throw new Error('telnet unavailable');
    },
    idleOff: async () => {
      now += 30;
      if (offAnswer) await offAnswer;
      if (failOff) throw new Error('telnet unavailable');
    },
    refresh: async () => {
      if (polls.length) mounts = polls.shift() ?? null;
    },
    mountStart: () => mounts,
    gatedListenerCount: () => count,
    streamSettings: () => ({ idleWhenEmpty: enabled, idleAfterMinutes: 1 }),
    setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
  });
  return {
    monitor,
    advance: (ms: number) => { now += ms; },
    listeners: (n: number | null) => { count = n; },
    enable: (on: boolean) => { enabled = on; },
    failOn: (fail: boolean) => { failOn = fail; },
    failOff: (fail: boolean) => { failOff = fail; },
    // Holds idle_off's answer until the returned release is called.
    holdOff: () => {
      let release = () => {};
      offAnswer = new Promise<void>(resolve => { release = resolve; });
      return () => { offAnswer = null; release(); };
    },
    mounts: (m: string | null) => { mounts = m; },
    nextPolls: (...m: (string | null)[]) => { polls.push(...m); },
  };
}

// The pause needs the empty room for a full minute of wall clock, which
// nextIdleState reads from Date.now(), so drive it with a minute already past.
async function pauseNow(f: ReturnType<typeof fixture>) {
  f.listeners(0);
  await f.monitor.tick(); // starts the empty-room clock
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await f.monitor.tick();
  } finally {
    Date.now = realNow;
  }
}

test('null before the first pause since boot', async () => {
  const f = fixture();
  await f.monitor.initialize();
  assert.equal(f.monitor.idleWindow(), null);
  f.listeners(3);
  await f.monitor.tick();
  assert.equal(f.monitor.idleWindow(), null);
});

test('a pause is aged from the mixer acknowledging it, its resume from the command going out', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  assert.equal(f.monitor.isIdle(), true);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });

  f.advance(600_000);
  f.listeners(1);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), false);
  // Paused 600s plus the resume command's own 30ms. The mixer can resume
  // before it answers, so the resume counts from the command going out.
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 600_030, endedMsAgo: 30 });

  f.advance(12_000);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 612_030, endedMsAgo: 12_030 });
  // A re-assert or a live tick moves nothing.
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 612_030, endedMsAgo: 12_030 });
});

test('a resume reads as ended while idle_off still awaits the mixer\'s answer', async () => {
  // The mixer resumes ~0.25s after the command and may answer up to the 2s
  // telnet timeout later. A /state read in between that saw the pause still
  // running would count the resume from itself, after the music started.
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  f.listeners(1);
  let release = f.holdOff();
  let resuming = f.monitor.tick();
  await new Promise(r => setImmediate(r));
  f.advance(1_750);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 601_780, endedMsAgo: 1_780 });
  release();
  await resuming;
  assert.equal(f.monitor.isIdle(), false);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 601_780, endedMsAgo: 1_780 });

  // One the mixer never confirms is withdrawn once the command fails.
  const g = fixture();
  await g.monitor.initialize();
  await pauseNow(g);
  g.advance(600_000);
  g.listeners(1);
  release = g.holdOff();
  resuming = g.monitor.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(g.monitor.idleWindow()?.endedMsAgo, 30);
  g.failOff(true);
  release();
  await resuming;
  assert.equal(g.monitor.isIdle(), true);
  assert.equal(g.monitor.idleWindow(), null);
});

test('a new pause replaces the last window', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(5_000);
  f.listeners(1);
  await f.monitor.tick();
  f.advance(90_000);
  await pauseNow(f);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
  // Still paused: the re-assert does not restart the age.
  f.advance(7_000);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), true);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 7_030, endedMsAgo: null });
});

test('a pause the mixer refused records nothing', async () => {
  const f = fixture({ failOn: true });
  await f.monitor.initialize();
  await pauseNow(f);
  assert.equal(f.monitor.isIdle(), false);
  assert.equal(f.monitor.idleWindow(), null);
});

test('disabling idle mid-pause ends the window like a listener would', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(40_000);
  f.enable(false);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 40_030, endedMsAgo: 30 });
});

test('an adopted pause counts from boot, never earlier', async () => {
  const f = fixture({ status: Promise.resolve(true) });
  await f.monitor.initialize();
  assert.equal(f.monitor.isIdle(), true);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
  f.advance(4_000);
  f.listeners(1);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 4_030, endedMsAgo: 30 });
});

test('a startup release records nothing: the mixer may never have been paused', async () => {
  const f = fixture({ status: new Promise<boolean>(() => {}) });
  await f.monitor.initialize(1);
  f.listeners(1);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), false);
  assert.equal(f.monitor.idleWindow(), null);
});

test('new mounts mid-pause withdraw it until the new mixer is paused again', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  // A mixer restart (or the stream started): the mounts are younger than any
  // buffer, and a restarted mixer boots live, so a burst now holds music.
  f.monitor.mountsRestarted();
  assert.equal(f.monitor.idleWindow(), null);
  // Still empty: the re-assert that silences the new mixer starts the pause.
  f.advance(4_000);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), true);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
  f.advance(5_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 5_030, endedMsAgo: null });
  f.advance(30_000);
  f.listeners(1);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 35_060, endedMsAgo: 30 });
});

test('new mounts while live withdraw a recent pause too', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(60_000);
  f.listeners(1);
  await f.monitor.tick();
  f.advance(10_000);
  f.monitor.mountsRestarted();
  assert.equal(f.monitor.idleWindow(), null);
  await f.monitor.tick();
  assert.equal(f.monitor.idleWindow(), null);
});

test('a re-assert the mixer did not confirm withdraws the pause until one it does', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  // Telnet down mid-pause: the mixer may be restarting, and comes back live.
  f.failOn(true);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), true);
  assert.equal(f.monitor.idleWindow(), null);
  f.failOn(false);
  f.advance(5_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
});

test('a resume the mixer did not confirm withdraws the pause: it may have landed', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  f.failOff(true);
  f.listeners(1);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), true);
  assert.equal(f.monitor.idleWindow(), null);
  f.failOff(false);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), false);
  assert.equal(f.monitor.idleWindow(), null);
});

// The stream_start detector: restarts the controller did not cause (a crash,
// `docker restart`) leave telnet down for ~1.9s, between two 5s ticks.

test('a quiet pause keeps its window while the MP3 mount is unchanged', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  // Ten minutes of 5s idle ticks, each after a committed poll of the same mount.
  for (let i = 0; i < 120; i++) {
    f.advance(5_000);
    await f.monitor.tick();
    assert.notEqual(f.monitor.idleWindow(), null, `withdrawn at tick ${i}`);
  }
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 600_000 + 120 * 30, endedMsAgo: null });
  // Then a restart nobody announced: the next poll shows a new mount.
  f.mounts(MOUNT_B);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
});

test('a new stream_start withdraws the pause until a re-assert on the new mount', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  // The container restarted between ticks; the next idle poll sees it.
  f.mounts(MOUNT_B);
  assert.equal(f.monitor.idleWindow(), null, 'a /state read applies the poll at once');
  // The tick re-asserts idle on the new mixer, which booted live, and restamps.
  f.advance(2_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
  f.advance(30_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 30_030, endedMsAgo: null });
});

test('a mount that vanished, a missing field or a failed poll withdraws the pause', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(600_000);
  f.mounts(null);
  await f.monitor.tick();
  assert.equal(f.monitor.isIdle(), true);
  assert.equal(f.monitor.idleWindow(), null);
  // Restamped while still unknown: still not published.
  f.advance(5_000);
  await f.monitor.tick();
  assert.equal(f.monitor.idleWindow(), null);
  // The mount is readable again (the same one): the next re-assert ties to it.
  f.mounts(MOUNT_A);
  f.advance(5_000);
  assert.equal(f.monitor.idleWindow(), null);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
});

test('the first reading after boot never vouches for a pause adopted before it', async () => {
  const f = fixture({ status: Promise.resolve(true) });
  // No committed poll has landed when the pause is adopted.
  f.mounts(null);
  await f.monitor.initialize();
  assert.equal(f.monitor.isIdle(), true);
  // The first reading arrives; the adopted pause cannot be tied to it.
  f.mounts(MOUNT_A);
  f.advance(30_000);
  assert.equal(f.monitor.idleWindow(), null);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
});

// A poll after the mixer answered may see a mixer that restarted since and
// booted live, so tying the stamp to it would vouch for a pause that mixer
// never held.
test('a stamp is tied to a poll from before the mixer answered, never a later one', async () => {
  const f = fixture();
  await f.monitor.initialize();
  // The mixer answers idle_on, then restarts before the next committed poll.
  f.nextPolls(MOUNT_B);
  await pauseNow(f);
  f.advance(5_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null }, 'restamped on the new mixer');
  // The same for a restamp: a failed poll withdraws the pause, the next sees
  // the same mount, and the mixer restarts after answering the re-assert.
  f.mounts(null);
  assert.equal(f.monitor.idleWindow(), null);
  f.nextPolls(MOUNT_B, MOUNT_C);
  f.advance(5_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null });
  f.advance(5_000);
  await f.monitor.tick();
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 0, endedMsAgo: null }, 'restamped on the newer mixer');
});

test('a new mount after the room filled withdraws the ended pause too', async () => {
  const f = fixture();
  await f.monitor.initialize();
  await pauseNow(f);
  f.advance(60_000);
  f.listeners(1);
  await f.monitor.tick();
  f.advance(5_000);
  assert.deepEqual(f.monitor.idleWindow(), { startedMsAgo: 65_030, endedMsAgo: 5_030 });
  // The 15s monitor's poll, no tick: a /state read applies it.
  f.mounts(MOUNT_B);
  assert.equal(f.monitor.idleWindow(), null);
});
