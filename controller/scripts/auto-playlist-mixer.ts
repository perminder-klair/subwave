// Opt-in real mixer reproduction for #1729, NOT part of the unit suite.
// Prerequisites/configuration: scripts/prepare-playlist-mixer.sh.
// From controller/: SUBWAVE_MIXER_ROOTFS=<disposable rootfs> npx tsx scripts/auto-playlist-mixer.ts
// To demonstrate RED: additionally set SUBWAVE_CONTROLLER_ROOT to an original
// controller checkout (with node_modules installed). No alternate expectation:
// the same zero-stream/publication assertions must fail on the original code.
// Uses real wall-clock cron boundaries, shortened to every minute. Audio graph,
// subhttp resolver, watcher, telnet, Icecast and scheduler are real. Only external
// Navidrome metadata/audio and Open-Meteo are fixtures; all traffic is loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootfs = resolve(process.env.SUBWAVE_MIXER_ROOTFS || '');
assert.ok(process.env.SUBWAVE_MIXER_ROOTFS, 'Set SUBWAVE_MIXER_ROOTFS to a disposable shipped-image rootfs');
await access(join(rootfs, '.subwave-1729-disposable'));
const controllerRoot = resolve(process.env.SUBWAVE_CONTROLLER_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const stateDir = join(rootfs, 'var/sub-wave');
const evidenceDir = await mkdtemp(join(tmpdir(), 'subwave-1729-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, message: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error(message);
}

execFileSync('sudo', ['-n', 'rm', '-rf', stateDir]);
execFileSync('sudo', ['-n', 'mkdir', '-p', stateDir]);
execFileSync('sudo', ['-n', 'chmod', '777', stateDir]);
const audioPath = join(evidenceDir, 'valid.flac');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180', '-c:a', 'flac', audioPath]);
const audio = await readFile(audioPath);
assert.ok(audio.length > 4096);
const streams: { at: string; id: string }[] = [];
const metadata: { at: string; method: string }[] = [];
let holdLatest = false;
let latestHeld = false;
let releaseLatest!: () => void;
const latestGate = new Promise<void>(r => { releaseLatest = r; });
const song = (id: string) => ({ id, title: id, artist: 'Fixture', album: 'Fixture', duration: 180, contentType: 'audio/flac', suffix: 'flac' });
const origin = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1:17829');
  if (!url.pathname.startsWith('/rest/')) { res.writeHead(503); res.end(); return; }
  const method = url.pathname.split('/').pop()?.replace(/\.view$/, '') || '';
  if (method === 'stream') {
    streams.push({ at: new Date().toISOString(), id: url.searchParams.get('id') || '' });
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': audio.length });
    res.end(audio);
    return;
  }
  metadata.push({ at: new Date().toISOString(), method });
  const id = url.searchParams.get('id') || 'initial';
  const data = {
    status: 'ok', version: '1.16.1',
    randomSongs: { song: [song('initial')] },
    albumList2: { album: [] }, starred2: { song: [] }, genres: { genre: [] },
    playlists: { playlist: ['first', 'second', 'latest'].map(x => ({ id: x, name: x })) },
    playlist: { id, name: id, entry: [song(id)] }, song: song(id),
  };
  const respond = () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'subsonic-response': data }));
  };
  if (holdLatest && method === 'getPlaylist' && id === 'latest') { latestHeld = true; void latestGate.then(respond); }
  else respond();
});
await new Promise<void>(r => origin.listen(17829, '127.0.0.1', r));

Object.assign(process.env, {
  STATE_DIR: stateDir, NAVIDROME_URL: 'http://127.0.0.1:17829', NAVIDROME_USER: 'fixture', NAVIDROME_PASS: 'fixture-only',
  LIQUIDSOAP_HOST: '127.0.0.1', LIQUIDSOAP_PORT: '1234',
  ICECAST_STATUS_URL: 'http://127.0.0.1:7702/status-json.xsl',
  ICECAST_ADMIN_URL: 'http://127.0.0.1:7702/admin/listclients', ICECAST_ADMIN_PASSWORD: 'fixture-only',
  ANALYZE_URL: 'http://127.0.0.1:17829', TTS_HEAVY_URL: 'http://127.0.0.1:17829',
});
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url.startsWith('https://api.open-meteo.com/')) {
    return Promise.resolve(Response.json({ current: { temperature_2m: 20, weather_code: 0, is_day: 1 } }));
  }
  assert.ok(url.startsWith('http://127.0.0.1:'), `Unexpected non-loopback fetch: ${new URL(url).origin}`);
  return realFetch(input, init);
};
const settings = await import(`${controllerRoot}/src/settings.ts`);
const { config } = await import(`${controllerRoot}/src/config.ts`);
const control = await import(`${controllerRoot}/src/broadcast/liquidsoap-control.ts`);
const monitor = await import(`${controllerRoot}/src/broadcast/stream-idle.ts`);
const listeners = await import(`${controllerRoot}/src/broadcast/listeners.ts`);
const scheduler = await import(`${controllerRoot}/src/broadcast/scheduler.ts`);
const { queue } = await import(`${controllerRoot}/src/broadcast/queue.ts`);
await settings.load();
await settings.update({
  jingleRatio: 0, crossfadeDuration: 0,
  stream: { idleWhenEmpty: true, idleAfterMinutes: 1, bufferSeconds: 5 },
  llm: { pauseWhenEmpty: true }, tts: { enabled: false },
  shows: ['first', 'second', 'latest'].map(id => ({ id, name: id, personaId: settings.get().personas[0].id, playlistIds: [id], playlistStrict: true })),
});
const playlistPath = join(stateDir, 'auto.m3u');
const initial = '#EXTM3U\nannotate:title="initial",artist="Fixture",subsonic_id="initial":subhttp:http://127.0.0.1:17829/rest/stream?id=initial.flac\n';
await writeFile(playlistPath, initial);
const output = createWriteStream(join(evidenceDir, 'broadcast.log'));
const mixer = spawn('sudo', ['-n', 'chroot', rootfs, '/usr/bin/env',
  'ICECAST_SOURCE_PASSWORD=fixture-only', 'ICECAST_ADMIN_PASSWORD=fixture-only', 'ICECAST_RELAY_PASSWORD=fixture-only',
  'ICECAST_TRUSTED_PROXY_HOSTS=localhost', '/usr/local/bin/broadcast-entrypoint'], { detached: true });
mixer.stdout.pipe(output); mixer.stderr.pipe(output);
const observations: Record<string, unknown>[] = [];
const violations: string[] = [];
function requireEqual(actual: unknown, expected: unknown, label: string) {
  try { assert.deepEqual(actual, expected, label); } catch { violations.push(label); }
}
const reloads = () => (execFileSync('sudo', ['-n', 'cat', join(rootfs, 'var/log/liquidsoap/radio.log')], { encoding: 'utf8' }).match(/\[auto:3\] Reloading playlist/g) || []).length;
const snapshot = () => ({ streams: streams.length, metadata: metadata.length, reloads: reloads() });
async function stage(label: string, fn: () => Promise<void>) {
  const before = snapshot();
  const file = await readFile(playlistPath, 'utf8');
  await fn(); await sleep(6000);
  const after = snapshot();
  const delta = { streams: after.streams - before.streams, metadata: after.metadata - before.metadata, reloads: after.reloads - before.reloads };
  const changed = file !== await readFile(playlistPath, 'utf8');
  observations.push({ label, at: new Date().toISOString(), ...delta, publicationChanged: changed });
  console.log(JSON.stringify(observations.at(-1)));
  requireEqual(delta.streams, 0, `${label}: automatic refresh streamed while idle`);
  requireEqual(delta.reloads, 0, `${label}: automatic refresh reloaded while idle`);
  requireEqual(delta.metadata, 0, `${label}: automatic refresh built while idle`);
  requireEqual(changed, false, `${label}: automatic refresh published while idle`);
}
async function changeShow(id: string) {
  const now = Date.now();
  await settings.update({ scheduleOverride: { showId: id, startedAt: now, expiresAt: now + 600_000 } });
  await scheduler.refreshAutoPlaylistOnShowChange('integration show boundary');
}
try {
  await until(async () => {
    try { const r = await realFetch('http://127.0.0.1:7702/status-json.xsl'); return !!(await r.json() as { icestats: { source?: unknown } }).icestats.source; } catch { return false; }
  }, 'mixer did not establish its MP3 mount', 60_000);
  await until(async () => { try { return (await readFile(join(stateDir, 'now-playing.json'), 'utf8')).includes('initial'); } catch { return false; } }, 'initial song never reached the real mixer');
  await control.idleOn();
  assert.equal(await control.idleStatus(), true);
  // Exclude initial asynchronous resolutions: demand 10 continuous quiet seconds.
  let count = streams.length;
  await sleep(10_000);
  assert.equal(streams.length, count, 'initial prefetch did not settle');
  // Characterize the two independent refresh triggers in the shipped mixer.
  // These are explicit test controls, not automatic scheduler requests.
  const characterization = async (label: string, fn: () => Promise<void>) => {
    const before = streams.length;
    await fn(); await sleep(6000);
    const delta = streams.length - before;
    assert.ok(delta > 0, `${label} did not reproduce idle streaming`);
    observations.push({ label, streams: delta });
    console.log(JSON.stringify(observations.at(-1)));
    const settled = streams.length;
    await sleep(3000);
    assert.equal(streams.length, settled, `${label} did not settle`);
  };
  await characterization('explicit-auto.reload', async () => { await control.reloadAutoPlaylist(); });
  await characterization('watch-only', async () => {
    const { writeFileAtomic } = await import(`${controllerRoot}/src/util/atomic-file.ts`);
    await writeFileAtomic(playlistPath, initial + '\n');
  });
  await listeners.startListenerMonitor();
  await monitor.startStreamIdleMonitor(scheduler.flushPendingAutoPlaylist);
  await until(() => monitor.isIdle(), 'controller did not adopt mixer pause');
  assert.equal(listeners.gatedListenerCount(), 0);
  const pausedTrack = JSON.parse(await readFile(join(stateDir, 'now-playing.json'), 'utf8'));
  assert.equal(pausedTrack.subsonic_id, 'initial');
  config.show.autoQueueRefreshMinutes = 1; // Same cron callback; two real wall-clock boundaries.
  await stage('startup', async () => { scheduler.startScheduler(); });
  await stage('show-first', () => changeShow('first'));
  for (const [boundary, show] of [[1, 'second'], [2, 'latest']] as const) {
    await stage(`show-${show}`, () => changeShow(show));
    await stage(`cron-boundary-${boundary}`, async () => {
      const wait = 60_000 - (Date.now() % 60_000);
      await sleep(wait + 1500);
      assert.equal(await control.idleStatus(), true);
      assert.equal(monitor.isIdle(), true);
    });
  }
  const resumeBefore = snapshot();
  const successesBefore = queue.djLog.filter((e: { message: string }) => e.message.startsWith('Auto-playlist refreshed:')).length;
  // Toggle-off uses production monitor transition, commits live and launches the
  // production background flush. No manual refresh is used to make it pass.
  holdLatest = true; // Hold the real origin response, not an internal builder.
  await settings.update({ stream: { idleWhenEmpty: false } });
  await until(() => !monitor.isIdle(), 'programme did not resume');
  assert.equal(await control.idleStatus(), false);
  // Capture actual Icecast output; decode PCM and require audible energy rather
  // than accepting a mount/metadata response as proof of playback.
  const capture = join(evidenceDir, 'resume.mp3');
  const client = spawn('curl', ['-fsS', '--max-time', '8', '-o', capture, 'http://127.0.0.1:7702/stream.mp3']);
  await new Promise<void>(r => client.on('exit', () => r()));
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', capture, '-f', 'f32le', '-ac', '1', '-'], { maxBuffer: 10_000_000 });
  let sum = 0;
  for (let i = 0; i + 4 <= pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 4));
  assert.ok(rms > 0.001, `resumed audio remained silent: RMS ${rms}`);
  requireEqual(latestHeld, true, 'resume must request latest playlist before origin release');
  const catalogueHeldDuringPlayback = latestHeld && await readFile(playlistPath, 'utf8') === initial + '\n';
  requireEqual(await readFile(playlistPath, 'utf8'), initial + '\n', 'playback must resume while latest catalogue response is still held');
  releaseLatest();
  await until(async () => (await readFile(playlistPath, 'utf8')).includes('subsonic_id="latest"'), 'resume did not publish latest strict show');
  const latest = await readFile(playlistPath, 'utf8');
  assert.ok(!latest.includes('subsonic_id="first"') && !latest.includes('subsonic_id="second"'), 'resume replayed an old show');
  await sleep(1500);
  const resumedTrack = JSON.parse(await readFile(join(stateDir, 'now-playing.json'), 'utf8'));
  assert.equal(resumedTrack.subsonic_id, pausedTrack.subsonic_id, 'resume failed to preserve frozen track');
  const successesAfter = queue.djLog.filter((e: { message: string }) => e.message.startsWith('Auto-playlist refreshed:')).length;
  requireEqual(successesAfter - successesBefore, 1, 'resume must publish exactly one pending build');
  count = streams.length;
  await control.skipTrack();
  await until(async () => (await readFile(join(stateDir, 'now-playing.json'), 'utf8')).includes('\"subsonic_id\":\"latest\"'), 'latest strict fallback never reached playback', 45_000);
  const resume = { label: 'resume', streams: streams.length - resumeBefore.streams, metadata: metadata.length - resumeBefore.metadata,
    successLogs: successesAfter - successesBefore, preservedTrack: resumedTrack.subsonic_id, reloads: reloads() - resumeBefore.reloads, rms, latestPlayed: true, catalogueHeldDuringPlayback, streamsAfterSkip: streams.length - count };
  observations.push(resume); console.log(JSON.stringify(resume));
  assert.deepEqual(violations, [], 'real idle refresh regression');
} finally {
  await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify({ controllerRoot, observations, streams, metadata, violations }, null, 2));
  console.log(`Evidence: ${evidenceDir}`);
  try { execFileSync('sudo', ['-n', 'kill', '-TERM', `-${mixer.pid}`]); } catch { /* already exited */ }
  releaseLatest();
  origin.close();
  mixer.stdout.unpipe(output); mixer.stderr.unpipe(output);
  output.end();
  // Existing production monitor/cron timers intentionally run forever. This
  // standalone opt-in harness owns the process; preserve assertion failure.
  process.exitCode = violations.length ? 1 : process.exitCode;
  setTimeout(() => process.exit(process.exitCode || 0), 1000);
}
