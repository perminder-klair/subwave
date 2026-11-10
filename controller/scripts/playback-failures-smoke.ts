// Optional real-audio smoke: not part of npm test. Requires Liquidsoap >=2.4.5,
// Icecast and ffmpeg. Everything runs in a fresh directory on loopback.
// Run as a non-root user, as required by Icecast.
// LIQUIDSOAP_BIN=/path/to/liquidsoap LIQUIDSOAP_STDLIB=/path/to/stdlib.liq
//   npx tsx scripts/playback-failures-smoke.ts
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = await mkdtemp(join(tmpdir(), 'subwave-fetch-smoke-'));
const children: ChildProcess[] = [];
const logWrites: Promise<void>[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, label: string, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}
async function start(command: string, args: string[], logName: string, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout!.on('data', data => { log += data; });
  child.stderr!.on('data', data => { log += data; });
  child.on('close', () => { logWrites.push(writeFile(join(state, logName), log)); });
  child.on('error', err => { log += String(err); });
  return child;
}

const origin = createServer();
const api = createServer();
try {
  await mkdir(join(state, 'logs'));
  const fallback = join(state, 'fallback.mp3');
  const audio = join(state, 'valid.mp3');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ac', '2', '-y', fallback]);
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-ac', '2', '-y', audio]);
  const validAudio = await readFile(audio);
  const streamRequests: string[] = [];
  origin.on('request', (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.includes('/stream')) {
      const id = url.searchParams.get('id') || '';
      streamRequests.push(id);
      if (id === 'valid') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(validAudio); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'File not found' } } })); }
    } else if (url.pathname.startsWith('/api/')) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Smoke model unavailable; use the empty local pool' }));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', song: { id: url.searchParams.get('id') }, randomSongs: { song: [] }, albumList2: { album: [] } } }));
    }
  });
  await new Promise<void>(r => origin.listen(0, '127.0.0.1', r));
  const originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  const telnetPort = await freePort();
  const icecastPort = await freePort();
  Object.assign(process.env, {
    STATE_DIR: state, SUBWAVE_STATE_DIR: state, ADMIN_USER: 'smoke', ADMIN_PASS: 'smoke-password',
    NAVIDROME_URL: originUrl, NAVIDROME_USER: 'smoke', NAVIDROME_PASS: 'do-not-export',
    LIQUIDSOAP_HOST: '127.0.0.1', LIQUIDSOAP_PORT: String(telnetPort),
    ICECAST_HOST: '127.0.0.1', ICECAST_SOURCE_PASSWORD: 'smoke-source',
  });
  await writeFile(join(state, 'auto.m3u'), `${fallback}\n`);
  await writeFile(join(state, 'jingles.m3u'), '');
  await writeFile(join(state, 'liquidsoap_jingle_ratio.txt'), '0');
  await writeFile(join(state, 'liquidsoap_crossfade.txt'), '2');
  const icecastConfig = `<icecast><location>Smoke</location><admin>smoke@localhost</admin><hostname>localhost</hostname>
    <limits><clients>10</clients><sources>2</sources><queue-size>2097152</queue-size><burst-size>0</burst-size><source-timeout>10</source-timeout></limits>
    <authentication><source-password>smoke-source</source-password><relay-password>smoke</relay-password><admin-user>smoke</admin-user><admin-password>smoke</admin-password></authentication>
    <listen-socket><port>${icecastPort}</port><bind-address>127.0.0.1</bind-address></listen-socket>
    <paths><basedir>/usr/share/icecast2</basedir><logdir>${state}/logs</logdir><webroot>/usr/share/icecast2/web</webroot><adminroot>/usr/share/icecast2/admin</adminroot><pidfile>${state}/icecast.pid</pidfile></paths>
    <logging><accesslog>icecast-access.log</accesslog><errorlog>icecast-error.log</errorlog><loglevel>3</loglevel></logging></icecast>`;
  await writeFile(join(state, 'icecast.xml'), icecastConfig);
  await start('icecast2', ['-c', join(state, 'icecast.xml')], 'icecast-process.log');
  const script = (await readFile(join(root, 'liquidsoap/radio.liq'), 'utf8'))
    .replace('"/var/log/liquidsoap/radio.log"', `"${state}/logs/radio.log"`)
    .replaceAll('/sounds/', `${root}/sounds/`)
    .replace('settings.server.telnet.bind_addr := "0.0.0.0"', 'settings.server.telnet.bind_addr := "127.0.0.1"')
    .replace('settings.server.telnet.port := 1234', `settings.server.telnet.port := ${telnetPort}`)
    .replaceAll('port=7702', `port=${icecastPort}`);
  await writeFile(join(state, 'radio.liq'), script);
  const stdlib = process.env.LIQUIDSOAP_STDLIB ? ['--stdlib', process.env.LIQUIDSOAP_STDLIB] : [];
  const binary = process.env.LIQUIDSOAP_BIN || 'liquidsoap';
  const version = run(binary, ['--version']);
  const release = /Liquidsoap (\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(release && (Number(release[1]) > 2 || (Number(release[1]) === 2
    && (Number(release[2]) > 4 || (Number(release[2]) === 4 && Number(release[3]) >= 5)))),
  'use the repository-supported Liquidsoap version');
  run(binary, [...stdlib, '--check', join(state, 'radio.liq')]);
  const liquidsoap = await start(binary, [...stdlib, join(state, 'radio.liq')], 'liquidsoap-process.log');
  const { queue } = await import('../src/broadcast/queue.js');
  const { router } = await import('../src/routes/debug.js');
  const control = await import('../src/broadcast/liquidsoap-control.js');
  const settings = await import('../src/settings.js');
  await settings.load();
  await settings.update({ transitions: { pairDrain: false }, tts: { enabled: false }, crossfadeDuration: 2 });
  queue.autoPick = false;
  const app = express(); app.use(router);
  api.on('request', app);
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const headers = { Authorization: `Basic ${Buffer.from('smoke:smoke-password').toString('base64')}` };
  const history = async () => {
    const response = await fetch(`${base}/debug/playback-failures`, { headers });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ failures: Array<{ sourceTrackId: string; attemptId: string }>; warnings: string[] }>;
  };
  await until(async () => {
    try { return (await control.sendCommand('help')).includes('subhttp_probe_status'); } catch { return false; }
  }, 'real Liquidsoap telnet ready');
  const stream = `http://127.0.0.1:${icecastPort}/stream.mp3`;
  async function capture(label: string, expectedHz = 440) {
    assert.equal(liquidsoap.exitCode, null, 'mixer must remain running');
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', stream, '-t', '3', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { timeout: 25000 });
    assert.equal(raw.status, 0, raw.stderr.toString());
    const samples = new Float32Array(raw.stdout.buffer.slice(raw.stdout.byteOffset, raw.stdout.byteOffset + raw.stdout.byteLength));
    const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    assert.ok(rms > 0.01, `${label}: decoded broadcast audio must not be silent (RMS ${rms})`);
    const power = (hz: number) => {
      let total = 0;
      for (let offset = 0; offset + 800 <= samples.length; offset += 800) {
        let real = 0; let imaginary = 0;
        for (let i = 0; i < 800; i++) {
          real += samples[offset + i] * Math.cos(2 * Math.PI * hz * i / 8000);
          imaginary += samples[offset + i] * Math.sin(2 * Math.PI * hz * i / 8000);
        }
        total += real * real + imaginary * imaginary;
      }
      return total;
    };
    const tonePowers = { fallback440: power(440), queued880: power(880) };
    assert.ok(expectedHz === 440 ? tonePowers.fallback440 > tonePowers.queued880 : tonePowers.queued880 > tonePowers.fallback440,
      `${label}: output must contain the expected ${expectedHz} Hz source, not just arbitrary non-silent audio`);
    return { label, samples: samples.length, rms, tonePowers };
  }
  const captures = [await capture('before failure: auto playlist')];
  const track = (id: string) => ({ id, title: `Smoke ${id}`, artist: 'Smoke artist', album: 'Smoke album', duration: 8 });
  await queue.push({ track: track('json-error'), operator: true, requestedBy: 'studio' });
  await until(async () => (await history()).failures.length === 1 && queue.upcoming.length === 0, 'JSON HTTP 200 rejected, removed and persisted');
  let failed = await history();
  assert.equal(failed.failures[0].sourceTrackId, 'json-error');
  captures.push(await capture('after JSON failure: fallback continues'));
  await queue.push({ track: track('valid'), operator: true, requestedBy: 'studio' });
  await until(async () => queue.upcoming.some(item => item.track.id === 'valid' && item.confirmedInLiquidsoap === true), 'real audio ready outcome reaches controller');
  assert.equal((await history()).failures.length, 1, 'valid audio must not create a failure');
  await until(async () => {
    try { return JSON.parse(await readFile(join(state, 'now-playing.json'), 'utf8')).subsonic_id === 'valid'; } catch { return false; }
  }, 'valid queued audio actually airs');
  captures.push(await capture('valid queued song', 880));
  await sleep(10000);
  captures.push(await capture('after valid song: fallback continues'));
  assert.equal((await history()).failures.length, 1);
  assert.ok(streamRequests.includes('valid') && streamRequests.includes('json-error'));
  const { config } = await import('../src/config.js');
  config.navidrome.url = `http://127.0.0.1:${await freePort()}`;
  queue.upcoming = [];
  await queue.push({ track: track('unreachable'), operator: true, requestedBy: 'studio' });
  await until(async () => (await history()).failures.length === 2 && queue.upcoming.length === 0, 'unreachable origin rejected, removed and persisted');
  config.navidrome.url = originUrl;
  failed = await history();
  assert.deepEqual(failed.failures.map(row => row.sourceTrackId).sort(), ['json-error', 'unreachable']);
  captures.push(await capture('unreachable origin: fallback continues'));
  const exportResponse = await fetch(`${base}/debug/playback-failures/export`, { headers });
  assert.equal(exportResponse.status, 200);
  assert.deepEqual((await exportResponse.text()).trim().split('\n').map(row => JSON.parse(row)), failed.failures);
  // Exercise asynchronous disk failure with the real probe and removal path.
  // Re-picking is enabled; the fake music origin has no new candidates.
  queue.upcoming = [];
  await rename(join(state, 'logs'), join(state, 'saved-logs'));
  await writeFile(join(state, 'logs'), 'not a writable event directory');
  queue.autoPick = true;
  config.ollama.url = originUrl;
  queue.pickerBusy = false;
  await queue.push({ track: track('disk-error'), operator: true, requestedBy: 'studio' });
  await until(async () => queue.upcoming.length === 0, 'failed event append must not interrupt removal');
  assert.equal(queue.pickerBusy, true, 'failed persistence must still start immediate recovery');
  assert.ok(queue.djLog.some(row => row.message.includes('Smoke disk-error') && row.kind === 'error'));
  captures.push(await capture('failed persistence: fallback continues'));
  queue.autoPick = false;
  await until(async () => !queue.pickerBusy, 'recovery completes despite event persistence failure', 90000);
  await rm(join(state, 'logs'));
  await rename(join(state, 'saved-logs'), join(state, 'logs'));
  const restartRead = run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import {readPlaybackFailures} from './src/observability/playback-failures.ts'; console.log(JSON.stringify(await readPlaybackFailures({stationDir:process.env.STATE_DIR})));`]);
  assert.deepEqual(JSON.parse(restartRead).failures, failed.failures);
  console.log(JSON.stringify({ state, version: version.trim(), streamRequests, failures: failed.failures, captures, restartRead: 'passed', result: 'PASS' }, null, 2));
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(r => { child.once('close', () => r()); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref(); });
    }
  }
  origin.closeAllConnections(); api.closeAllConnections();
  await Promise.all([new Promise<void>(r => origin.close(() => r())), new Promise<void>(r => api.close(() => r()))]);
  await Promise.all(logWrites);
  if (process.env.KEEP_SMOKE_STATE !== '1') await rm(state, { recursive: true, force: true });
}
