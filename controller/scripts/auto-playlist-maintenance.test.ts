import test from 'node:test';
import assert from 'node:assert/strict';
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


function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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
