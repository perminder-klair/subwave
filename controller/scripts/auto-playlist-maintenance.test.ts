import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './test-utils/async.js';
import { readFileSync } from 'node:fs';
import cron from 'node-cron';
import { autoPlaylistRefreshCron, createAutoPlaylistRefreshRunner } from '../src/broadcast/auto-playlist-maintenance.js';
import { createAutoPlaylistRefresh } from '../src/broadcast/auto-playlist-refresh.js';

const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');

test('routine cleanup is off the session boundary and cannot overlap itself', () => {
  assert.match(scheduler, /cron\.schedule\('2 \* \* \* \*', cleanup, \{ noOverlap: true \}\)/);
});


test('default refresh is hourly at :07, with legacy hourly and every-minute compatibility', () => {
  assert.equal(autoPlaylistRefreshCron(60), '7 * * * *');
  assert.equal(autoPlaylistRefreshCron(61), '7 * * * *');
  assert.equal(autoPlaylistRefreshCron(90), '7 * * * *');
  assert.equal(autoPlaylistRefreshCron(1), '* * * * *');
  assert.equal(autoPlaylistRefreshCron(15), '7,22,37,52 * * * *');
});

const gaps = (minutes: number[]) => minutes.map((m, i) =>
  (minutes[(i + 1) % minutes.length] - m + 60) % 60 || 60).sort((a, b) => a - b);

test('every interval 2..60 preserves legacy cadence across hours without :00 or :02', () => {
  for (let interval = 2; interval <= 60; interval++) {
    const expr = autoPlaylistRefreshCron(interval);
    assert.ok(cron.validate(expr), expr);
    const minutes = expr.split(' ')[0].split(',').map(Number);
    const legacy = Array.from({ length: 60 }, (_, m) => m).filter(m => m % interval === 0);
    assert.equal(minutes.length, legacy.length, expr);
    assert.equal(new Set(minutes).size, minutes.length, expr);
    assert.ok(!minutes.includes(0) && !minutes.includes(2), expr);
    assert.deepEqual(gaps(minutes), gaps(legacy), expr);
  }
});



test('idle periodic work starts, repeated busy slots skip without catch-up', async () => {
  const build = deferred();
  let starts = 0;
  const runner = createAutoPlaylistRefreshRunner(() => { starts++; return build.promise; });
  const first = runner.refreshScheduled();
  assert.equal(starts, 1);
  assert.equal(await runner.refreshScheduled(), false);
  assert.equal(await runner.refreshScheduled(), false);
  build.resolve();
  assert.equal(await first, true);
  assert.equal(starts, 1);
  assert.equal(await runner.refreshScheduled(), true);
  assert.equal(starts, 2);
});

for (const scheduledFirst of [false, true]) {
  test(`immediate calls start independently during ${scheduledFirst ? 'periodic' : 'immediate'} work; all builds block periodic admission`, async () => {
    const first = deferred();
    const second = deferred();
    const pending = [first, second];
    const runner = createAutoPlaylistRefreshRunner(() => pending.shift()!.promise);
    const a = scheduledFirst ? runner.refreshScheduled() : runner.refresh();
    const b = runner.refresh();
    assert.equal(pending.length, 0, 'both adapters start before either settles');
    assert.equal(await runner.refreshScheduled(), false);
    first.resolve();
    await a;
    assert.equal(await runner.refreshScheduled(), false, 'second build remains active');
    second.resolve();
    await b;
  });
}

for (const scheduled of [false, true]) {
  test(`${scheduled ? 'periodic' : 'immediate'} failures propagate and release admission`, async () => {
    const first = deferred();
    let starts = 0;
    const runner = createAutoPlaylistRefreshRunner(() => ++starts === 1 ? first.promise : Promise.resolve());
    const call = scheduled ? runner.refreshScheduled() : runner.refresh();
    const error = new Error('build failed');
    const rejected = assert.rejects(call, err => err === error);
    first.reject(error);
    await rejected;
    assert.equal(await runner.refreshScheduled(), true);
    assert.equal(starts, 2);
  });
}

test('only the periodic cron uses scheduled admission; startup and the exported API stay immediate', () => {
  assert.match(scheduler, /export async function refreshAutoPlaylist\(\{ automatic = false \} = \{\}\) \{\s*return playlistRefresh\.request\(\{ automatic \}\);/);
  assert.match(scheduler, /createAutoPlaylistRefreshRunner\(async \(\) => \{\s*await refreshAutoPlaylist\(\{ automatic: true \}\);\s*\}, playlistRefresh\.isBusy\)/);
  assert.match(scheduler, /export function startScheduler\(\) \{\s*refreshAutoPlaylist\(\{ automatic: true \}\)\.catch/);
  assert.match(scheduler, /const refreshCron = autoPlaylistRefreshCron\(config\.show\.autoQueueRefreshMinutes\);\s*cron\.schedule\(refreshCron, async \(\) => \{/);
  assert.match(scheduler, /await autoPlaylistRefresh\.refreshScheduled\(\)/);
  assert.match(scheduler, /Auto-playlist periodic refresh skipped/);
  assert.match(scheduler, /Periodic playlist failed/);
  assert.match(scheduler, /Scheduler started · auto-playlist: \$\{refreshCron\} · cleanup: 2 \* \* \* \*/);
});

test('maintenance leaves talk, session and programme sequencing on their existing clock', () => {
  assert.match(scheduler, /cron\.schedule\('\* \* \* \* \*', talkTick\);/);
  assert.match(scheduler, /if \(now\.getMinutes\(\) === 0\) \{[\s\S]*?await rollSessionNow\(\{ airHandoff: false, reason: 'scheduled boundary' \}\)/);
  assert.ok(scheduler.indexOf('await programme.ensurePlan(ctx);') < scheduler.indexOf('await djAgent.runPersonaHandoff(queue, ctx);'));
  assert.match(scheduler, /cron\.schedule\('23 \* \* \* \*', scheduledBackupTick\);/);
  assert.match(scheduler, /cron\.schedule\('17 4 \* \* \*', nightlyDoctor\);/);
  assert.match(scheduler, /cron\.schedule\('\*\/5 \* \* \* \*', overrideJanitor\);/);
});

test('idle periodic ticks coalesce with show changes into one latest-context resume build', async () => {
  let idle = true;
  let show = 'first';
  const published: string[] = [];
  const writer = createAutoPlaylistRefresh({ isIdle: () => idle, build: async () => {
    published.push(show);
    return 'refreshed';
  } });
  const runner = createAutoPlaylistRefreshRunner(async () => {
    await writer.request({ automatic: true });
  }, writer.isBusy);
  await runner.refreshScheduled();
  show = 'latest';
  await writer.request({ automatic: true });
  await runner.refreshScheduled();
  assert.deepEqual(published, []);
  idle = false;
  await writer.flushPending();
  await writer.flushPending();
  assert.deepEqual(published, ['latest']);
});

test('periodic admission sees active manual and queued show work without creating catch-up work', async () => {
  const first = deferred();
  const second = deferred();
  let starts = 0;
  const writer = createAutoPlaylistRefresh({ isIdle: () => false, build: async () => {
    const gate = ++starts === 1 ? first : second;
    await gate.promise;
    return 'refreshed';
  } });
  const runner = createAutoPlaylistRefreshRunner(async () => {
    await writer.request({ automatic: true });
  }, writer.isBusy);
  const manual = writer.request({ automatic: false });
  // Busy includes a request waiting for its first microtask, not only builds.
  assert.equal(await runner.refreshScheduled(), false);
  const show = writer.request({ automatic: true });
  assert.equal(await runner.refreshScheduled(), false);
  first.resolve();
  await manual;
  assert.equal(await runner.refreshScheduled(), false);
  second.resolve();
  await show;
  assert.equal(writer.isBusy(), false);
  assert.equal(starts, 2, 'both requested builds execute; skipped periodic ticks add no work');
});

test('a resume build blocks periodic work and a failed build releases admission for retry', async () => {
  let idle = true;
  let starts = 0;
  const first = deferred();
  const writer = createAutoPlaylistRefresh({ isIdle: () => idle, build: async () => {
    if (++starts === 1) await first.promise;
    return 'refreshed';
  } });
  const runner = createAutoPlaylistRefreshRunner(async () => {
    await writer.request({ automatic: true });
  }, writer.isBusy);
  await writer.request({ automatic: true });
  idle = false;
  const resume = writer.flushPending();
  assert.equal(await runner.refreshScheduled(), false);
  const rejected = assert.rejects(resume, /catalogue unavailable/);
  first.reject(new Error('catalogue unavailable'));
  await rejected;
  assert.equal(writer.isBusy(), false);
  assert.equal(await runner.refreshScheduled(), true);
  await writer.flushPending();
  assert.equal(starts, 2);
});

test('manual refresh bypasses idle while periodic work skips it and then defers', async () => {
  let idle = true;
  let starts = 0;
  const first = deferred();
  const writer = createAutoPlaylistRefresh({ isIdle: () => idle, build: async canPublish => {
    assert.equal(canPublish(), true);
    if (++starts === 1) await first.promise;
    return 'refreshed';
  } });
  const runner = createAutoPlaylistRefreshRunner(async () => {
    await writer.request({ automatic: true });
  }, writer.isBusy);
  const manual = writer.request({ automatic: false });
  assert.equal(await runner.refreshScheduled(), false);
  first.resolve();
  await manual;
  assert.equal(await runner.refreshScheduled(), true);
  assert.equal(starts, 1, 'the idle periodic tick must not build');
  idle = false;
  await writer.flushPending();
  assert.equal(starts, 2);
});

test('idle automatic requests coalesce and resume builds only the latest context', async () => {
  let idle = true;
  let show = 'first';
  const published: string[] = [];
  let notices = 0;
  const c = createAutoPlaylistRefresh({ isIdle: () => idle, onDeferred: () => { notices++; }, build: async () => { published.push(show); return 'refreshed'; } });
  assert.equal(await c.request({ automatic: true }), 'deferred');
  show = 'second';
  await c.request({ automatic: true });
  show = 'latest';
  await c.flushPending();
  assert.deepEqual(published, []);
  idle = false;
  await c.flushPending();
  await c.flushPending();
  assert.deepEqual(published, ['latest']);
  assert.equal(notices, 1);
});



test('failed refresh rejects but remains retryable on flush', async () => {
  let fail = true;
  const published: string[] = [];
  const c = createAutoPlaylistRefresh({ isIdle: () => false, build: async () => {
    if (fail) throw new Error('catalogue unavailable');
    published.push('retry');
    return 'refreshed';
  } });
  await assert.rejects(c.request({ automatic: true }), /catalogue unavailable/);
  fail = false;
  await c.flushPending();
  assert.deepEqual(published, ['retry']);
});

test('idle entry during build suppresses publication and retains pending work', async () => {
  let idle = false;
  const published: string[] = [];
  let first = true;
  const c = createAutoPlaylistRefresh({ isIdle: () => idle, build: async canPublish => {
    if (first) { idle = true; first = false; }
    if (!canPublish()) return 'deferred';
    published.push('resumed');
    return 'refreshed';
  } });
  assert.equal(await c.request({ automatic: true }), 'deferred');
  assert.deepEqual(published, []);
  idle = false;
  await c.flushPending();
  assert.deepEqual(published, ['resumed']);
});

test('overlapping requests serialize writes and coalesce queued automatic work without losing it', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const blocked = new Promise<void>(r => { release = r; });
  const published: string[] = [];
  let builds = 0;
  const c = createAutoPlaylistRefresh({ isIdle: () => false, build: async () => {
    if (++builds === 1) { started(); await blocked; }
    published.push(`build ${builds}`);
    return 'refreshed';
  } });
  const first = c.request({ automatic: true });
  await entered;
  const next = c.request({ automatic: true });
  const same = c.request({ automatic: true });
  const manual = c.request({ automatic: false });
  assert.deepEqual(published, []);
  release();
  await Promise.all([first, next, same, manual]);
  assert.deepEqual(published, ['build 1', 'build 2', 'build 3']);
});

test('production rechecks idle before replacing watched file, and startup awaits adoption', () => {
  const start = scheduler.indexOf('async function refreshAutoPlaylistInner');
  assert.ok(start >= 0, 'refresh builder must exist');
  const inner = scheduler.slice(start);
  const gate = inner.indexOf("if (!canPublish() || epoch !== autoPlaylistPolicyEpoch || policyKey !== autoPlaylistPolicyKey() || currentKey !== buildKey)");
  const write = inner.indexOf('writeFileAtomicSync(config.liquidsoap.autoPlaylist');
  assert.ok(gate >= 0, 'pre-publication gate must exist');
  assert.ok(write >= 0, 'watched file publication must exist');
  assert.ok(gate < write, 'idle recheck must precede publication');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /await startStreamIdleMonitor\(flushPendingAutoPlaylist\)/);
  const adopt = server.indexOf('await startStreamIdleMonitor(');
  const schedule = server.indexOf('  startScheduler();');
  assert.ok(adopt >= 0, 'awaited adoption must exist');
  assert.ok(schedule >= 0, 'scheduler startup must exist');
  assert.ok(adopt < schedule);
});
