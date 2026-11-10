import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIdRotationRecovery,
  detectRotatedNavidromeId,
} from '../src/music/id-rotation-recovery.js';
import { refreshTaggerFallback, runTaggerFollowups } from '../src/broadcast/tagger-followups.js';

const OLD_ID = 'KhehcqGKwAIL6Ux3Ah0yDC';
const NEW_ID = '6owyzFEyktb6jxHvAYbn6w';

test('a missing legacy id whose canonical id resolves is a confirmed Navidrome rotation', async () => {
  const calls: string[] = [];
  const evidence = await detectRotatedNavidromeId(OLD_ID, async (id) => {
    calls.push(id);
    if (id === OLD_ID) throw new Error('Subsonic error: Song not found');
    return { id: NEW_ID, title: 'Memory Bank', artist: 'Jethro Tull' };
  });

  assert.deepEqual(calls, [OLD_ID, NEW_ID]);
  assert.deepEqual(evidence, { storedId: OLD_ID, canonicalId: NEW_ID });
});

test('fixed-point IDs and ordinary missing tracks do not look like rotations', async () => {
  let calls = 0;
  assert.equal(await detectRotatedNavidromeId(NEW_ID, async () => {
    calls++;
    return { id: NEW_ID };
  }), null);
  assert.equal(calls, 0, 'a current canonical id needs no network probe');

  assert.equal(await detectRotatedNavidromeId(OLD_ID, async () => {
    calls++;
    throw new Error('origin unavailable');
  }), null);
  assert.equal(calls, 1, 'a generic outage must not spend a canonical lookup or trigger recovery');
});

test('a legacy-shaped ID that still resolves is not treated as rotated', async () => {
  const calls: string[] = [];
  const evidence = await detectRotatedNavidromeId(OLD_ID, async (id) => {
    calls.push(id);
    return { id };
  });
  assert.equal(evidence, null);
  assert.deepEqual(calls, [OLD_ID]);
});

test('a transient stored-ID lookup failure is not mistaken for a missing song', async () => {
  const evidence = await detectRotatedNavidromeId(OLD_ID, async (id) => {
    if (id === OLD_ID) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    return { id: NEW_ID };
  });
  assert.equal(evidence, null);
});

test('Subsonic code 70 proves a missing song even without the usual message', async () => {
  assert.deepEqual(await detectRotatedNavidromeId(OLD_ID, async id => {
    if (id === OLD_ID) throw Object.assign(new Error('Unavailable item'), { subsonicCode: 70 });
    return { id: NEW_ID };
  }), { storedId: OLD_ID, canonicalId: NEW_ID });
});

test('authentication errors and absent or mismatched replacements never start recovery', async () => {
  let lookups = 0;
  assert.equal(await detectRotatedNavidromeId(OLD_ID, async () => {
    lookups++;
    throw Object.assign(new Error('Wrong password'), { subsonicCode: 40 });
  }), null);
  assert.equal(lookups, 1);
  for (const replacement of [null, { id: 'another-song' }]) {
    assert.equal(await detectRotatedNavidromeId(OLD_ID, async id => {
      if (id === OLD_ID) throw new Error('Song not found');
      return replacement;
    }), null);
  }
});

test('confirmed rotation starts one automatic reconcile and suppresses duplicate failures', async () => {
  let starts = 0;
  const logs: string[] = [];
  const recovery = createIdRotationRecovery({
    maintenanceRunning: () => false,
    getSong: async (id) => {
      if (id === OLD_ID) throw new Error('Subsonic error: Song not found');
      return { id: NEW_ID };
    },
    startReconcile: () => { starts++; return true; },
    log: (message) => logs.push(message),
  });

  assert.equal(await recovery.inspect({ id: OLD_ID, title: 'Memory Bank', artist: 'Jethro Tull' }), 'started');
  assert.equal(await recovery.inspect({ id: OLD_ID }), 'already-started');
  assert.equal(starts, 1);
  assert.match(logs[0], /Navidrome rotated its track IDs/);
  assert.match(logs[0], /reconciling the library automatically/);
});

test('recovery stands down during maintenance and retries after an automatic reconcile fails', async () => {
  let running = true;
  let lookups = 0;
  let starts = 0;
  const recovery = createIdRotationRecovery({
    maintenanceRunning: () => running,
    getSong: async (id) => {
      lookups++;
      if (id === OLD_ID) throw new Error('Song not found');
      return { id: NEW_ID };
    },
    startReconcile: () => { starts++; return true; },
    log: () => {},
  });

  assert.equal(await recovery.inspect({ id: OLD_ID }), 'busy');
  assert.equal(lookups, 0, 'do not probe while another library writer owns the slot');
  running = false;
  assert.equal(await recovery.inspect({ id: OLD_ID }), 'started');
  recovery.automaticReconcileFailed();
  assert.equal(await recovery.inspect({ id: OLD_ID }), 'started');
  assert.equal(starts, 2);
});

test('concurrent resolution failures share one rotation check', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let lookups = 0;
  let starts = 0;
  const recovery = createIdRotationRecovery({
    maintenanceRunning: () => false,
    getSong: async (id) => {
      lookups++;
      if (id === OLD_ID) {
        await held;
        throw new Error('Song not found');
      }
      return { id: NEW_ID };
    },
    startReconcile: () => { starts++; return true; },
    log: () => {},
  });

  const first = recovery.inspect({ id: OLD_ID });
  assert.equal(await recovery.inspect({ id: OLD_ID }), 'checking');
  release();
  assert.equal(await first, 'started');
  assert.equal(lookups, 2);
  assert.equal(starts, 1);
});

test('manual maintenance starting during a lookup wins the slot without latching recovery', async () => {
  let running = false;
  let starts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const recovery = createIdRotationRecovery({
    maintenanceRunning: () => running,
    getSong: async id => {
      if (id === OLD_ID) {
        await held;
        throw new Error('Song not found');
      }
      return { id: NEW_ID };
    },
    startReconcile: () => { starts++; return true; },
    log: () => {},
  });
  const pending = recovery.inspect({ id: OLD_ID });
  running = true;
  release();
  assert.equal(await pending, 'busy');
  assert.equal(starts, 0);
  running = false;
  assert.equal(await recovery.inspect({ id: OLD_ID }), 'started');
  assert.equal(starts, 1);
});

test('a successful reconcile refreshes the fallback playlist after state migration', async () => {
  const calls: string[] = [];
  await runTaggerFollowups({
    mode: 'reconcile',
    outcome: 'ok',
    rotationSettled: true,
    invalidatePools: () => { calls.push('invalidate'); },
    syncPlaylists: async () => { calls.push('sync'); },
    refreshAutoPlaylist: async () => { calls.push('refresh'); },
    logError: (message) => { calls.push(`error:${message}`); },
  });

  assert.deepEqual(calls, ['invalidate', 'refresh', 'sync'], 'restore the on-air fallback before recipe maintenance');
});

test('an unsettled journal leaves pools and the fallback untouched', async () => {
  const calls: string[] = [];
  assert.equal(await refreshTaggerFallback({
    rotationSettled: false,
    invalidatePools: () => { calls.push('invalidate'); },
    refreshAutoPlaylist: async () => { calls.push('refresh'); },
    logError: () => {},
  }), false);
  assert.deepEqual(calls, []);
});

test('an early successful rebuild is not repeated by reconcile completion', async () => {
  const calls: string[] = [];
  assert.equal(await runTaggerFollowups({
    mode: 'reconcile', outcome: 'ok', rotationSettled: true, fallbackRefreshed: true,
    invalidatePools: () => { calls.push('invalidate'); },
    refreshAutoPlaylist: async () => { calls.push('refresh'); },
    syncPlaylists: async () => { calls.push('sync'); }, logError: () => {},
  }), true);
  assert.deepEqual(calls, ['sync']);
});

test('a failed fallback refresh reports failure while preserving recipe synchronization', async () => {
  const calls: string[] = [];
  assert.equal(await runTaggerFollowups({
    mode: 'reconcile', outcome: 'ok', rotationSettled: true,
    invalidatePools: () => { calls.push('invalidate'); },
    refreshAutoPlaylist: async () => { throw new Error('disk unavailable'); },
    syncPlaylists: async () => { calls.push('sync'); },
    logError: message => { calls.push(message); },
  }), false);
  assert.deepEqual(calls, ['invalidate', 'post-maintenance auto-playlist refresh failed: disk unavailable', 'sync']);
});

test('failed, unsettled, and analysis-only runs never rebuild the fallback playlist', async () => {
  for (const input of [
    { mode: 'reconcile' as const, outcome: 'failed' as const, rotationSettled: true },
    { mode: 'tag' as const, outcome: 'ok' as const, rotationSettled: false },
    { mode: 'analyze' as const, outcome: 'ok' as const, rotationSettled: true },
  ]) {
    const calls: string[] = [];
    await runTaggerFollowups({
      ...input,
      invalidatePools: () => { calls.push('invalidate'); },
      syncPlaylists: async () => { calls.push('sync'); },
      refreshAutoPlaylist: async () => { calls.push('refresh'); },
      logError: () => {},
    });
    assert.equal(calls.includes('refresh'), false, JSON.stringify(input));
  }
});

test('a confirmed Liquidsoap resolution failure offers its track to ID-rotation recovery', { timeout: 5_000 }, async () => {
  const { queue } = await import('../src/broadcast/queue.js');
  const q = queue as any;
  const originalRecovery = q._considerIdRotationRecovery;
  const originalPersist = q.persist;
  const originalAutoPick = q.autoPick;
  const item = { track: { id: OLD_ID, title: 'Memory Bank', artist: 'Jethro Tull' }, sent: true };
  const offered: unknown[] = [];
  let inspected!: () => void;
  const inspectedPromise = new Promise<void>((resolve) => { inspected = resolve; });
  try {
    q.upcoming = [item];
    q._resolveFailStreak = 0;
    q.autoPick = false;
    q.persist = () => {};
    q._considerIdRotationRecovery = async (track: unknown) => {
      offered.push(track);
      inspected();
    };

    q.onPushResolveFailed(item);
    await inspectedPromise;
    assert.deepEqual(offered, [item.track]);
  } finally {
    q.upcoming = [];
    q._resolveFailStreak = 0;
    q._considerIdRotationRecovery = originalRecovery;
    q.persist = originalPersist;
    q.autoPick = originalAutoPick;
  }
});
