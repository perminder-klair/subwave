// What the queue does when the programme resumes into a different show than
// the one it paused in (stream-idle.ts reports it; server.ts calls this after
// the fallback has been rebuilt and reloaded).
//
// Run: npm test -- resume-show-change

import assert from 'node:assert/strict';
import test from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import { createStreamIdleMonitor } from '../src/broadcast/stream-idle.js';
import { resumeIntoAnotherShow } from '../src/broadcast/resume-show.js';
import { deferred } from './test-utils/async.js';

// Same neutralisation the other queue tests use.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ track: { id, title: id, artist: 'x' }, sent: false, showKey: 'show:earlier', ...extra }) as any;

// Every pick is stamped with the show it was chosen for; these were chosen for
// the earlier show unless a test says otherwise.
const ON_AIR = 'show:on-air';
// The frozen-track skip waits for an unsent head to commit; nothing drains here.
(queue as any).commitBeforeSkip = async () => ({ pending: false, committed: true, waitedMs: 0 });

function onAir(current: any, upcoming: any[]) {
  queue.current = current;
  queue.upcoming = upcoming;
}

test('picks made for the earlier show are dropped and the frozen track is skipped', async () => {
  onAir(item('frozen'), [item('a'), item('b')]);
  let skips = 0;
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => { skips += 1; });
  assert.deepEqual(queue.upcoming, []);
  assert.equal(skips, 1);
  assert.deepEqual(result, { dropped: 2, kept: 0, skipped: true });
});

test('a request someone asked for survives, on air or queued', async () => {
  const asked = item('asked', { requestedBy: 'Anna' });
  const studio = item('studio', { requestedBy: 'studio', operator: true });
  onAir(item('requested-on-air', { requestedBy: 'Anna' }), [item('a'), asked, studio]);
  let skips = 0;
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => { skips += 1; });
  assert.deepEqual(queue.upcoming, [asked, studio]);
  assert.equal(skips, 0, 'a requested track on air plays out');
  assert.deepEqual(result, { dropped: 1, kept: 0, skipped: false });
});

for (const [name, extra] of [
  ['listener request', { requestedBy: 'Anna' }],
  ['studio pick', { requestedBy: 'studio', operator: true }],
  ['new-show pick', { showKey: ON_AIR }],
] as const) {
  test(`a ${name} that starts during skip preparation plays out`, async t => {
    const prepared = deferred<Awaited<ReturnType<typeof queue.commitBeforeSkip>>>();
    t.mock.method(queue, 'commitBeforeSkip', () => prepared.promise);
    const next = item('next', extra);
    onAir(item('frozen'), [next]);
    let skips = 0;
    const pending = queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => { skips += 1; });
    onAir({ ...next }, []);
    prepared.resolve({ pending: false, committed: false, waitedMs: 500 });
    assert.deepEqual(await pending, { dropped: 0, kept: 0, skipped: false });
    assert.equal(skips, 0, 'skip preparation cannot authorise cutting a different track');
  });
}

test('what the new show picked while the fallback rebuilt is left alone', async () => {
  onAir(item('frozen'), [item('old')]);
  const stale = queue.snapshotProgramme(ON_AIR);
  // The rebuild takes seconds: the frozen track ends and the new show picks.
  const fresh = item('fresh');
  onAir(item('new-show-track', { showKey: ON_AIR }), [fresh]);
  let skips = 0;
  const result = await queue.dropProgrammeFromEarlierShow(stale, async () => { skips += 1; });
  assert.deepEqual(queue.upcoming, [fresh]);
  assert.equal(skips, 0, 'the track now on air belongs to the new show');
  assert.deepEqual(result, { dropped: 0, kept: 0, skipped: false });
});

for (const [name, showKey] of [
  ['incoming-show pick', ON_AIR],
  ['track with unknown ownership', undefined],
] as const) {
  test(`the ${name} starting during idle release plays out`, async () => {
    const releasing = deferred<void>();
    const acknowledged = deferred<void>();
    const cleaned = deferred<Awaited<ReturnType<typeof queue.dropProgrammeFromEarlierShow>>>();
    const fresh = item('fresh', { showKey });
    const old = item('old');
    onAir(item('frozen'), [old]);
    let skips = 0;
    const monitor = createStreamIdleMonitor({
      idleStatus: async () => true,
      idleOff: () => { releasing.resolve(); return acknowledged.promise; },
      refresh: async () => {}, gatedListenerCount: () => 1,
      streamSettings: () => ({ idleWhenEmpty: true }),
      setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
      showKeyAt: () => ON_AIR,
      onResume: async ({ showChanged }) => {
        if (!showChanged) throw new Error('expected changed-show cleanup');
        await resumeIntoAnotherShow({
          snapshot: () => queue.snapshotProgramme(ON_AIR),
          rebuild: async () => 'refreshed',
          ready: async () => true,
          drop: async stale => {
            cleaned.resolve(await queue.dropProgrammeFromEarlierShow(stale, async () => { skips++; }));
          },
          log: () => {},
        });
      },
    });
    await monitor.initialize();
    const tick = monitor.tick();
    await releasing.promise;
    queue.current = fresh;
    acknowledged.resolve();
    await tick;
    assert.deepEqual(await cleaned.promise, { dropped: 1, kept: 0, skipped: false });
    assert.equal(skips, 0);
    assert.equal(queue.current, fresh);
  });
}

test('an earlier-show pick that started while the fallback rebuilt is skipped', async () => {
  const old = item('old');
  onAir(item('frozen'), [old]);
  const stale = queue.snapshotProgramme(ON_AIR);
  // The frozen track ends during the rebuild and the next earlier-show pick starts.
  onAir(old, []);
  let skips = 0;
  const result = await queue.dropProgrammeFromEarlierShow(stale, async () => { skips += 1; });
  assert.equal(skips, 1);
  assert.deepEqual(result, { dropped: 0, kept: 0, skipped: true });
});

test('without a skip the picks go and the frozen track stays on air', async () => {
  onAir(item('frozen'), [item('a')]);
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), null);
  assert.deepEqual(queue.upcoming, []);
  assert.deepEqual(result, { dropped: 1, kept: 0, skipped: false });
});

test('a pick the mixer will not give back is reported as kept', async () => {
  const stuck = item('stuck');
  onAir(item('frozen'), [stuck]);
  const stale = queue.snapshotProgramme(ON_AIR);
  (queue as any).removeUpcomingItem = async () => ({ ok: false, reason: 'already-playing' });
  try {
    let skips = 0;
    const result = await queue.dropProgrammeFromEarlierShow(stale, async () => { skips += 1; });
    assert.deepEqual(result, { dropped: 0, kept: 1, skipped: false });
    assert.equal(skips, 0, 'the kept pick airs next anyway, so the frozen track plays out');
  } finally {
    delete (queue as any).removeUpcomingItem;
  }
});

test('a failed skip is reported, not thrown', async () => {
  onAir(item('frozen'), [item('a')]);
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => { throw new Error('telnet down'); });
  assert.deepEqual(result, { dropped: 1, kept: 0, skipped: false });
});

test('a pick chosen for the show on air stays, wherever it sits in the queue', async () => {
  const old = item('old', { aiPicked: true });
  const forNow = item('for-now', { aiPicked: true, showKey: ON_AIR });
  onAir(item('frozen'), [old, forNow]);
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => {});
  assert.deepEqual(queue.upcoming, [forNow]);
  assert.deepEqual(result, { dropped: 1, kept: 0, skipped: true });
});

test('resume: snapshot first, drop only after a confirmed rebuild', async () => {
  const { resumeIntoAnotherShow } = await import('../src/broadcast/resume-show.js');
  const order: string[] = [];
  const run = (result: 'refreshed' | 'unreloaded' | 'deferred') => resumeIntoAnotherShow({
    snapshot: () => { order.push('snapshot'); return { current: null, upcoming: [] }; },
    rebuild: async () => { order.push('rebuild'); return result; },
    ready: async () => { order.push('ready'); return true; },
    drop: async (_stale, { skip }) => { order.push(`drop:${skip}`); },
    log: line => order.push(`log:${line.slice(0, 12)}`),
  });
  assert.equal(await run('refreshed'), true);
  assert.deepEqual(order.splice(0), ['snapshot', 'rebuild', 'ready', 'drop:true']);
  for (const result of ['unreloaded', 'deferred'] as const) {
    assert.equal(await run(result), false, result);
    assert.deepEqual(order.splice(0), ['snapshot', 'rebuild', 'log:show changed'], result);
  }
});

test('resume: the skip waits until the new fallback has a track ready', async () => {
  const { resumeIntoAnotherShow } = await import('../src/broadcast/resume-show.js');
  const order: string[] = [];
  const answers = [false, false, true];
  await resumeIntoAnotherShow({
    snapshot: () => ({ current: null, upcoming: [] }),
    rebuild: async () => 'refreshed',
    ready: async () => { const r = answers.shift()!; order.push(`ready:${r}`); return r; },
    drop: async (_stale, { skip }) => { order.push(`drop:${skip}`); },
    log: line => order.push(`log:${line}`),
    pollMs: 1,
  });
  // The fresh playlist fetches its first track after the reload; skipping
  // before it is ready would air the emergency loop until it arrives.
  assert.deepEqual(order, ['ready:false', 'ready:false', 'ready:true', 'drop:true']);
});

test('resume: a fallback that never gets ready drops the picks but not the track on air', async () => {
  const { resumeIntoAnotherShow } = await import('../src/broadcast/resume-show.js');
  const order: string[] = [];
  await resumeIntoAnotherShow({
    snapshot: () => ({ current: null, upcoming: [] }),
    rebuild: async () => 'refreshed',
    ready: async () => false,
    drop: async (_stale, { skip }) => { order.push(`drop:${skip}`); },
    log: () => order.push('log'),
    pollMs: 1,
    waitMs: 10,
  });
  // A skip would air the emergency loop until the new fallback has a track.
  assert.deepEqual(order, ['log', 'drop:false']);
});
