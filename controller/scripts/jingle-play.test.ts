// Pins the on-demand jingle path — POST /jingles/:filename/play →
// queue.playJingle → jingle-now.txt → Liquidsoap's priority queue and its own
// marker hook (NOT on_meta, which never sees that source).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-jingle-play-'));
process.env.STATE_DIR = STATE;

const { config } = await import('../src/config.js');
const { jingleUri } = await import('../src/broadcast/jingles.js');
const { bedUri } = await import('../src/broadcast/beds.js');
const { queue } = await import('../src/broadcast/queue.js');

const here = dirname(fileURLToPath(import.meta.url));
const RADIO_LIQ = join(here, '..', '..', 'liquidsoap', 'radio.liq');

const URI = jingleUri('/var/sub-wave/jingles/jingle_a1b2c3d4.wav');
assert.equal(URI, 'annotate:subwave_kind="jingle":/var/sub-wave/jingles/jingle_a1b2c3d4.wav');
assert.ok(URI.endsWith(':/var/sub-wave/jingles/jingle_a1b2c3d4.wav'));
assert.ok(!URI.includes('liq_cue_out'), 'a jingle is never cut short');
assert.ok(!URI.includes('liq_cross_duration'), 'a jingle takes the station crossfade');
assert.ok(bedUri('/x.mp3', { bedSec: 30, crossSec: 6 }).includes('liq_cue_out'), 'a bed still is');
assert.notEqual(
  URI.match(/subwave_kind="([^"]+)"/)?.[1],
  bedUri('/x.mp3', { bedSec: 30, crossSec: 6 }).match(/subwave_kind="([^"]+)"/)?.[1],
);

const filename = 'jingle_a1b2c3d4.wav';
const other = 'jingle_deadbeef.wav';
const jingleDir = join(STATE, 'jingles');
mkdirSync(jingleDir, { recursive: true });
writeFileSync(join(jingleDir, filename), 'audio');
writeFileSync(join(jingleDir, other), 'audio');
writeFileSync(join(STATE, 'jingles.json'), JSON.stringify({
  items: {
    [filename]: { text: 'Event announcement' },
    [other]: { text: 'Sponsor spot' },
  },
}));

// Liquidsoap consumed the handoff, and the clip has aired — which is what
// retires the pending press so the same jingle can be fired again.
async function markAired(name: string) {
  rmSync(join(STATE, 'jingle-now.txt'), { force: true });
  writeFileSync(join(STATE, 'jingle-playing.json'), JSON.stringify({
    filename: join(jingleDir, name),
    durationSec: 4,
    startedAt: Date.now() / 1000,
  }));
  await new Promise(resolve => setTimeout(resolve, 150));
}

test('manual jingle uses a priority handoff without touching the FIFO track handoff', async () => {
  writeFileSync(config.liquidsoap.queueFile, 'existing-track');

  await queue.playJingle(filename);

  assert.equal(readFileSync(config.liquidsoap.queueFile, 'utf8'), 'existing-track');
  assert.equal(
    readFileSync(join(STATE, 'jingle-now.txt'), 'utf8'),
    `annotate:subwave_kind="jingle":${join(jingleDir, filename)}`,
  );
  // Also settles the per-file release chain before the next test writes.
  await markAired(filename);
});

// The priority queue is a FIFO with no remove path, and the fallback keeps
// selecting it while it is non-empty — so a retried tool call or a
// double-clicked button would air the same announcement twice with no way back
// short of /restart-mixer.
test('a repeat press of an un-aired jingle is refused, not stacked', async () => {
  assert.deepEqual(await queue.playJingle(other), { ok: true });
  assert.ok(existsSync(join(STATE, 'jingle-now.txt')), 'the first press was handed over');
  rmSync(join(STATE, 'jingle-now.txt'));

  assert.deepEqual(await queue.playJingle(other), { ok: false, reason: 'already-queued' });
  assert.ok(!existsSync(join(STATE, 'jingle-now.txt')), 'the repeat wrote no second handoff');

  // Once it has been heard, the same jingle can be fired again.
  await markAired(other);
  assert.deepEqual(await queue.playJingle(other), { ok: true });
  await markAired(other);
});

test('manual jingle rejects when its priority handoff cannot be written', async () => {
  const livePath = config.liquidsoap.jingleFile;
  config.liquidsoap.jingleFile = join(STATE, 'missing-parent', 'jingle-now.txt');
  try {
    await assert.rejects(queue.playJingle(filename));
  } finally {
    config.liquidsoap.jingleFile = livePath;
  }
  // A press that never reached the handoff leaves nothing pending behind it.
  assert.deepEqual(await queue.playJingle(filename), { ok: true });
  await markAired(filename);
});

const liq = readFileSync(RADIO_LIQ, 'utf8');
const titleGate = liq.indexOf('elsif title != "" or artist != "" then');
const bedBranch = liq.indexOf('if m["subwave_kind"] == "bed" then');

assert.ok(bedBranch > 0, 'on_meta still has its bed branch');
assert.ok(titleGate > 0, 'on_meta still has its title/artist gate');
assert.ok(bedBranch < titleGate, 'bed branch remains above the title gate');

const markerHook = liq.indexOf('jingle_now_queue.on_metadata(synchronous=false');
const markerHookEnd = liq.indexOf('\n  )', markerHook);
assert.ok(markerHook > 0, 'the priority queue marks its own clips at feed time');
const branchBody = liq.slice(markerHook, markerHookEnd);
assert.ok(
  branchBody.includes('fun (m) -> begin'),
  'a multi-expression Liquidsoap callback must use a begin/end block',
);
assert.ok(branchBody.includes('jingle-playing.json'), 'writes the collision-guard marker');
assert.ok(branchBody.includes('jingle_now_tmp_dir'), 'own temp dir — one per writer, #1240');
assert.ok(!branchBody.includes('temp_dir=jingle_tmp_dir'), 'never shares the rotate writer staging dir');
assert.ok(!branchBody.includes('now-playing.json'), 'an announcement is not a song');
assert.ok(!branchBody.includes('insert_metadata'), 'and never touches the ICY title');

// A dedicated source is the only way to get ahead of an already-populated
// FIFO dj_queue. Its availability gate preserves a manual press while deferring
// it past active speech or a bed/track pair.
const priorityQueue = liq.indexOf('jingle_now_queue = request.queue(id="jingle_now_queue")');
const priorityGate = liq.indexOf('jingle_now = source.available(jingle_now_queue');
const priorityFallback = liq.indexOf('[jingle_now, music]');
assert.ok(priorityQueue > 0, 'on-demand jingles have a dedicated request queue');
assert.ok(priorityGate > priorityQueue, 'the dedicated queue is wrapped in an availability gate');
assert.ok(priorityFallback > priorityGate, 'the dedicated queue wins the next safe boundary');
// Anchored at the gate itself, NOT at the queue declaration ~770 lines above:
// the automatic rotate's gate carries both of these strings, so a window that
// started any earlier passed even with this gate deleted outright.
const gateWindow = liq.slice(priorityGate, priorityFallback);
assert.ok(gateWindow.includes('not bed_on_air()'), 'a jingle cannot split a bed from its track');
assert.ok(gateWindow.includes('time() > voice_until()'), 'a jingle cannot start over active speech');
assert.ok(priorityFallback > liq.indexOf('rotate(weights=[1, jingle_ratio()]'),
  'manual priority wraps the automatic rotate so an automatic jingle cannot win first');

// The rotate must also stand down while a manual jingle is on air, or it stacks
// a stinger on top of the announcement.
const rotateGate = liq.slice(
  liq.indexOf('jingles = source.available(jingles, {'),
  liq.indexOf('rotate(weights=[1, jingle_ratio()]'),
);
assert.ok(rotateGate.includes('not jingle_now_on_air()'),
  'the rotate defers to a manual jingle already on air');
// ...and the flag has to be cleared by every on_meta branch, or it latches true
// and starves the rotate permanently (the bed_on_air failure, repeated).
const onMetaBody = liq.slice(liq.indexOf('def on_meta(m) ='), liq.indexOf('music_meta.on_metadata('));
assert.equal(
  onMetaBody.split('jingle_now_on_air := false').length - 1, 3,
  'every on_meta branch clears jingle_now_on_air',
);

// Clip length rides in the marker: the controller can only parse RIFF, and an
// import on a host without ffmpeg keeps its original container.
assert.ok(branchBody.includes('durationSec = jingle_duration(fname)'),
  'the marker carries a measured duration, not just a filename');
assert.ok(liq.includes('null.get(default=0., request.duration(fname))'),
  'jingle_duration measures via request.duration and degrades to 0 (unmeasured)');

test.after(() => {
  if (existsSync(STATE)) rmSync(STATE, { recursive: true, force: true });
});
