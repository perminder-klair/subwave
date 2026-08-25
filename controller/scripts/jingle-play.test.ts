// Pins the on-demand jingle path — POST /jingles/:filename/play →
// queue.playJingle → jingle-now.txt → Liquidsoap's priority queue → on_meta.

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
const jingleDir = join(STATE, 'jingles');
mkdirSync(jingleDir, { recursive: true });
writeFileSync(join(jingleDir, filename), 'audio');
writeFileSync(join(STATE, 'jingles.json'), JSON.stringify({
  items: { [filename]: { text: 'Event announcement' } },
}));

test('manual jingle uses a priority handoff without touching the FIFO track handoff', async () => {
  writeFileSync(config.liquidsoap.queueFile, 'existing-track');

  await queue.playJingle(filename);

  assert.equal(readFileSync(config.liquidsoap.queueFile, 'utf8'), 'existing-track');
  assert.equal(
    readFileSync(join(STATE, 'jingle-now.txt'), 'utf8'),
    `annotate:subwave_kind="jingle":${join(jingleDir, filename)}`,
  );
  // Simulate Liquidsoap consuming the handoff so the per-file release chain is
  // settled before the error-path test replaces the target with a directory.
  rmSync(join(STATE, 'jingle-now.txt'));
  await new Promise(resolve => setTimeout(resolve, 150));
});

test('manual jingle rejects when its priority handoff cannot be written', async () => {
  const livePath = config.liquidsoap.jingleFile;
  config.liquidsoap.jingleFile = join(STATE, 'missing-parent', 'jingle-now.txt');
  try {
    await assert.rejects(queue.playJingle(filename));
  } finally {
    config.liquidsoap.jingleFile = livePath;
  }
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
assert.ok(branchBody.includes('jingle-playing.json'), 'writes the collision-guard marker');
assert.ok(branchBody.includes('jingle_now_tmp_dir'), 'own temp dir — one per writer, #1240');
assert.ok(!branchBody.includes('temp_dir=jingle_tmp_dir'), 'never shares the rotate writer staging dir');
assert.ok(!branchBody.includes('now-playing.json'), 'an announcement is not a song');
assert.ok(!branchBody.includes('insert_metadata'), 'and never touches the ICY title');

// A dedicated source is the only way to get ahead of an already-populated
// FIFO dj_queue. Its availability gate preserves a manual press while deferring
// it past active speech or a bed/track pair.
const priorityQueue = liq.indexOf('jingle_now_queue = request.queue(id="jingle_now_queue")');
const priorityFallback = liq.indexOf('[jingle_now, music]');
assert.ok(priorityQueue > 0, 'on-demand jingles have a dedicated request queue');
assert.ok(priorityFallback > priorityQueue, 'the dedicated queue wins the next safe boundary');
const gateWindow = liq.slice(priorityQueue, priorityFallback);
assert.ok(gateWindow.includes('not bed_on_air()'), 'a jingle cannot split a bed from its track');
assert.ok(gateWindow.includes('time() > voice_until()'), 'a jingle cannot start over active speech');
assert.ok(priorityFallback > liq.indexOf('rotate(weights=[1, jingle_ratio()]'),
  'manual priority wraps the automatic rotate so an automatic jingle cannot win first');

test.after(() => {
  if (existsSync(STATE)) rmSync(STATE, { recursive: true, force: true });
});
