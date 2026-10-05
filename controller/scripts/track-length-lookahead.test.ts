import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'subwave-length-lookahead-'));
process.env.STATE_DIR = root;
process.env.LIQUIDSOAP_HOST = 'length-mixer.invalid';
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
await settings.load();
await settings.update({ loudness: { source: 'measured' } });
const defaults = settings.get();
const long = { id: 'future-long', title: 'Future long', artist: 'A', duration: 2700 };
function stage(currentMax: number, futureMax: number) {
  rmSync(config.liquidsoap.queueFile, { force: true });
  const now = Date.now();
  setCache({ ...defaults, maxTrackSeconds: futureMax, maxTrackLengthMode: 'exclude',
    shows: [{ id: 'outgoing', name: 'Outgoing', maxTrackSeconds: currentMax }],
    scheduleOverride: { showId: 'outgoing', startedAt: now - 1000, expiresAt: now + 60000 },
  });
  const q = Object.create(queue);
  q.current = null;
  q.upcoming = [];
  q.history = [];
  q.senderBusy = true;
  return { q, showAt: new Date(now + 120000) };
}

after(async () => {
  await new Promise(resolve => setTimeout(resolve, 650));
  rmSync(root, { recursive: true, force: true });
});

test('look-ahead discovery, enqueue and drain honor the upcoming unlimited show', async () => {
  const { q, showAt } = stage(1200, 0);
  const show = settings.resolveActiveShow(showAt);
  const maxTrackSec = settings.effectiveTrackLengthLimits(show).selectionMaxSec;
  const discovered = buildPickerContext(pickerScope({ maxTrackSec })).collect([long]);
  assert.equal(discovered[0]?.id, long.id);
  assert.equal(await enqueuePick(q, discovered[0], 'Next show', 'pool', null, null, {}, { showAt }), 1);
  q.senderBusy = false;
  await q.drainToLiquidsoap(true);
  assert.equal(q.upcoming[0]?.sent, true);
  assert.ok(readFileSync(config.liquidsoap.queueFile, 'utf8').includes('subsonic_id="future-long"'));
});

test('a live edit to the forecast show ceiling still rejects an unsent pick', async () => {
  const { q, showAt } = stage(1200, 0);
  assert.equal(await enqueuePick(q, long, 'Next show', 'pool', null, null, {}, { showAt }), 1);
  setCache({ ...settings.get(), maxTrackSeconds: 1200 });
  q.senderBusy = false;
  await q.drainToLiquidsoap(true);
  assert.equal(q.upcoming.length, 0);
});

test('upcoming stricter limits apply at enqueue and requests remain exempt', async () => {
  const { q, showAt } = stage(0, 1200);
  assert.equal(await enqueuePick(q, long, 'Next show', 'pool', null, null, {}, { showAt }), -1);
  assert.equal(await q.push({ track: long, requestedBy: 'listener', selectionShowAt: showAt }), 1);
  q.senderBusy = false;
  await q.drainToLiquidsoap(true);
  assert.ok(!readFileSync(config.liquidsoap.queueFile, 'utf8').includes('liq_cue_out'));
});
