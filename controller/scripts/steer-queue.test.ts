// What a steer does to the queue: "start now" drops only the DJ's own queued
// picks, and opening tracks go when their steer is no longer the one in force.
// Run: npx tsx scripts/steer-queue.test.ts
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-queue-'));
process.env.STATE_DIR = stateRoot;

const { queue } = await import('../src/broadcast/queue.js');
const { STEER_ONCE_KEY } = await import('../src/broadcast/queue/types.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

const item = (id: string, extra: Record<string, unknown>) =>
  ({ track: { id, title: `Track ${id}`, artist: 'Artist' }, sent: false, queuedAt: Date.now(), ...extra });

test('start now drops the DJ\'s queued picks and keeps requests and operator tracks', async () => {
  queue.autoPick = false; // the re-pick gate is not under test
  queue.upcoming.length = 0;
  queue.upcoming.push(
    item('pick-1', { aiPicked: true, requestedBy: null }) as never,
    item('request', { aiPicked: false, requestedBy: 'a listener' }) as never,
    item('studio', { aiPicked: false, requestedBy: 'studio' }) as never,
    item('pick-2', { aiPicked: true, requestedBy: null }) as never,
  );
  queue.current = { track: { id: 'on-air', title: 'On air', artist: 'Artist' } } as never;
  assert.equal(queue.tailTrack(false)?.id, 'pick-2');
  assert.equal(queue.tailTrack(true)?.id, 'studio', 'the intro follows what start now leaves');
  const result = await queue.dropQueuedPicks('steer start');
  assert.deepEqual(result, { dropped: 2, kept: 0, pickInFlight: false });
  assert.deepEqual(queue.upcoming.map(i => i.track.id), ['request', 'studio']);
  queue.upcoming.length = 0;
});

test('opening tracks of a steer no longer in force are removed; a single queued track and the live steer\'s stay', async () => {
  queue.autoPick = false;
  queue.upcoming.length = 0;
  queue.upcoming.push(
    item('old', { aiPicked: true, steer: '100' }) as never,
    item('single', { aiPicked: true, steer: STEER_ONCE_KEY }) as never,
    item('live', { aiPicked: true, steer: '200' }) as never,
    item('pick', { aiPicked: true }) as never,
  );
  assert.equal(await queue.removeOrphanSteerQueued('200'), 1);
  assert.deepEqual(queue.upcoming.map(i => i.track.id), ['single', 'live', 'pick']);
  assert.equal(await queue.removeOrphanSteerQueued(null), 1, 'no steer in force: the last one\'s tracks go');
  assert.deepEqual(queue.upcoming.map(i => i.track.id), ['single', 'pick']);
  assert.equal(queue.tailTrack(true)?.id, 'single', 'start now keeps a queued single track');
  queue.upcoming.length = 0;
  queue.current = null;
});

test('the janitor clears a steer that has run out, with its tracks, and leaves a live one alone', async () => {
  const settings = await import('../src/settings.js');
  const { steerJanitor } = await import('../src/broadcast/scheduler.js');
  queue.autoPick = false;
  const now = Date.now();
  const live = { playlistId: null, prompt: 'more upbeat pop', startedAt: now - 60_000, expiresAt: now + 3_600_000 };
  await settings.update({ steer: live });
  queue.upcoming.length = 0;
  queue.upcoming.push(item('mine', { aiPicked: true, steer: String(live.startedAt) }) as never);
  await steerJanitor();
  assert.deepEqual(settings.get().steer, live);
  assert.equal(queue.upcoming.length, 1);

  await settings.update({ steer: { ...live, startedAt: now - 7_200_000, expiresAt: now - 1000 } });
  queue.upcoming[0].steer = String(now - 7_200_000);
  await steerJanitor();
  assert.equal(settings.get().steer, null);
  assert.deepEqual(queue.upcoming, []);
});
