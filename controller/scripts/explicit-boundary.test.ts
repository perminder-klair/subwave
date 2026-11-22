// A clean show meets the queue. Picks are judged when they are made, on a
// forecast, and that forecast can be wrong by the time they air: a takeover or a
// live edit gives no warning, and a request landing ahead pushes a pick a whole
// track later. So the drain judges an unsent automatic pick again, on today's
// forecast, through the real Queue. Operators' and listeners' tracks stay
// exempt, and a station with no clean show pays nothing.
// Run: `npm test -- explicit-boundary`.

import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-explicit-boundary-'));
process.env.STATE_DIR = root;
process.env.LIQUIDSOAP_HOST = 'explicit-boundary-mixer.invalid';

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');
const { config } = await import('../src/config.js');

await settings.load();
await settings.update({ loudness: { source: 'measured' } } as never);
await library.load();
const defaults = settings.get();

after(async () => {
  library.shutdown();
  // The queue's debounced persist.
  await new Promise(resolve => setTimeout(resolve, 650));
  await removeTempDir(root);
});

db.upsertTrackMeta('tagged', { title: 'Tagged', artist: 'T', duration: 240, explicitStatus: 'explicit' });
db.upsertTrackMeta('plain', { title: 'Plain', artist: 'P', duration: 240, explicitStatus: null });
const TAGGED = { id: 'tagged', title: 'Tagged', artist: 'T', duration: 240 };
const PLAIN = { id: 'plain', title: 'Plain', artist: 'P', duration: 240 };
const REMAINING_SEC = 180;

// A real Queue with the on-air clock set, and the clean show starting `fromSec`
// from now. `flag: false` is the same station with no clean show anywhere.
function stage({ fromSec = 0, flag = true } = {}) {
  const now = Date.now();
  setCache({
    ...defaults,
    shows: [{ id: 'hour', name: 'Family Hour', excludeExplicit: flag }],
    scheduleOverride: { showId: 'hour', startedAt: now + fromSec * 1000, expiresAt: now + 3_600_000 },
  } as never);
  const q = Object.create(queue);
  q.current = { track: { id: 'air', title: 'Air', artist: 'A', duration: 240 }, startedAt: new Date(now - (240 - REMAINING_SEC) * 1000).toISOString() };
  q.upcoming = [];
  q.history = [];
  q.djLog = [];
  q.senderBusy = true;
  return q;
}

const enqueue = (q: any, track: any, showAt: Date | null = null) => enqueuePick(q, track, 'pick', 'pool', null, null, {}, { showAt });
async function drain(q: any) {
  q.senderBusy = false;
  await q.drainToLiquidsoap(true);
}
const mixerHolds = (id: string) => existsSync(config.liquidsoap.queueFile)
  && readFileSync(config.liquidsoap.queueFile, 'utf8').includes(`subsonic_id="${id}"`);
const queued = (q: any) => q.upcoming.map((i: any) => i.track.id);
const booth = (q: any) => q.djLog.map((e: any) => e.message as string);

beforeEach(() => rmSync(config.liquidsoap.queueFile, { force: true }));

test('a takeover into a clean show takes back the unsent pick, and says so', async () => {
  const q = stage();
  await enqueue(q, TAGGED);
  await drain(q);
  assert.deepEqual(queued(q), []);
  assert.equal(mixerHolds('tagged'), false);
  assert.ok(booth(q).some((l: string) => /Tagged — T .*tagged explicit, clean show "Family Hour"/.test(l)), booth(q).join(' | '));
});

test('a request landing ahead pushes a pick into the clean show, and the pick goes', async () => {
  // Judged before the show, and right when it was: it was next. The request
  // then takes that slot, so the pick airs 180 + 240 = 420s out, past the show's
  // start at 300s. The request is what the drain keeps.
  const q = stage({ fromSec: 300 });
  await q.push({ track: { id: 'req', title: 'Req', artist: 'R', duration: 240 }, requestedBy: 'Tester' });
  await enqueue(q, TAGGED, new Date(Date.now() + 200_000));
  await drain(q);
  assert.deepEqual(queued(q), ['req']);
  assert.equal(mixerHolds('tagged'), false);
});

test('a pick that airs well before the clean show starts stays', async () => {
  // 180s out and the show 900s away: the same look-ahead the pick was judged on.
  const q = stage({ fromSec: 900 });
  await enqueue(q, TAGGED);
  await drain(q);
  assert.deepEqual(queued(q), ['tagged']);
  assert.equal(mixerHolds('tagged'), true);
});

test('an untagged pick airs through a clean show', async () => {
  const q = stage();
  await enqueue(q, PLAIN);
  await drain(q);
  assert.deepEqual(queued(q), ['plain']);
  assert.equal(mixerHolds('plain'), true);
});

test('a listener and an operator keep what they were given', async () => {
  for (const requestedBy of ['Tester', 'studio']) {
    rmSync(config.liquidsoap.queueFile, { force: true });
    const q = stage();
    await q.push({ track: TAGGED, requestedBy, operator: requestedBy === 'studio' });
    await drain(q);
    assert.deepEqual(queued(q), ['tagged'], requestedBy);
    assert.equal(mixerHolds('tagged'), true, requestedBy);
  }
});

test('what the mixer already has, or is committed to, is left alone', async () => {
  for (const state of [{ sent: true }, { bedded: true }, { pauseDelaySec: 12 }, { lengthPolicyCommitted: true }]) {
    const q = stage();
    await enqueue(q, TAGGED);
    Object.assign(q.upcoming[0], state);
    assert.equal(await q.dropAboveCeiling(q.upcoming[0]), false, JSON.stringify(state));
    assert.deepEqual(queued(q), ['tagged'], JSON.stringify(state));
  }
});

test('a pick on a show that is not clean is untouched, tag and all', async () => {
  const q = stage({ flag: false });
  await enqueue(q, TAGGED);
  await drain(q);
  assert.deepEqual(queued(q), ['tagged']);
  assert.equal(mixerHolds('tagged'), true);
});

test('with no clean show anywhere the check never reads the library', async () => {
  const q = stage({ flag: false });
  await enqueue(q, TAGGED);
  q.airForecastSec = () => assert.fail('a forecast was worked out for a station with no clean show');
  assert.equal(q.automaticIneligible(q.upcoming[0]), false);
});

test('a dropped pick takes its link with it', async () => {
  const q = stage();
  await enqueuePick(q, TAGGED, 'pick', 'pool', 'That was the one.', null, {}, {});
  q.senderBusy = false;
  await q.dropAboveCeiling(q.upcoming[0]);
  assert.deepEqual(queued(q), []);
  assert.ok(!booth(q).some((l: string) => /above current maximum/.test(l)), 'the booth names the real reason');
});

test('the emptied slot gets a fresh pick for the show that is now on', async () => {
  const q = stage();
  await enqueue(q, TAGGED);
  await drain(q);
  // Inside the deadline window, the watcher's backstop sees an empty queue.
  q.current.startedAt = new Date(Date.now() - 150_000).toISOString();
  q.pickGateClosed = () => null;
  q.pairDrainActive = () => true;
  q._deadlinePickAt = 0;
  let picks = 0;
  q.runPickCycle = () => { picks++; };
  q.maybeDeadlinePick();
  assert.equal(picks, 1);
});

// The other half of the boundary. A pick that starts more than the look-ahead
// before a clean show is rightly the outgoing show's, but it can still run into
// the new one. It is too late to swap, so it fades where the show begins,
// through the show-boundary cut (#1574).
const handedOver = () => readFileSync(config.liquidsoap.queueFile, 'utf8');

test('a tagged pick running into a clean show fades where the show begins', async () => {
  // Airs 180s out and ends at 420s; the show starts at 350s, so 70s would spill.
  const q = stage({ fromSec: 350 });
  await enqueue(q, TAGGED);
  await drain(q);
  assert.deepEqual(queued(q), ['tagged'], 'it starts in the outgoing show, so it airs');
  const cue = Number(handedOver().match(/liq_cue_out="([\d.]+)"/)?.[1]);
  assert.ok(Math.abs(cue - 170) < 3, `cued out at the show's start, got ${cue}`);
  assert.match(handedOver(), /liq_show_fade="true"/);
  assert.ok(booth(q).some((l: string) => /show boundary fade: "Tagged"/.test(l)), booth(q).join(' | '));
});

test('an untagged pick plays on into a clean show', async () => {
  const q = stage({ fromSec: 350 });
  await enqueue(q, PLAIN);
  await drain(q);
  assert.doesNotMatch(handedOver(), /liq_show_fade|liq_cue_out/);
});

test('a tagged pick running into a show that is not clean plays out', async () => {
  const q = stage({ fromSec: 350, flag: false });
  await enqueue(q, TAGGED);
  await drain(q);
  assert.doesNotMatch(handedOver(), /liq_show_fade|liq_cue_out/);
});

test('a listener\'s track is never cut for a clean show', async () => {
  const q = stage({ fromSec: 350 });
  await q.push({ track: TAGGED, requestedBy: 'Tester' });
  await drain(q);
  assert.doesNotMatch(handedOver(), /liq_show_fade/);
});
