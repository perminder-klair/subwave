// Pins the on-demand jingle path — POST /jingles/:filename/play →
// queue.playJingle → jingle-now.txt → Liquidsoap's priority queue, and the
// marker hook every jingle reaches (NOT on_meta, which never sees that source).

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
const { setJingleRotateOwner } = await import('../src/broadcast/jingle-rotate.js');

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

// The priority queue is a FIFO with no remove path, and the switch keeps
// choosing it at each safe boundary while it is non-empty — so a retried tool
// call or a double-clicked button would air the same announcement twice with no
// way back short of /restart-mixer.
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

test('an overlay marker cannot retire a pending manual press of the same jingle', async () => {
  assert.deepEqual(await queue.playJingle(other), { ok: true });
  rmSync(join(STATE, 'jingle-now.txt'));
  const pressedAt = queue._pendingJingles.get(other)!.at;
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify({
    filename: join(jingleDir, other),
    placement: 'over',
    startedAt: (pressedAt + 1000) / 1000,
  }));

  assert.deepEqual(await queue.playJingle(other), { ok: false, reason: 'already-queued' });
  assert.ok(queue._pendingJingles.has(other), 'the manual press remains pending');
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

// The marker is written where a jingle goes ON AIR, never on a jingle's own
// source. Both are request sources, and a request source starts its next ready
// request in the frame that ends the current one, firing that request's hooks
// before the rotate or the fallback has chosen it. Measured on 2.4.6 with the
// writer on the rotate's playlist: each automatic jingle was marked at the END
// of the one before, N tracks early, and its real airing wrote nothing — so the
// DJ was not held off a long stinger, was held over the song after it, and the
// seam record moved "After jingle" one song late.
//
// The hook only books the jingle (on the streaming thread, so in feed order) and
// hands the write to a task: request.duration and file I/O stay off that thread.
const writerAt = liq.indexOf('def write_jingle_marker(');
const writer = liq.slice(writerAt, liq.indexOf('\nend\n', writerAt));
const spawnAt = liq.indexOf('thread.run(fast=false, fun () -> write_jingle_marker(');
const markerHook = liq.lastIndexOf('music.on_track(synchronous=true, fun (m) ->', spawnAt);
const branchBody = liq.slice(markerHook, liq.indexOf('\n)\n', markerHook));
const jingleNowSwitch = liq.indexOf('id="music_with_jingle_now"');

test('jingle-playing.json is written from the source cross reads, for both kinds of jingle', () => {
  assert.ok(writerAt > 0 && markerHook > 0 && spawnAt > markerHook, 'the marker hook exists and spawns the writer');
  assert.ok(branchBody.includes('thread.run(fast=false, fun () -> write_jingle_marker('),
    'the write runs off the streaming thread');
  assert.ok(jingleNowSwitch > 0 && markerHook > jingleNowSwitch,
    'below the jingle_now switch, so it sees what that switch CHOSE');
  assert.ok(markerHook < liq.indexOf('music = cross('), 'and above cross: written at feed time');
  assert.ok(!/^music = /m.test(liq.slice(jingleNowSwitch, markerHook)),
    'on the switch\'s own output, with nothing re-bound in between');
  assert.ok(liq.indexOf('music_meta = music') < markerHook,
    'below music_meta: a clip\'s own ID3 tags never reach now-playing or the ICY title');
  assert.ok(branchBody.includes('if m["subwave_jingle"] == "true" then'),
    'only jingles — the rotate and jingle_now both stamp the mark');
  assert.ok(branchBody.includes('fed_at = time()'), 'stamped at feed, on the streaming thread');
  assert.ok(writer.includes('"#{state_dir}/jingle-playing.json"'), 'writes the collision-guard marker');
  assert.ok(writer.includes('temp_dir=jingle_tmp_dir'), 'through its own staging dir, #1240');
  assert.ok(writer.includes('catch err do'), 'a failed write is logged, never raised in the task');
  assert.ok(!writer.includes('now-playing.json') && !branchBody.includes('now-playing.json'),
    'an announcement is not a song');
  assert.ok(!writer.includes('insert_metadata'), 'and never touches the ICY title');
  for (const field of ['filename = fname', 'durationSec = dur', 'startedAt = fed_at', 'queuedSec = queued']) {
    assert.ok(writer.includes(field), `the payload carries ${field.split(' ')[0]}`);
  }
  assert.ok(!liq.includes('music.on_track(synchronous=false'), 'no second, unordered writer');
});

// Back to back: cross takes a jingle shorter than the crossfade whole and the
// next track's head right behind it, so a second jingle is fed milliseconds
// after the first but airs only once the first has ended. Measured on 2.4.6
// (two 3s presses a bed had held): fed 0.06s apart, the second aired 12.96s
// after its own feed, so a window opened at that feed left its last 1.96s
// unheld. Only the mixer sees the feed order — the first marker is overwritten
// before the controller can read it — so it stamps the wait itself
// (scripts/jingle-burst-window.test.ts replays the controller's side).
test('the marker says how long a jingle waits behind the jingles fed just before it', () => {
  assert.ok(branchBody.includes('ahead = jingle_burst()'), 'the jingles already fed in this run');
  assert.ok(branchBody.includes('jingle_burst := []'), 'and any other track ends the run');
  const queued = liq.slice(liq.indexOf('def jingle_queued_sec('), writerAt);
  assert.ok(queued.includes('max(clear, snd(j)) + dur'),
    'each starts at the later of its feed and the end of the one before');
  // A longer one is read at the pace it airs, so what follows it is fed as its
  // end is buffered: measured, a 3s clip fed 4s into a 14s one aired at the
  // usual distance from its own feed, and a chained wait over-held it by 10s.
  assert.ok(queued.includes('if dur < crossfade_duration() then'),
    'and only a jingle shorter than the crossfade holds the next one back');
  assert.ok(queued.includes('max(0., list.fold(ends, 0., ahead) - fed_at)'),
    'and a jingle that waits for nothing says 0');
  // Tasks run on several threads, so the first of a burst can finish last.
  assert.ok(branchBody.includes('jingle_marker_seq := jingle_marker_seq() + 1'), 'every jingle is numbered in feed order');
  assert.ok(writer.includes('if seq == jingle_marker_seq() then'),
    'and a write stands down once a later jingle has been fed');
});

test('neither jingle source writes the marker from its own hook', () => {
  const rotate = liq.slice(liq.indexOf('jingles = playlist('), liq.indexOf('rotate(weights=[1, jingle_ratio()]'));
  assert.ok(rotate.length > 0, 'the rotate block is still where this test looks');
  assert.ok(!rotate.includes('jingle-playing.json'),
    'the playlist starts its next clip at the end of the current one, N tracks before it airs');
  const nowHookAt = liq.indexOf('jingle_now_queue.on_metadata(');
  const nowHook = liq.slice(nowHookAt, liq.indexOf('\n\n', nowHookAt));
  assert.ok(nowHook.includes('jingle_now_on_air := true'), 'the priority queue still arms the rotate gate');
  assert.ok(!nowHook.includes('jingle-playing.json'),
    'a second queued press is started by the queue before the switch chooses it');
  assert.ok(!liq.includes('jingle_now_tmp_dir'), 'its staging dir went with its writer');
});

// A dedicated source is the only way to get ahead of an already-populated
// FIFO dj_queue. The switch's predicate preserves a manual press while deferring
// it past active speech or a bed/track pair.
const priorityQueue = liq.indexOf('jingle_now_queue = request.queue(id="jingle_now_queue")');
const prioritySwitch = liq.lastIndexOf('music = switch(', jingleNowSwitch);
const priorityGate = liq.indexOf('({not bed_on_air()', prioritySwitch);
const priorityChoices = liq.indexOf('({true}, music)', prioritySwitch);
assert.ok(priorityQueue > 0, 'on-demand jingles have a dedicated request queue');
assert.ok(prioritySwitch > priorityQueue && jingleNowSwitch - prioritySwitch < 40,
  'the dedicated queue is the first choice of the music_with_jingle_now switch');
assert.ok(priorityGate > prioritySwitch && priorityChoices > priorityGate,
  'gated by its own predicate, ahead of the music it wraps');
// Anchored at the predicate itself, NOT at the queue declaration ~770 lines
// above: the automatic rotate's gate carries both of these strings, so a window
// that started any earlier passed even with this gate deleted outright.
const gateWindow = liq.slice(priorityGate, liq.indexOf('jingle_now)', priorityGate));
assert.ok(gateWindow.includes('not bed_on_air()'), 'a jingle cannot split a bed from its track');
assert.ok(gateWindow.includes('time() > voice_until()'), 'a jingle cannot start over active speech');
assert.ok(gateWindow.includes('not pause_talk_on_air()'), 'nor over a pause-and-talk break');
assert.ok(prioritySwitch > liq.indexOf('rotate(weights=[1, jingle_ratio()]'),
  'manual priority wraps the automatic rotate so an automatic jingle cannot win first');

// A gate decides whether a jingle may START. Asked on every frame (a
// source.available gate, as both once were), a bed pre-started at the boundary
// a press won, or a DJ clip, closed it mid-clip: measured on 2.4.6, a 14s
// announcement aired 10s, two songs played, then its last 4s.
test('a jingle that has started plays to its end', () => {
  assert.ok(liq.slice(prioritySwitch, priorityGate).includes('track_sensitive=true'),
    'the press gate is asked only when the switch chooses, at a track boundary');
  assert.ok(!liq.includes('source.available(jingle_now_queue'), 'never as a per-frame gate on the press');
  // The rotate's gate stays an availability gate (the rotate is the stdlib's),
  // held open only while its own clip is on air: an open verdict must not
  // outlive the clip it was given for.
  assert.ok(liq.includes('jingles = source.available(jingles, track_sensitive={rotate_jingle_on_air() and '),
    'the rotate gate is latched for the clip on air, and only for it, never a constant true');
  const flagHook = liq.indexOf(
    'music.on_track(synchronous=true, fun (m) -> rotate_jingle_on_air := m["subwave_jingle_rotate"] == "true")');
  assert.ok(flagHook > jingleNowSwitch && flagHook < liq.indexOf('music = cross('),
    'set where a clip is chosen, on the source cross reads');
  assert.ok(!/^music = /m.test(liq.slice(jingleNowSwitch, flagHook)), 'with nothing re-bound in between');
  const rotateMark = liq.slice(liq.indexOf('jingles = metadata.map('), liq.indexOf('rotate(weights=[1, jingle_ratio()]'));
  assert.ok(rotateMark.includes('("subwave_jingle_rotate", "true")'), 'which tells the rotate\'s clips from a press');
  // Released on the playlist itself, inside the frame where it starts its next
  // clip and before the gate sees that frame's track mark. Re-checked at the
  // mark, a closed gate dropped the rest of the frame: the next clip's head and
  // metadata, so it aired later under the previous clip's name and length.
  const release = liq.indexOf('jingles.on_track(synchronous=true, fun (_) -> rotate_jingle_on_air := false)');
  assert.ok(release > liq.indexOf('jingles = playlist(') && release < liq.indexOf('jingles = source.available(jingles,'),
    'the latch is released on the raw playlist, below the gate');
});

// Back to back, the rotate chooses the next clip in the same cycle the last one
// ends, on the verdict the latch held. With the music chain starved there is
// nothing else to turn to, so a held gate was never asked `not
// music_starved()` again: measured on the baked image (empty auto.m3u, ratio
// 1), the starve latched at 31.6s and stingers kept airing to the end of a 120s
// run with no emergency switch (#1300 bug 7).
test('the latch never holds the rotate open over a latched starve', () => {
  assert.ok(liq.includes('track_sensitive={rotate_jingle_on_air() and not music_starved()}'),
    'once the starve guard latches, the rotate gate is asked every cycle again');
});

// The rotate must also stand down while a manual jingle is on air, or it stacks
// a stinger on top of the announcement.
const rotateGate = liq.slice(
  liq.indexOf('jingles = source.available(jingles,'),
  liq.indexOf('rotate(weights=[1, jingle_ratio()]'),
);
assert.ok(rotateGate.includes('not jingle_now_on_air()'),
  'the rotate defers to a manual jingle already on air');
// ...and the flag has to be cleared by every on_meta branch, or it latches true
// and starves the rotate permanently (the bed_on_air failure, repeated).
const onMetaBody = liq.slice(liq.indexOf('def on_meta(m) ='), liq.indexOf('music_meta.on_metadata('));
// DERIVED from the branch count, not hardcoded: the point of the assertion is
// "every branch", and a literal silently stops meaning that the moment someone
// adds one (pause-talk made it four). Counting both sides is what catches the
// branch that forgot the clear.
const onMetaBranches = (onMetaBody.match(/^\s*(?:if|elsif|else)\b/gm) || []).length;
assert.equal(
  onMetaBody.split('jingle_now_on_air := false').length - 1, onMetaBranches,
  'every on_meta branch clears jingle_now_on_air',
);

// The two LATCHING flags follow the same rule one step removed: each is set
// true by its own branch and must be cleared by every OTHER one, or it starves
// the jingle rotate forever — the bed_on_air failure the comment above records,
// which pause_talk_on_air inherited wholesale by copying its shape.
for (const flag of ['bed_on_air', 'pause_talk_on_air']) {
  assert.equal(
    onMetaBody.split(`${flag} := false`).length - 1, onMetaBranches - 1,
    `every on_meta branch but its own clears ${flag}`,
  );
  assert.equal(
    onMetaBody.split(`${flag} := true`).length - 1, 1,
    `${flag} is latched by exactly one branch`,
  );
}

const pauseMarkerBranch = onMetaBody.slice(
  onMetaBody.indexOf('if m["subwave_kind"] == "pause-talk" then'),
  onMetaBody.indexOf('elsif m["subwave_kind"] == "bed" then'),
);
assert.ok(pauseMarkerBranch.includes('temp_dir=pause_talk_tmp_dir'),
  'the pause marker has its own atomic staging directory');
assert.ok(!pauseMarkerBranch.includes('temp_dir=bed_tmp_dir'),
  'the pause and bed writers cannot race through one atomic.write file');
assert.ok(liq.includes('pause_voice_accept_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-accept")'),
  'pause voice acceptance has one atomic writer directory');
assert.ok(liq.includes('pause_voice_start_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/pause-voice-start")'),
  'pause voice start has a separate atomic writer directory');
const voicePoll = liq.slice(liq.indexOf('def poll_voice() ='), liq.indexOf('def poll_intro() ='));
assert.ok(
  voicePoll.indexOf('voice_queue.push(request.create(contents))')
    < voicePoll.indexOf('write_pause_voice_accepted(contents)'),
  'acceptance is acknowledged only after the mixer owns the voice request',
);
const voiceMarker = liq.slice(liq.indexOf('def voice_marker(channel, tmp_dir) ='), liq.indexOf('voice_queue.on_metadata'));
assert.ok(voiceMarker.includes('"#{state_dir}/pause-talk-voice-started.json"'),
  'the actual first spoken sample gets a durable pause-specific marker');
assert.ok(voiceMarker.includes('temp_dir=pause_voice_start_tmp_dir'),
  'the pause start marker uses its own writer directory');

// Both gates gate the manual jingle AND the rotate: a stinger must not split
// either kind of break from the song it leads into.
assert.ok(gateWindow.includes('not pause_talk_on_air()'),
  'a jingle cannot split a pause-and-talk break from its track');
assert.ok(rotateGate.includes('not pause_talk_on_air()'),
  'the rotate cannot split a pause-and-talk break from its track');

// Clip length rides in the marker: the controller can only parse RIFF, and an
// import on a host without ffmpeg keeps its original container.
assert.ok(writer.includes('dur = jingle_duration(fname)') && writer.includes('durationSec = dur'),
  'the marker carries a measured duration, not just a filename');
assert.ok(liq.includes('null.get(default=0., request.duration(fname))'),
  'jingle_duration measures via request.duration and degrades to 0 (unmeasured)');

// ---------------------------------------------------------------------------
// THE AUTOMATIC ROTATE, CONTROLLER-OWNED (#1619)
//
// broadcast/jingle-rotate.ts's own test covers the pure decisions — who owns
// the rotate, when it is due, which clip to draw, how the row arbitrates. What
// only reachable here is the QUEUE half: the handoff itself, the boundary count
// that makes it due, and the rule the whole design turns on — a rotate that
// fires and cannot draw SPENDS the offer rather than banking it.
// ---------------------------------------------------------------------------

// A track boundary normally hands a "track started" event to the session DJ
// agent, which reaches a real model over the network. That is not what these
// tests are about, and leaving it on makes them slow and dependent on whatever
// LLM the developer's settings happen to point at — so switch the auto-DJ off
// for the rest of the file, the same knob an idle-paused station uses.
queue.autoPick = false;
queue.autoLink = false;

// Seed the queue's in-memory state through the snapshot it actually restores
// from, rather than by poking privates: this is also the NB-3 half of the
// contract (the count is absolute, so it has to survive a controller rebuild).
function recoverWith(snapshot: Record<string, unknown>) {
  writeFileSync(config.queue.file, JSON.stringify({
    upcoming: [], current: null, history: [], ...snapshot,
  }));
  queue.recover();
}

test('the boundary count survives a controller restart, and repairs junk', () => {
  recoverWith({ tracksSinceJingle: 12, lastRotateJingle: other });
  assert.equal(queue.rotateJingleTracksSince(), 12,
    'a rebuilt controller must not restart the count — that costs a whole ratio of tracks');

  // The snapshot is on the operator's disk; a junk value here decides how long
  // the station goes without a stinger.
  for (const junk of [-4, 'twelve', null, undefined, NaN]) {
    recoverWith({ tracksSinceJingle: junk });
    assert.equal(queue.rotateJingleTracksSince(), 0, `junk count ${String(junk)} repairs to 0`);
  }
  // A snapshot written before #1619 has no such field at all — pre-existing
  // behaviour, which is a fresh count.
  recoverWith({});
  assert.equal(queue.rotateJingleTracksSince(), 0);
});

test('a track boundary is what makes the rotate due', () => {
  recoverWith({ tracksSinceJingle: 0 });
  queue.onTrackStarted({ title: 'One', artist: 'A', subsonic_id: 'id-1' } as any);
  queue.onTrackStarted({ title: 'Two', artist: 'B', subsonic_id: 'id-2' } as any);
  assert.equal(queue.rotateJingleTracksSince(), 2, 'each music boundary counts once');

  // The same metadata firing again is the watcher re-reading one boundary, not
  // a second track — it must not advance the rotate towards due.
  queue.onTrackStarted({ title: 'Two', artist: 'B', subsonic_id: 'id-2' } as any);
  assert.equal(queue.rotateJingleTracksSince(), 2, 'a repeated marker is one boundary');

  // A titleless marker is not a song (it is how a bed reaches this watcher).
  queue.onTrackStarted({ title: '', artist: '' } as any);
  queue.onTrackStarted(null);
  assert.equal(queue.rotateJingleTracksSince(), 2, 'only real music boundaries count');
});

test('a drawn rotate hands over through the same single writer, and restarts the count', async () => {
  recoverWith({ tracksSinceJingle: 30, lastRotateJingle: null });
  rmSync(join(STATE, 'jingle-now.txt'), { force: true });

  assert.equal(await queue.playRotateJingle(), true);
  const handed = readFileSync(join(STATE, 'jingle-now.txt'), 'utf8');
  assert.ok(handed.startsWith('annotate:subwave_kind="jingle":'),
    'the rotate writes nothing of its own — playJingle is still the only writer');
  assert.equal(queue.rotateJingleTracksSince(), 0,
    'the count restarts at the HANDOFF, so "1 every N" stays a count of tracks');

  await markAired(handed.split(':').pop()!.split('/').pop()!);
});

// The rule the design argues hardest for, and the one with no other home:
// radio.liq's rotate was gated by `source.available`, so a jingle that came due
// at a boundary where the gate was shut was SKIPPED, not banked. Banking it
// would leave the row due on every subsequent minute, holding the seam against
// the segment director until the library was filled.
test('a rotate that cannot draw a clip SPENDS the offer rather than banking it', async () => {
  const meta = readFileSync(join(STATE, 'jingles.json'), 'utf8');
  recoverWith({ tracksSinceJingle: 30 });
  rmSync(join(STATE, 'jingle-now.txt'), { force: true });
  writeFileSync(join(STATE, 'jingles.json'), JSON.stringify({ items: {} }));
  try {
    assert.equal(await queue.playRotateJingle(), false, 'an empty library draws nothing');
    assert.ok(!existsSync(join(STATE, 'jingle-now.txt')), 'and hands nothing over');
    assert.equal(queue.rotateJingleTracksSince(), 0,
      'the offer is spent — the next rotate is N tracks away, not this minute again');
  } finally {
    writeFileSync(join(STATE, 'jingles.json'), meta);
  }
});

// NB-4. The operator's button must never be wedged shut by bookkeeping the
// operator did not cause — controller/CLAUDE.md states that about a mixer
// restart, and a shared budget reintroduces it from the other side.
test('the rotate does not spend the operator press budget', async () => {
  recoverWith({ tracksSinceJingle: 30, lastRotateJingle: null });
  rmSync(join(STATE, 'jingle-now.txt'), { force: true });

  assert.equal(await queue.playRotateJingle(), true);
  // Liquidsoap drains the handoff within a poll; standing in for it here keeps
  // the next write off writeHandoff's 5s wait-for-drain.
  const rotated = readFileSync(join(STATE, 'jingle-now.txt'), 'utf8').split('/').pop()!;
  rmSync(join(STATE, 'jingle-now.txt'));

  // A second rotate is refused on its OWN cap of one — a second pending rotate
  // can only mean the first never aired, and the FIFO has no remove path.
  recoverWith({ tracksSinceJingle: 30, lastRotateJingle: null });
  assert.equal(await queue.playRotateJingle(), false, 'one rotate in flight at a time');
  assert.ok(!existsSync(join(STATE, 'jingle-now.txt')), 'and hands nothing over');

  // ...and the operator still has their own slots, unspent. A DIFFERENT clip
  // from the one the rotate is holding, so this is the budget answering and not
  // the shared de-duplication.
  const pressable = [filename, other].filter(f => f !== rotated);
  assert.ok(pressable.length >= 1, 'at least one clip the rotate is not holding');
  for (const f of pressable) {
    assert.deepEqual(await queue.playJingle(f), { ok: true },
      'a pending rotate must not answer queue-full to an operator');
    rmSync(join(STATE, 'jingle-now.txt'), { force: true });
  }

  for (const f of [rotated, ...pressable]) await markAired(f);
});

// NB-5. The counter runs on every boundary regardless of owner — onTrackStarted
// has no business branching on a setting — so without this a station that has
// been up for hours fires a stinger on the very first tick after the toggle,
// on top of a mixer that has not restarted yet.
test('handing the rotate to the controller starts a clean N-track cycle', () => {
  recoverWith({ tracksSinceJingle: 47 });
  assert.equal(queue.rotateJingleTracksSince(), 47);

  setJingleRotateOwner('controller');
  assert.equal(queue.rotateJingleTracksSince(), 0, 'the switch restarts the count');

  // Going back is not a symmetric event: the count nothing is reading is not
  // the operator's to lose, and zeroing it would be a change they did not ask
  // for. Nor does re-asserting the same owner reset anything.
  recoverWith({ tracksSinceJingle: 9 });
  setJingleRotateOwner('mixer');
  assert.equal(queue.rotateJingleTracksSince(), 9, 'switching back leaves the count alone');
  setJingleRotateOwner('mixer');
  assert.equal(queue.rotateJingleTracksSince(), 9, 'a no-op save fires nothing');
});

test('the count reaches the snapshot, so the next boot can restore it', async () => {
  recoverWith({ tracksSinceJingle: 0 });
  queue.onTrackStarted({ title: 'Three', artist: 'C', subsonic_id: 'id-3' } as any);
  queue.persist();
  await new Promise(resolve => setTimeout(resolve, 700));  // persist() is debounced
  const snap = JSON.parse(readFileSync(config.queue.file, 'utf8'));
  assert.equal(snap.tracksSinceJingle, 1, 'the absolute count is written, not only derived');
});

test.after(() => {
  if (existsSync(STATE)) rmSync(STATE, { recursive: true, force: true });
});
