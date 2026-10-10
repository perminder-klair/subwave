import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
test('startup and periodic refresh explicitly use the automatic idle gate', () => {
  const start = scheduler.indexOf('export function startScheduler');
  assert.ok(start >= 0, 'startScheduler must exist');
  const startup = scheduler.slice(start);
  assert.match(startup.split('cron.schedule')[0]!, /refreshAutoPlaylist\(\{ automatic: true \}\)/);
  const periodic = startup.match(/cron\.schedule\(refreshCron, async \(\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(periodic, 'the refresh cron callback must exist');
  assert.match(periodic[1]!, /autoPlaylistRefresh\.refreshScheduled\(\)/);
  assert.match(scheduler, /createAutoPlaylistRefreshRunner\(async \(\) => \{\s*await refreshAutoPlaylist\(\{ automatic: true \}\);\s*\}, playlistRefresh\.isBusy\)/);
  assert.match(periodic[1]!, /Periodic playlist failed/);
});

const { createAutoPlaylistRefresh } = await import('../src/broadcast/auto-playlist-refresh.js');
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

test('manual refresh remains available while idle', async () => {
  const published: string[] = [];
  const c = createAutoPlaylistRefresh({ isIdle: () => true, build: async canPublish => {
    assert.equal(canPublish(), true);
    published.push('manual');
    return 'refreshed';
  } });
  assert.equal(await c.request({ automatic: false }), 'refreshed');
  assert.deepEqual(published, ['manual']);
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
