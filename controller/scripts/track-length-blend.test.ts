import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-length-blend-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
type Item = Parameters<typeof queue.removeUpcomingItem>[0];

async function stage(outSec: number, inSec: number) {
  rmSync(config.liquidsoap.queueFile, { force: true });
  await settings.load();
  await settings.update({ maxTrackSeconds: 1200, maxTrackLengthMode: 'cut', loudness: { source: 'measured' } });
  queue.current = null;
  const outgoing: Item = { track: { id: 'outgoing', title: 'Outgoing', artist: 'A', duration: outSec }, sent: false };
  const incoming: Item = { track: { id: 'incoming', title: 'Incoming', artist: 'B', duration: inSec }, sent: false };
  queue.upcoming = [outgoing, incoming];
  return { outgoing, incoming };
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'drain reached the expected handoff phase');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const rejected of ['outgoing', 'incoming'] as const) {
  test(`exclusion during serialized handoff rejects ${rejected} and clears unpublished blend cues`, async () => {
    const { outgoing, incoming } = await stage(rejected === 'outgoing' ? 2700 : 300, rejected === 'incoming' ? 2700 : 300);
    const clipPath = join(root, `unpublished-${rejected}.wav`);
    writeFileSync(clipPath, 'test render');
    writeFileSync(config.liquidsoap.queueFile, 'previous handoff');
    const render = queue._renderBlend;
    queue._renderBlend = async () => ({ clipPath, outCueSec: 280, inCueSec: 20, clipSec: 30 });
    const consumed: string[] = [];
    let draining: Promise<void> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      draining = queue.drainToLiquidsoap(true);
      await waitUntil(() => !!outgoing.stemBlend);
      assert.equal(incoming.stemCueInSec, 20, 'render prepared the head skip');
      await settings.update({ maxTrackLengthMode: 'exclude' });
      queue._renderBlend = async () => null;
      rmSync(config.liquidsoap.queueFile, { force: true });
      poll = setInterval(() => {
        if (!existsSync(config.liquidsoap.queueFile)) return;
        consumed.push(readFileSync(config.liquidsoap.queueFile, 'utf8'));
        rmSync(config.liquidsoap.queueFile, { force: true });
      }, 10);
      await draining;
      await waitUntil(() => consumed.length === 1);
      const survivor = rejected === 'outgoing' ? incoming : outgoing;
      assert.deepEqual(queue.upcoming, [survivor]);
      assert.equal(survivor.sent, true);
      assert.ok(consumed[0].includes(`subsonic_id="${survivor.track.id}"`));
      assert.ok(!consumed[0].includes('liq_cue_in'), 'no unaired head is skipped');
      assert.ok(!consumed[0].includes('liq_cue_out'), 'no unaired blend cuts the survivor early');
      assert.equal(outgoing.stemBlend, undefined);
      assert.equal(incoming.stemSeam, undefined);
      assert.equal(incoming.stemCueInSec, undefined);
      assert.equal(existsSync(clipPath), false, 'unused rendered audio is cleaned up');
    } finally {
      if (poll) clearInterval(poll);
      rmSync(config.liquidsoap.queueFile, { force: true });
      await draining;
      queue._renderBlend = render;
    }
  });
}

test('a published outgoing blend commits its successor across a live mode change', async () => {
  const { outgoing, incoming } = await stage(300, 2700);
  const render = queue._renderBlend;
  queue._renderBlend = async () => ({ clipPath: join(root, 'committed.wav'), outCueSec: 280, inCueSec: 20, clipSec: 30 });
  const consumed: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const draining = queue.drainToLiquidsoap(true);
  try {
    await waitUntil(() => outgoing.sent === true);
    assert.equal(incoming.lengthPolicyCommitted, true);
    await settings.update({ maxTrackLengthMode: 'exclude' });
    queue._renderBlend = async () => null;
    poll = setInterval(() => {
      if (!existsSync(config.liquidsoap.queueFile)) return;
      consumed.push(readFileSync(config.liquidsoap.queueFile, 'utf8'));
      rmSync(config.liquidsoap.queueFile, { force: true });
    }, 10);
    await draining;
    await waitUntil(() => consumed.length === 3);
    assert.deepEqual(queue.upcoming, [outgoing, incoming]);
    assert.ok(consumed[1].includes('subwave_clip="1"'));
    assert.ok(consumed[2].includes('liq_cue_in="20"'));
    assert.ok(!consumed[2].includes('liq_cue_out="1200'));
  } finally {
    if (poll) clearInterval(poll);
    rmSync(config.liquidsoap.queueFile, { force: true });
    await draining;
    queue._renderBlend = render;
  }
});

for (const originalExit of [undefined, { crossSec: 6 }]) {
  test(`recovery rejects an unpublished incoming blend with ${originalExit ? 'saved' : 'legacy'} exit timing`, async () => {
  const { outgoing, incoming } = await stage(300, 2700);
  await settings.update({ maxTrackLengthMode: 'exclude' });
  const clipPath = join(root, 'recovered-unpublished.wav');
  writeFileSync(clipPath, 'unused render');
  outgoing.track.crossSec = 0.3;
  outgoing.stemBlend = { clipPath, outCueSec: 280, inCueSec: 20, originalExit };
  outgoing.cueOutSec = 280;
  incoming.stemSeam = true;
  incoming.stemCueInSec = 20;
  const queuedAt = new Date().toISOString();
  writeFileSync(config.queue.file, JSON.stringify({ upcoming: [
    { ...outgoing, queuedAt }, { ...incoming, queuedAt },
  ], current: null, history: [] }));
  queue.upcoming = [];
  queue.recover();
  await waitUntil(() => !queue.senderBusy && queue.upcoming[0]?.sent === true);
  assert.deepEqual(queue.upcoming.map(item => item.track.id), ['outgoing']);
  const uri = readFileSync(config.liquidsoap.queueFile, 'utf8');
  assert.ok(!uri.includes('liq_cue_out'), 'no unpublished tail is cut off');
  assert.ok(!uri.includes('liq_cross_duration="0.3"'), 'clip timing cannot survive without a clip');
  if (originalExit) assert.ok(uri.includes('liq_cross_duration="6"'), 'saved intrinsic timing is restored');
  assert.equal(existsSync(clipPath), false, 'unused recovered render is removed');
  rmSync(config.liquidsoap.queueFile, { force: true });
});
}

const savedExit = { crossSec: 6, washout: true, washoutDelay: 0.5, loop: true, loopBar: 2 };
for (const scenario of [
  { name: 'saved exit, replaced clip', originalExit: savedExit, sameClip: false },
  { name: 'saved exit, reused clip', originalExit: savedExit, sameClip: true },
  { name: 'empty exit', originalExit: {}, sameClip: false },
  { name: 'legacy exit', originalExit: undefined, sameClip: false },
]) {
  test(`recovered blend survives successful re-render and pre-publication cancellation (${scenario.name})`, async () => {
    const { outgoing, incoming } = await stage(300, 900);
    setCache({ ...settings.get(), maxTrackLengthMode: 'exclude',
      personas: settings.get().personas.map(persona => ({ ...persona, djMode: true })),
    });
    const oldClip = join(root, `old-${scenario.name}.wav`);
    const newClip = scenario.sameClip ? oldClip : join(root, `new-${scenario.name}.wav`);
    writeFileSync(oldClip, 'recovered render');
    outgoing.track.crossSec = 0.3;
    outgoing.stemBlend = { clipPath: oldClip, outCueSec: 280, inCueSec: 20, originalExit: scenario.originalExit };
    outgoing.cueOutSec = 280;
    incoming.stemSeam = true;
    incoming.stemCueInSec = 20;
    const queuedAt = new Date().toISOString();
    writeFileSync(config.queue.file, JSON.stringify({ upcoming: [
      { ...outgoing, queuedAt }, { ...incoming, queuedAt },
    ], current: null, history: [] }));
    writeFileSync(config.liquidsoap.queueFile, 'previous handoff');
    const q = Object.create(queue) as typeof queue;
    q.upcoming = [];
    q._preparedBlends = new WeakMap();
    let renders = 0;
    q._renderBlend = async () => {
      renders++;
      writeFileSync(newClip, 'replacement render');
      return { clipPath: newClip, outCueSec: 275, inCueSec: 25, clipSec: 30 };
    };
    try {
      q.recover();
      await waitUntil(() => q.upcoming[0]?.stemBlend?.outCueSec === 275);
      const restoredOut = q.upcoming[0];
      const restoredIn = q.upcoming[1];
      assert.equal(renders, 1, 'recovery successfully re-rendered the pair');
      assert.equal(restoredOut.sent, false, 'previous handoff still blocks publication');
      assert.equal(existsSync(newClip), true, 'replacement audio remains available before cancellation');
      q._renderBlend = async () => null;
      setCache({ ...settings.get(), maxTrackSeconds: 600 });
      assert.equal(await q.dropAboveCeiling(restoredIn), true);
      const exitKeys = ['crossSec', 'washout', 'washoutDelay', 'loop', 'loopBar'] as const;
      const restoredExit = Object.fromEntries(exitKeys.filter(key => key in restoredOut.track)
        .map(key => [key, restoredOut.track[key]]));
      assert.deepEqual(restoredExit, scenario.originalExit ?? {}, 'rollback preserves the first pre-blend exit');
      assert.equal(restoredOut.stemBlend, undefined);
      assert.equal(restoredIn.stemSeam, undefined);
      assert.equal(restoredIn.stemCueInSec, undefined);
      rmSync(config.liquidsoap.queueFile, { force: true });
      await waitUntil(() => !q.senderBusy && restoredOut.sent === true);
      const uri = readFileSync(config.liquidsoap.queueFile, 'utf8');
      assert.ok(!uri.includes('liq_cue_out'), 'cancelled clip cannot shorten the outgoing audio');
      assert.ok(!uri.includes('liq_cross_duration="0.3"'), 'cancelled clip cannot retain its seam timing');
      if (scenario.originalExit === savedExit) assert.ok(uri.includes('liq_cross_duration="6"'));
      assert.equal(existsSync(oldClip), false, 'superseded unused audio is removed');
      assert.equal(existsSync(newClip), false, 'cancelled replacement audio is removed');
    } finally {
      q._renderBlend = async () => null;
      rmSync(config.liquidsoap.queueFile, { force: true });
      await waitUntil(() => !q.senderBusy);
      if (q._persistTimer) clearTimeout(q._persistTimer);
    }
  });
}
