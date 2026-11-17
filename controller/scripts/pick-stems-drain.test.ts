// The drain's pick-time stems trigger (#2197, queue.drainToLiquidsoap ->
// broadcast/pick-stems.ts).
//
// Under pair drain the seam INTO a freshly picked track renders the moment it
// arrives, in the same drain pass, once. So the trigger must come after that
// render and after the outgoing item is committed: then the X->Y render always
// reaches the single-flight analyzer worker first, and the separation can only
// ever serve Y's own exit (its tail) and its next pick (its head). It must
// also be fire-and-forget: a separation takes a minute or more, and a drain
// that waited on it would miss the seam it is there to make.
//
// The render and the separation are stubbed on the queue's own seams
// (`_renderBlend`, `_pickStems`), so this pins the ORDER and the arguments;
// what a separation does is scripts/pick-stems.test.ts.
//
// Run: `npm test -- pick-stems-drain`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-pick-stems-drain-'));
process.env.STATE_DIR = stateRoot;
process.env.LRCLIB_URL = 'http://127.0.0.1:9';
// No Navidrome: the pair stamps' ReplayGain lookup fails fast instead of on DNS.
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');

await settings.load();
await settings.update({
  personas: settings.get().personas.map(p => ({ ...p, djMode: true })),
  transitions: { pairDrain: true, stemBlends: true, pickTimeStems: true },
});

// Liquidsoap's poll: consume next.txt as it lands, so back-to-back handoffs
// don't each wait out writeHandoff's consumption window.
const consumer = setInterval(() => rmSync(config.liquidsoap.queueFile, { force: true }), 20);

type Event =
  | { kind: 'render'; out: string; in: string }
  | { kind: 'pick'; id: string; held: boolean; pairDrainActive: boolean; sent: Record<string, boolean> };
let events: Event[] = [];
const q = queue as any;

beforeEach(() => {
  events = [];
  q._renderBlend = async (out: { id: string }, inn: { id: string }) => {
    events.push({ kind: 'render', out: out.id, in: inn.id });
    return null; // a cache miss: the plain pair crossfade
  };
  // Never settles: a drain that awaited it would hang this test.
  q._pickStems = (track: { id: string }, opts: { held: boolean; pairDrainActive: boolean }) => {
    events.push({
      kind: 'pick', id: track.id, held: opts.held, pairDrainActive: opts.pairDrainActive,
      sent: Object.fromEntries(q.upcoming.map((i: { track: { id: string }; sent?: boolean }) => [i.track.id, !!i.sent])),
    });
    return new Promise(() => {});
  };
  q.verifyPushResolved = async () => {}; // no Liquidsoap to probe
  // W on air with 110 s left: inside the deadline-pick window.
  q.current = {
    track: { id: 'W', title: 'W', artist: 'a', duration: 300 },
    startedAt: new Date(Date.now() - 190_000).toISOString(),
  };
});

after(async () => {
  clearInterval(consumer);
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  await removeTempDir(stateRoot);
});

const item = (id: string, artist: string) =>
  ({ track: { id, title: id, artist, duration: 240 }, sent: false, queuedAt: new Date().toISOString() });

test('the deadline pick: X -> Y renders, X is sent, and only then is Y separated', async () => {
  const X = item('X', 'b');
  q.upcoming = [X];
  await queue.drainToLiquidsoap();
  assert.equal(X.sent, false, 'X is held for its successor');
  assert.deepEqual(events, [], 'nothing to separate while X waits');

  // push()'s tail: the successor lands and the drain is kicked.
  q.upcoming.push(item('Y', 'c'));
  await queue.drainToLiquidsoap(); // resolves although the separation never does

  assert.deepEqual(events, [
    { kind: 'render', out: 'X', in: 'Y' },
    { kind: 'pick', id: 'Y', held: true, pairDrainActive: true, sent: { X: true, Y: false } },
  ]);
});

test('a block of picks: each seam renders before its separation, and only the last item is held', async () => {
  q.upcoming = [item('X', 'b'), item('Y', 'c'), item('Z', 'd')];
  await queue.drainToLiquidsoap();
  assert.deepEqual(events.map(e => (e.kind === 'render' ? `render ${e.out}->${e.in}` : `pick ${e.id} held=${e.held}`)), [
    'render X->Y',
    'pick Y held=false', // Y is sent on the next turn of the loop, so the runner turns it away
    'render Y->Z',
    'pick Z held=true',
  ]);
});

test('no pair drain (a non-DJ persona): eager sends, no separation', async () => {
  await settings.update({ personas: settings.get().personas.map(p => ({ ...p, djMode: false })) });
  try {
    q.upcoming = [item('X', 'b'), item('Y', 'c')];
    await queue.drainToLiquidsoap();
    assert.deepEqual(events, []);
  } finally {
    await settings.update({ personas: settings.get().personas.map(p => ({ ...p, djMode: true })) });
  }
});

test('a successor already past the hard deadline drains without a pair, so it is not held', async () => {
  // W ends in 30 s and X is 10 s long: Y's own clock starts inside the 45 s
  // hard fallback, so the next turn sends it intrinsic rather than hold it.
  q.current = {
    track: { id: 'W', title: 'W', artist: 'a', duration: 300 },
    startedAt: new Date(Date.now() - 270_000).toISOString(),
  };
  const X = { ...item('X', 'b'), track: { id: 'X', title: 'X', artist: 'b', duration: 10 } };
  q.upcoming = [X, item('Y', 'c')];
  await queue.drainToLiquidsoap();
  const picks = events.filter(e => e.kind === 'pick');
  assert.deepEqual(picks.map(e => e.kind === 'pick' && [e.id, e.held]), [['Y', false]]);
});
