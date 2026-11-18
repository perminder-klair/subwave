// What a steer does to the queue: "start now" drops only the DJ's own queued
// picks, and opening tracks go when their steer is no longer the one in force.
// Run: npm test -- steer-queue
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-queue-'));
process.env.STATE_DIR = stateRoot;

const { queue } = await import('../src/broadcast/queue.js');
const { STEER_ONCE_KEY } = await import('../src/broadcast/queue/types.js');

after(async () => {
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  await removeTempDir(stateRoot);
});

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

test('start now that empties the queue asks the same gate as a track start: closed, the coast takes over', async () => {
  const realHandOver = queue.handOverToCoast;
  const realCycle = queue.runPickCycle;
  const handed: string[] = [];
  let cycles = 0;
  queue.handOverToCoast = ((reason: string) => { handed.push(reason); }) as typeof queue.handOverToCoast;
  queue.runPickCycle = (() => { cycles++; }) as unknown as typeof queue.runPickCycle;
  try {
    queue.autoPick = false;
    queue.upcoming.length = 0;
    queue.upcoming.push(item('pick', { aiPicked: true }) as never);
    await queue.dropQueuedPicks('steer start');
    assert.deepEqual(handed, ['auto-pick-off'], 'auto-pick off: no pick, the coast is told');
    assert.equal(cycles, 0);

    queue.autoPick = true;
    queue.upcoming.push(item('pick', { aiPicked: true }) as never);
    await queue.dropQueuedPicks('steer start');
    assert.equal(cycles, 1, 'gate open: the slot is picked into');
    assert.deepEqual(handed, ['auto-pick-off']);
  } finally {
    queue.handOverToCoast = realHandOver;
    queue.runPickCycle = realCycle;
    queue.autoPick = false;
    queue.upcoming.length = 0;
  }
});

test('a track queued now starts after what is on air and queued, less what start now drops', () => {
  const now = Date.now();
  queue.current = { track: { id: 'on-air', title: 'On air', artist: 'Artist', duration: 200 }, startedAt: new Date(now - 50_000).toISOString() } as never;
  queue.upcoming.length = 0;
  queue.upcoming.push(
    item('pick', { aiPicked: true, track: { id: 'pick', title: 'Pick', artist: 'Artist', duration: 100 } }) as never,
    item('request', { requestedBy: 'a listener', track: { id: 'request', title: 'Request', artist: 'Artist', duration: 60 } }) as never,
  );
  const near = (actual: number | null, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 2, `${actual} ≈ ${expected}`);
  near(queue.secondsUntilQueuedTail(false), 150 + 100 + 60);
  near(queue.secondsUntilQueuedTail(true), 150 + 60);
  queue.upcoming.push(item('unknown', { requestedBy: 'a listener', track: { id: 'unknown', title: 'Unknown', artist: 'Artist' } }) as never);
  assert.equal(queue.secondsUntilQueuedTail(false), null, 'a length nobody measured: unknown, not guessed');
  queue.current = null;
  queue.upcoming.length = 0;
  assert.equal(queue.secondsUntilQueuedTail(false), 0, 'nothing on air or queued: it would start now');
});

test('the opening list keeps only what starts before the steer ends', async () => {
  const { openingTracksThatFit } = await import('../src/music/steer.js');
  assert.equal(openingTracksThatFit([240, 240, 240, 240, 240], 60, 15 * 60), 4, 'starts at 1, 5, 9, 13 min; the fifth at 17');
  assert.equal(openingTracksThatFit([240, 240], 60, 3600), 2, 'never more than it was given');
  assert.equal(openingTracksThatFit([240, 240], 900, 900), 0, 'a queue that runs past the end leaves no room');
  assert.equal(openingTracksThatFit([240, 240, 240], null, 60), 3, 'an unknown lead does not trim');
  assert.equal(openingTracksThatFit([240, null, 240, 240], 0, 400), 4, 'an unknown length stops the trimming there');
});

test('a takeover save ends a running steer even when the mixer will not give a track back', async () => {
  const settings = await import('../src/settings.js');
  const { updateEndingSteer } = await import('../src/broadcast/takeover-steer.js');
  const now = Date.now();
  await settings.update({ steer: { playlistId: null, prompt: 'more upbeat pop', startedAt: now - 60_000, expiresAt: now + 3_600_000 } });
  const realRemove = queue.removeSteerQueued;
  queue.removeSteerQueued = (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof queue.removeSteerQueued;
  try {
    const override = { showId: null, startedAt: now, expiresAt: now + 3_600_000 };
    const { endedSteer } = await updateEndingSteer({ scheduleOverride: override });
    assert.equal(endedSteer, true);
    assert.equal(settings.activeSteer(), null);
    assert.deepEqual(settings.getScheduleOverride(), override, 'the takeover is saved');
    // A save that puts no takeover in force leaves a steer alone.
    await settings.update({ scheduleOverride: null, steer: { playlistId: null, prompt: 'calm', startedAt: now - 1000, expiresAt: now + 3_600_000 } });
    assert.equal((await updateEndingSteer({ scheduleOverride: null })).endedSteer, false);
    assert.equal(settings.activeSteer()?.prompt, 'calm');
  } finally {
    queue.removeSteerQueued = realRemove;
    await settings.update({ steer: null, scheduleOverride: null });
  }
});
