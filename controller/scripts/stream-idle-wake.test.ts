// Idle wake probe (#2072): a listener who tunes in to an idle station wakes the
// programme within one probe interval instead of on the next 5s tick, and the
// probe can never release the pause or move the fail-open budget (#1256).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in Icecast status endpoint. Bound before config is imported, because
// config reads ICECAST_STATUS_URL once at import. `held` parks each request
// until release(); `maxInFlight` is the most it ever served at once, and
// `requests` counts every request that reached it.
let reply = { status: 200, body: '{}' };
let held: (() => void)[] | null = null;
let inFlight = 0;
let maxInFlight = 0;
let requests = 0;
const icecast = createServer((_req, res) => {
  requests++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  res.on('close', () => { inFlight--; });
  const answer = () => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  };
  if (held) held.push(answer);
  else answer();
});
function release() {
  const parked = held ?? [];
  held = null;
  for (const answer of parked) answer();
}
async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
await new Promise<void>(resolve => icecast.listen(0, '127.0.0.1', resolve));
process.env.ICECAST_STATUS_URL =
  `http://127.0.0.1:${(icecast.address() as AddressInfo).port}/status-json.xsl`;
after(() => {
  icecast.closeAllConnections();
  icecast.close();
});

const listeners = await import('../src/broadcast/listeners.js');
const { createStreamIdleMonitor, scheduleStreamIdleMonitor } = await import('../src/broadcast/stream-idle.js');

function status(mounts: Record<string, number>) {
  const source = Object.entries(mounts).map(([mount, n]) => ({
    listenurl: `http://localhost:7702${mount}`,
    listeners: n,
  }));
  return JSON.stringify({ icestats: { source: source.length === 1 ? source[0] : source } });
}

// Runs before anything polls: module state is still "never polled".
test('the probe reads broadcast mounts only and commits nothing', async () => {
  reply = { status: 200, body: status({ '/stream.mp3': 1, '/stream.opus': 2, '/test-mount': 5 }) };
  assert.equal(await listeners.peekListeners(), 3);
  reply = { status: 200, body: status({ '/stream.flac': 1 }) }; // a lone source is an object
  assert.equal(await listeners.peekListeners(), 1);
  assert.equal(listeners.getListenerCount(), null);
  assert.equal(listeners.gatedListenerCount(), null);
  assert.equal(listeners.getStreamStatus().online, false);
});

test('a failed probe reads null and never moves the failure budget', async () => {
  reply = { status: 200, body: status({ '/stream.mp3': 0 }) };
  await listeners.refresh();
  assert.equal(listeners.gatedListenerCount(), 0);

  reply = { status: 500, body: '<html>busy</html>' };
  for (let i = 0; i < 6; i++) assert.equal(await listeners.peekListeners(), null);
  assert.equal(listeners.gatedListenerCount(), 0, 'six failed probes must not read as an outage');
  assert.equal(listeners.getStreamStatus().online, true);

  // The same failures through the committed poll do reach the budget, so the
  // assertions above are measuring something.
  for (let i = 0; i < 4; i++) await listeners.refresh();
  assert.equal(listeners.gatedListenerCount(), null);
});

// Two overlapping status reads are what blew the deadline in #1256, so the
// probe must never send a request beside a committed poll's: not the tick's,
// the 15s monitor's or a request's.
test('the probe and a committed poll never read Icecast at the same time', async () => {
  reply = { status: 200, body: status({ '/stream.mp3': 0 }) };
  maxInFlight = 0;

  // A probe in flight when a poll starts: the poll waits it out.
  held = [];
  const peek = listeners.peekListeners();
  await until(() => held!.length === 1);
  const poll = listeners.refresh();
  await until(() => held!.length === 2, 200);
  release();
  await peek;
  await poll;
  assert.equal(maxInFlight, 1, 'a poll started beside a probe in flight');

  // A poll in flight: the probe stands aside without a request of its own.
  held = [];
  const poll2 = listeners.refresh();
  await until(() => held!.length === 1);
  assert.equal(await listeners.peekListeners(), null);
  release();
  await poll2;
  assert.equal(maxInFlight, 1, 'a probe read beside a committed poll');
});

test('the probe deadline covers a body that never finishes', async () => {
  const stall = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"icestats":');
  });
  await new Promise<void>(resolve => stall.listen(0, '127.0.0.1', resolve));
  const { config } = await import('../src/config.js');
  const statusUrl = config.icecast.statusUrl;
  config.icecast.statusUrl = `http://127.0.0.1:${(stall.address() as AddressInfo).port}/status-json.xsl`;
  try {
    const verdict = await Promise.race([
      listeners.peekListeners(),
      new Promise(resolve => setTimeout(() => resolve('hung'), 3000).unref()),
    ]);
    assert.equal(verdict, null);
  } finally {
    config.icecast.statusUrl = statusUrl;
    stall.closeAllConnections();
    stall.close();
  }
  // A body that blew the deadline backs off like headers that never came.
  const sent = requests;
  assert.equal(await listeners.peekListeners(), null);
  assert.equal(requests, sent, 'a probe went out during the backoff');
});

// Icecast may still be serving a probe whose deadline fired, so the probe goes
// quiet for one 5s tick and leaves a slow Icecast to the tick's own poll.
test('a timed-out probe backs off for one tick, and the tick still catches a listener', async t => {
  const realNow = Date.now;
  let skew = 60_000; // well past the backoff the stalled body above left behind
  t.mock.method(Date, 'now', () => realNow.call(Date) + skew);
  const calls = { off: 0 };
  const monitor = createStreamIdleMonitor({
    idleStatus: async () => true,
    idleOn: async () => {},
    idleOff: async () => { calls.off++; },
    streamSettings: () => ({ idleWhenEmpty: true, idleAfterMinutes: 10 }),
    setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
  });
  await monitor.initialize();

  reply = { status: 200, body: status({ '/stream.mp3': 1 }) };
  held = [];
  assert.equal(await listeners.peekListeners(), null, 'the headers never came');
  held = null; // drop the abandoned request
  const sent = requests;

  skew += 4_500;
  assert.equal(await monitor.wakeProbe(), false);
  assert.equal(requests, sent, 'a probe went out inside the tick interval');
  await monitor.tick();
  assert.equal(calls.off, 1, "the tick's committed poll still wakes the station");
  assert.equal(requests, sent + 1);

  skew += 600;
  assert.equal(await listeners.peekListeners(), 1, 'probing resumes after one tick');
  assert.equal(await listeners.peekListeners(), 1, 'a count read does not back off');

  reply = { status: 500, body: '<html>busy</html>' };
  assert.equal(await listeners.peekListeners(), null);
  reply = { status: 200, body: status({ '/stream.mp3': 1 }) };
  assert.equal(await listeners.peekListeners(), 1, 'a non-OK answer does not back off');

  const refused = createServer();
  await new Promise<void>(resolve => refused.listen(0, '127.0.0.1', resolve));
  const { port } = refused.address() as AddressInfo;
  await new Promise(resolve => refused.close(resolve));
  const { config } = await import('../src/config.js');
  const statusUrl = config.icecast.statusUrl;
  config.icecast.statusUrl = `http://127.0.0.1:${port}/status-json.xsl`;
  try {
    assert.equal(await listeners.peekListeners(), null);
  } finally {
    config.icecast.statusUrl = statusUrl;
  }
  assert.equal(await listeners.peekListeners(), 1, 'a refused connection does not back off');
  assert.equal(requests, sent + 6);
});

// setInterval stand-in: fires due timers in order, draining the async work
// each one starts before the next fires.
function fakeClock() {
  const timers: { run: () => void; ms: number; due: number }[] = [];
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return {
    every: (run: () => void, ms: number) => { timers.push({ run, ms, due: ms }); },
    async advanceTo(t: number) {
      for (;;) {
        const next = timers.reduce<(typeof timers)[number] | null>(
          (a, b) => (a === null || b.due < a.due ? b : a), null);
        if (!next || next.due > t) break;
        next.due += next.ms;
        next.run();
        await flush();
      }
    },
  };
}

function station(opts: {
  paused?: boolean;
  peek: () => Promise<number | null>;
  count: () => number | null;
}) {
  const calls = { off: 0, on: 0, refresh: 0, peek: 0 };
  const monitor = createStreamIdleMonitor({
    idleStatus: async () => opts.paused ?? true,
    idleOn: async () => { calls.on++; },
    idleOff: async () => { calls.off++; },
    refresh: async () => { calls.refresh++; },
    gatedListenerCount: opts.count,
    peekListeners: () => { calls.peek++; return opts.peek(); },
    streamSettings: () => ({ idleWhenEmpty: true, idleAfterMinutes: 10 }),
    setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
  });
  const clock = fakeClock();
  return { monitor, clock, calls, start: () => scheduleStreamIdleMonitor(monitor, clock.every) };
}

test('a listener tuning in while idle wakes the programme within a second, not on the next tick', async () => {
  let joined = false;
  const s = station({
    peek: async () => (joined ? 1 : 0),
    count: () => (joined ? 1 : 0),
  });
  await s.monitor.initialize();
  assert.equal(s.monitor.isIdle(), true);
  s.start();

  await s.clock.advanceTo(1_200);
  joined = true;
  await s.clock.advanceTo(2_000);
  assert.equal(s.calls.off, 1, 'idle_off by the first probe after the listener joined');
  assert.equal(s.monitor.isIdle(), false);
  assert.equal(s.calls.refresh, 1, 'the tick still decides from its own committed poll');

  await s.clock.advanceTo(10_000);
  assert.equal(s.calls.off, 1);
});

test('the probe only brings the tick forward; a committed empty reading keeps the pause', async () => {
  const s = station({ peek: async () => 1, count: () => 0 });
  await s.monitor.initialize();
  s.start();
  await s.clock.advanceTo(10_000);
  assert.equal(s.calls.off, 0);
  assert.equal(s.monitor.isIdle(), true);
  assert.ok(s.calls.on > 0, 'the brought-forward tick re-asserts the gate');
});

test('a failing probe never wakes the station and adds no committed polls', async () => {
  const s = station({ peek: async () => null, count: () => 0 });
  await s.monitor.initialize();
  s.start();
  await s.clock.advanceTo(20_000);
  assert.equal(s.calls.off, 0);
  assert.equal(s.calls.refresh, 4, 'only the 5s ticks poll, exactly as before the probe');
  assert.ok(s.calls.peek >= 15);
});

test('a hung probe never costs the tick its slot, and probes do not stack', async () => {
  const s = station({ peek: () => new Promise<number | null>(() => {}), count: () => 0 });
  await s.monitor.initialize();
  s.start();
  await s.clock.advanceTo(10_000);
  assert.equal(s.calls.refresh, 2);
  assert.equal(s.calls.peek, 1);
});

test('no probe I/O while the programme is live', async () => {
  const s = station({ paused: false, peek: async () => 1, count: () => 1 });
  await s.monitor.initialize();
  assert.equal(s.monitor.isIdle(), false);
  s.start();
  await s.clock.advanceTo(10_000);
  assert.equal(s.calls.peek, 0);
  assert.equal(s.calls.refresh, 0);
});
