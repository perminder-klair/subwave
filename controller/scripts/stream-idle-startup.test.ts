// Startup recovery and resume ordering keep a surviving mixer from staying paused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamIdleMonitor } from '../src/broadcast/stream-idle.js';

function pausedMixer(status: Promise<boolean>, enabled = true, count: number | null = 1, onResume?: () => Promise<void>) {
  let paused = true;
  let offCalls = 0;
  let onCalls = 0;
  let resumes = 0;
  let failOff = false;
  const monitor = createStreamIdleMonitor({
    idleStatus: () => status,
    idleOff: async () => {
      offCalls++;
      if (failOff) throw new Error('telnet unavailable');
      paused = false;
    },
    idleOn: async () => { onCalls++; paused = true; },
    refresh: async () => {},
    gatedListenerCount: () => count,
    streamSettings: () => ({ idleWhenEmpty: enabled, idleAfterMinutes: 1 }),
    setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
    onResume: async () => { resumes++; await onResume?.(); },
  });
  return {
    monitor,
    snapshot: () => ({ paused, offCalls, onCalls, resumes }),
    failRelease: (fail: boolean) => { failOff = fail; },
  };
}

for (const [name, enabled, count] of [
  ['listener connected', true, 1],
  ['pausing disabled', false, 0],
  ['listener count unknown', true, null],
] as const) {
  test(`slow startup status cannot strand the mixer when ${name}`, async () => {
    let respond!: (idle: boolean) => void;
    const fixture = pausedMixer(new Promise<boolean>(resolve => { respond = resolve; }), enabled, count);
    await fixture.monitor.initialize(1);
    assert.equal(fixture.monitor.isIdle(), false, 'startup must finish before the status response');
    respond(true);
    await new Promise(resolve => setImmediate(resolve));
    await fixture.monitor.tick();
    await fixture.monitor.tick();
    assert.equal(fixture.monitor.isIdle(), false);
    assert.deepEqual(fixture.snapshot(), { paused: false, offCalls: 1, onCalls: 0, resumes: 1 });
  });
}

test('startup release does not wait for status, and a later reply cannot re-adopt the pause', async () => {
  let respond!: (idle: boolean) => void;
  const fixture = pausedMixer(new Promise<boolean>(resolve => { respond = resolve; }));
  await fixture.monitor.initialize(1);
  await fixture.monitor.tick();
  assert.deepEqual(fixture.snapshot(), { paused: false, offCalls: 1, onCalls: 0, resumes: 1 });
  respond(true);
  await new Promise(resolve => setImmediate(resolve));
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), false);
  assert.equal(fixture.snapshot().offCalls, 1);
});

test('failed startup release retries without reporting resume until the mixer accepts it', async () => {
  const fixture = pausedMixer(new Promise<boolean>(() => {}));
  fixture.failRelease(true);
  await fixture.monitor.initialize(1);
  await fixture.monitor.tick();
  await fixture.monitor.tick();
  assert.deepEqual(fixture.snapshot(), { paused: true, offCalls: 2, onCalls: 0, resumes: 0 });
  fixture.failRelease(false);
  await fixture.monitor.tick();
  await fixture.monitor.tick();
  assert.deepEqual(fixture.snapshot(), { paused: false, offCalls: 3, onCalls: 0, resumes: 1 });
});

test('rejected startup status also releases the surviving mixer on the next tick', async () => {
  const fixture = pausedMixer(Promise.reject(new Error('status unavailable')));
  await fixture.monitor.initialize();
  await fixture.monitor.tick();
  assert.deepEqual(fixture.snapshot(), { paused: false, offCalls: 1, onCalls: 0, resumes: 1 });
});

test('a confirmed startup pause stays held while the room is empty', async () => {
  const fixture = pausedMixer(Promise.resolve(true), true, 0);
  await fixture.monitor.initialize();
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), true);
  assert.deepEqual(fixture.snapshot(), { paused: true, offCalls: 0, onCalls: 1, resumes: 0 });
});

test('an empty room gets the full idle grace window after startup release succeeds', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const fixture = pausedMixer(new Promise<boolean>(() => {}), true, 0);
  fixture.failRelease(true);
  await fixture.monitor.initialize(1);
  for (let attempt = 0; attempt < 4; attempt++) {
    await fixture.monitor.tick();
    now += 60_000;
  }
  assert.deepEqual(fixture.snapshot(), { paused: true, offCalls: 4, onCalls: 0, resumes: 0 });
  fixture.failRelease(false);
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), false);
  assert.equal(fixture.snapshot().paused, false);
  now += 59_999;
  await fixture.monitor.tick();
  assert.equal(fixture.snapshot().onCalls, 0);
  now++;
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), true);
  assert.deepEqual(fixture.snapshot(), { paused: true, offCalls: 5, onCalls: 1, resumes: 1 });
});

test('startup adopts a confirmed mixer pause before resolving', async () => {
  let respond!: (idle: boolean) => void;
  const fixture = pausedMixer(new Promise<boolean>(resolve => { respond = resolve; }));
  const init = fixture.monitor.initialize();
  assert.equal(fixture.monitor.isIdle(), false);
  respond(true);
  await init;
  assert.equal(fixture.monitor.isIdle(), true);
});

for (const [name, enabled, count] of [
  ['connect', true, 1], ['toggle-off', false, 0], ['unknown fail-open', true, null],
] as const) {
  test(`${name} resumes before background refresh completes; failure stays live`, async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let flushed = false;
    const fixture = pausedMixer(Promise.resolve(true), enabled, count, async () => {
      assert.equal(fixture.monitor.isIdle(), false);
      flushed = true;
      await pending;
      throw new Error('refresh failed');
    });
    await fixture.monitor.initialize();
    await fixture.monitor.tick();
    assert.equal(fixture.monitor.isIdle(), false);
    assert.equal(flushed, true);
    release();
    await new Promise(resolve => setImmediate(resolve));
    await fixture.monitor.tick();
    assert.equal(fixture.monitor.isIdle(), false);
  });
}

test('failed idleOff holds a confirmed pause without flushing, then retries', async () => {
  const fixture = pausedMixer(Promise.resolve(true));
  fixture.failRelease(true);
  await fixture.monitor.initialize();
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), true);
  assert.equal(fixture.snapshot().resumes, 0);
  fixture.failRelease(false);
  await fixture.monitor.tick();
  assert.equal(fixture.monitor.isIdle(), false);
  assert.equal(fixture.snapshot().resumes, 1);
});
