// Queue snapshots from before showKey existed must keep incoming-show picks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { QueueItem } from '../src/broadcast/queue/types.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { weekFor } from './test-utils/fixtures.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-resume-recovery-'));
const { config } = await import('../src/config.js');
const settings = await import('../src/settings.js');
await settings.load();
const now = Date.now();
const boundary = now - 30 * 60_000;
const before = boundary - 60_000;
const after = boundary + 60_000;
const ON_AIR = 'show:s_incoming';
await settings.update({
  shows: [
    { id: 's_earlier', name: 'Earlier', personaId: settings.get().personas[0].id },
    { id: 's_incoming', name: 'Incoming', personaId: settings.get().personas[0].id },
  ],
  schedule: weekFor('s_earlier'),
  scheduleOverride: { showId: 's_incoming', startedAt: boundary, expiresAt: now + 3600_000 },
});
const { queue } = await import('../src/broadcast/queue.js');
const { createStreamIdleMonitor } = await import('../src/broadcast/stream-idle.js');
queue.persist = () => {};
queue.drainToLiquidsoap = async () => {};

function item(id: string, extra: Partial<QueueItem> = {}): QueueItem {
  return { track: { id, title: id, artist: 'x' }, queuedAt: new Date(before).toISOString(), sent: false, ...extra };
}

test('legacy queue recovery retains the selection show before falling back to queued time', async () => {
  writeFileSync(config.queue.file, JSON.stringify({
    current: item('requested-on-air', { requestedBy: 'Anna', startedAt: new Date(before).toISOString() }),
    upcoming: [
      item('aimed-across-boundary', { selectionShowAt: after }),
      item('earlier-selection', { selectionShowAt: before, queuedAt: new Date(after).toISOString() }),
      item('queued-after-boundary', { queuedAt: new Date(after).toISOString() }),
      item('queued-before-boundary'),
      item('stamped-current', { showKey: ON_AIR, selectionShowAt: before }),
      item('stamped-earlier', { showKey: 'show:s_earlier', selectionShowAt: after }),
      item('requested', { requestedBy: 'studio', operator: true }),
    ],
  }));
  queue.recover();
  assert.equal(queue.upcoming.length, 7, 'the real cold recovery retains these recent entries');
  let skips = 0;
  const result = await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => { skips++; });
  assert.deepEqual(queue.upcoming.map(i => i.track.id), [
    'aimed-across-boundary', 'queued-after-boundary', 'stamped-current', 'requested',
  ]);
  assert.deepEqual(result, { dropped: 3, kept: 0, skipped: false });
  assert.equal(skips, 0);
});

test('an automatic pick without recoverable show ownership is retained', async () => {
  const unknown = item('unknown', { queuedAt: 'invalid', selectionShowAt: NaN });
  queue.current = item('requested-on-air', { requestedBy: 'Anna' });
  queue.upcoming = [unknown];
  await queue.dropProgrammeFromEarlierShow(queue.snapshotProgramme(ON_AIR), async () => {});
  assert.deepEqual(queue.upcoming, [unknown]);
});

for (const [name, extra, showChanged] of [
  ['legacy selection forecast', { selectionShowAt: after }, false],
  ['fallback start time', { queuedAt: undefined }, true],
  ['explicit earlier-show stamp', { showKey: 'show:s_earlier', selectionShowAt: after }, true],
] as const) {
  test(`the frozen track uses its ${name}`, async () => {
    queue.current = item('frozen', { startedAt: new Date(before).toISOString(), ...extra });
    const seen: { showChanged: boolean }[] = [];
    const monitor = createStreamIdleMonitor({
      idleStatus: async () => true, idleOff: async () => {},
      refresh: async () => {}, gatedListenerCount: () => 1,
      streamSettings: () => ({ idleWhenEmpty: true, idleAfterMinutes: 1 }),
      setStreamIdle: () => {}, warmHeavy: async () => {}, log: () => {},
      onResume: async info => { seen.push(info); },
    });
    await monitor.initialize();
    await monitor.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [{ showChanged }]);
  });
}
