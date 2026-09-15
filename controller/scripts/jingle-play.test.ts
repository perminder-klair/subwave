// Pins the on-demand jingle path — POST /jingles/:filename/play →
// queue.playJingle → jingle-now.txt → Liquidsoap's priority queue and its own
// marker hook (NOT on_meta, which never sees that source).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-jingle-play-'));
process.env.STATE_DIR = STATE;

const { config } = await import('../src/config.js');
const { importAudio, jingleUri } = await import('../src/broadcast/jingles.js');
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
const builtin = 'station_ident_default.wav';
const jingleDir = join(STATE, 'jingles');
mkdirSync(jingleDir, { recursive: true });
writeFileSync(join(jingleDir, filename), 'audio');
writeFileSync(join(jingleDir, other), 'audio');
writeFileSync(join(jingleDir, builtin), 'audio');
writeFileSync(join(STATE, 'jingles.json'), JSON.stringify({
  items: {
    [filename]: { text: 'Event announcement' },
    [other]: { text: 'Sponsor spot' },
    [builtin]: { text: 'Station ident', builtin: true, source: 'builtin' },
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

function pcmWav(sampleRate: number, channels: 1 | 2, durationSec = 4): Buffer {
  const frames = Math.round(sampleRate * durationSec);
  const data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const hz = channel === 0 ? 440 : 660;
      const sample = Math.round(Math.sin(2 * Math.PI * hz * frame / sampleRate) * 8_000);
      data.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

function commandExists(command: string): boolean {
  const probe = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

function probeAudio(path: string) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
    '-of', 'json', path,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return {
    codec: parsed.streams[0].codec_name as string,
    sampleRate: Number(parsed.streams[0].sample_rate),
    channels: Number(parsed.streams[0].channels),
    duration: Number(parsed.format.duration),
  };
}

test('uploaded WAVs are normalized to 44.1 kHz PCM while preserving mono/stereo', async (t) => {
  if (!commandExists('ffmpeg') || !commandExists('ffprobe')) {
    t.skip('real ffmpeg and ffprobe are required for codec verification');
    return;
  }

  for (const input of [
    { sampleRate: 192_000, channels: 1 as const, label: 'High-rate mono' },
    { sampleRate: 192_000, channels: 2 as const, label: 'High-rate stereo' },
    { sampleRate: 44_100, channels: 1 as const, label: 'Control' },
  ]) {
    const created = await importAudio(pcmWav(input.sampleRate, input.channels), {
      label: input.label,
      originalName: `${input.label}.wav`,
    });
    assert.match(created.filename, /^jingle_[0-9a-f]{8}\.wav$/);
    assert.equal(created.text, input.label);
    const audio = probeAudio(join(jingleDir, created.filename));
    assert.equal(audio.codec, 'pcm_s16le');
    assert.equal(audio.sampleRate, 44_100);
    assert.equal(audio.channels, input.channels);
    assert.ok(Math.abs(audio.duration - 4) <= 0.03, `duration changed to ${audio.duration}s`);

    const meta = JSON.parse(readFileSync(join(STATE, 'jingles.json'), 'utf8'));
    const entry = meta.items[created.filename];
    assert.equal(entry.text, input.label);
    assert.equal(entry.builtin, false);
    assert.equal(entry.source, 'upload');
    assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
    const playlist = readFileSync(join(STATE, 'jingles.m3u'), 'utf8');
    assert.ok(playlist.includes(join(jingleDir, created.filename)));
    assert.deepEqual(meta.items[builtin], {
      text: 'Station ident', builtin: true, source: 'builtin',
    }, 'the built-in ident registration is preserved');
    assert.ok(playlist.includes(join(jingleDir, builtin)), 'the built-in ident stays in rotation');
  }
});

test('undecodable audio leaves the existing library byte-for-byte unchanged', async (t) => {
  if (!commandExists('ffmpeg')) {
    t.skip('real ffmpeg is required for decode-failure verification');
    return;
  }
  const beforeFiles = readFileSync(join(STATE, 'jingles.json'), 'utf8');
  const beforePlaylist = readFileSync(join(STATE, 'jingles.m3u'), 'utf8');
  const beforeNames = readdirSync(jingleDir).sort();
  await assert.rejects(
    importAudio(Buffer.from('not a decodable WAV'), { label: 'Broken', originalName: 'broken.wav' }),
    /ffmpeg failed/,
  );
  assert.equal(readFileSync(join(STATE, 'jingles.json'), 'utf8'), beforeFiles);
  assert.equal(readFileSync(join(STATE, 'jingles.m3u'), 'utf8'), beforePlaylist);
  assert.deepEqual(readdirSync(jingleDir).sort(), beforeNames);
  const registered = new Set(Object.keys(JSON.parse(beforeFiles).items));
  const disk = new Set(readFileSync(join(STATE, 'jingles.m3u'), 'utf8')
    .trim().split('\n').filter(Boolean).map(p => p.split('/').pop()));
  assert.deepEqual(disk, registered);
});

const CHILD_IMPORT = String.raw`
  import { readdir, readFile } from 'node:fs/promises';
  const { importAudio } = await import('./src/broadcast/jingles.js');
  const result = {};
  try {
    result.created = await importAudio(Buffer.from('not audio'), { label: 'Broken', originalName: 'broken.wav' });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.files = await readdir(process.env.STATE_DIR + '/jingles').catch(() => []);
  result.meta = JSON.parse(await readFile(process.env.STATE_DIR + '/jingles.json', 'utf8').catch(() => '{"items":{}}'));
  result.playlist = await readFile(process.env.STATE_DIR + '/jingles.m3u', 'utf8').catch(() => '');
  process.stdout.write(JSON.stringify(result));
`;

function childImport(pathValue: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const state = mkdtempSync(join(tmpdir(), 'subwave-jingle-import-child-'));
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', CHILD_IMPORT,
  ], {
    cwd: join(here, '..'),
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, PATH: pathValue, ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return { state, body: JSON.parse(result.stdout) };
}

test('a missing ffmpeg rejects the upload before registration', () => {
  const bin = mkdtempSync(join(tmpdir(), 'subwave-no-ffmpeg-'));
  const { state, body } = childImport(bin);
  try {
    assert.match(body.error, /ffmpeg.*required.*broadcast-compatible/i);
    assert.deepEqual(body.files, []);
    assert.deepEqual(body.meta, { items: {} });
    assert.equal(body.playlist, '');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

const CHILD_SUCCESS_ROUTE = String.raw`
  import express from 'express';
  import { createServer } from 'node:http';
  import { readFile } from 'node:fs/promises';
  const { router } = await import('./src/routes/jingles.js');
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const results = [];
  for (const spec of JSON.parse(process.env.ROUTE_SPECS)) {
    const form = new FormData();
    form.append('label', spec.label);
    form.append('file', new Blob([await readFile(spec.path)], { type: 'audio/wav' }), spec.name);
    const response = await fetch('http://127.0.0.1:' + port + '/jingles/upload', {
      method: 'POST', body: form,
    });
    results.push({ status: response.status, body: await response.json() });
  }
  await new Promise(resolve => server.close(resolve));
  process.stdout.write(JSON.stringify(results));
`;

test('POST /jingles/upload normalizes successful 192 kHz mono and stereo uploads', async (t) => {
  if (!commandExists('ffmpeg') || !commandExists('ffprobe')) {
    t.skip('real ffmpeg and ffprobe are required for successful multipart verification');
    return;
  }
  const state = mkdtempSync(join(tmpdir(), 'subwave-jingle-route-success-'));
  const specs = [
    { path: join(state, 'route-mono.wav'), name: 'route-mono.wav', label: 'Route mono', channels: 1 },
    { path: join(state, 'route-stereo.wav'), name: 'route-stereo.wav', label: 'Route stereo', channels: 2 },
  ] as const;
  for (const spec of specs) writeFileSync(spec.path, pcmWav(192_000, spec.channels));
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', CHILD_SUCCESS_ROUTE,
  ], {
    cwd: join(here, '..'), encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, ADMIN_USER: '', ADMIN_PASS: '',
      ROUTE_SPECS: JSON.stringify(specs) },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const responses = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n') + 1));
    const meta = JSON.parse(readFileSync(join(state, 'jingles.json'), 'utf8'));
    const playlist = readFileSync(join(state, 'jingles.m3u'), 'utf8');
    for (let i = 0; i < specs.length; i++) {
      const { status, body } = responses[i];
      assert.equal(status, 200);
      assert.equal(body.text, specs[i].label);
      assert.match(body.filename, /^jingle_[0-9a-f]{8}\.wav$/);
      const audio = probeAudio(join(state, 'jingles', body.filename));
      assert.deepEqual(audio, {
        codec: 'pcm_s16le', sampleRate: 44_100, channels: specs[i].channels, duration: 4,
      });
      assert.equal(meta.items[body.filename].text, specs[i].label);
      assert.equal(meta.items[body.filename].source, 'upload');
      assert.ok(playlist.includes(join(state, 'jingles', body.filename)));
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

const CHILD_ROUTE = String.raw`
  import express from 'express';
  import { createServer } from 'node:http';
  import { readdir, readFile } from 'node:fs/promises';
  const { router } = await import('./src/routes/jingles.js');
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const form = new FormData();
  form.append('label', 'Broken route upload');
  form.append('file', new Blob([Buffer.from('not audio')], { type: 'audio/wav' }), 'broken.wav');
  const response = await fetch('http://127.0.0.1:' + port + '/jingles/upload', { method: 'POST', body: form });
  const body = await response.json();
  await new Promise(resolve => server.close(resolve));
  const files = await readdir(process.env.STATE_DIR + '/jingles').catch(() => []);
  const meta = JSON.parse(await readFile(process.env.STATE_DIR + '/jingles.json', 'utf8').catch(() => '{"items":{}}'));
  process.stdout.write(JSON.stringify({ status: response.status, body, files, meta }));
`;

test('POST /jingles/upload returns the actionable ffmpeg refusal as a 400', () => {
  const state = mkdtempSync(join(tmpdir(), 'subwave-jingle-route-child-'));
  const bin = mkdtempSync(join(tmpdir(), 'subwave-no-ffmpeg-route-'));
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', CHILD_ROUTE,
  ], {
    cwd: join(here, '..'), encoding: 'utf8',
    env: { ...process.env, STATE_DIR: state, PATH: bin, ADMIN_USER: '', ADMIN_PASS: '' },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /ffmpeg.*required.*broadcast-compatible/i);
    assert.deepEqual(response.files, []);
    assert.deepEqual(response.meta, { items: {} });
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('a failed conversion removes its partial destination and registers nothing', () => {
  const bin = mkdtempSync(join(tmpdir(), 'subwave-failing-ffmpeg-'));
  const ffmpeg = join(bin, 'ffmpeg');
  writeFileSync(ffmpeg, `#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\nout=""\nfor arg in "$@"; do out="$arg"; done\nprintf partial > "$out"\necho deliberate failure >&2\nexit 9\n`);
  chmodSync(ffmpeg, 0o755);
  const { state, body } = childImport(bin);
  try {
    assert.match(body.error, /ffmpeg failed \(exit 9\): deliberate failure/);
    assert.deepEqual(body.files, []);
    assert.deepEqual(body.meta, { items: {} });
    assert.equal(body.playlist, '');
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
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
assert.ok(branchBody.includes('durationSec = jingle_duration(fname)'),
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
