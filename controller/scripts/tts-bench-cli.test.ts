// Runs the whole of tts-bench (scripts/tts-bench/cli.ts) against a fake Remote
// server and a fake tts-heavy sidecar, both real HTTP on loopback, so every
// render goes through the live tts.speak() and the engines' own clients. It
// pins what scripts/tts-bench-measure.test.ts cannot reach:
//
// - a named voice resolves against the station's own voice folder, and one
//   that is not there marks the engine unavailable instead of scoring the
//   default voice under its name;
// - a reference WAV reaches the sidecar as the station's real path;
// - a voice the engine did not honour (Remote's X-TTS-Fell-Back, the sidecar's
//   fell_back) counts as a fallback, from the lines the real clients log;
// - the cold render is the first one that succeeds, not the first attempt;
// - the engine speed env vars and PIPER_OUT are dropped and reported;
// - the sidecar renders into a run-owned dir under the station's voice/,
//   which is removed on exit (and a killed run's swept), and nothing else in
//   the station's state root changes.
//
// Run: `npm test -- tts-bench-cli`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BenchRecord, EngineSummary } from './tts-bench/measure.js';
import { createTempDir } from './test-utils/temp-dir.js';

const controller = fileURLToPath(new URL('../', import.meta.url));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// 0.2 s of silence, 1 s of a 440 Hz tone at half scale, 0.3 s of silence:
// 24 kHz mono s16, the shape every fake engine returns.
function fixtureWav(): Buffer {
  const rate = 24_000;
  const samples = Math.round(1.5 * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const v = t >= 0.2 && t < 1.2 ? 0.5 * Math.sin(2 * Math.PI * 440 * t) : 0;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const WAV = fixtureWav();

async function body<T>(req: IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}') as T;
}

type SidecarRequest = { engine: string; voice: string; reference_wav: string; out: string };

// Both servers stay bound for the whole file (run-tests.ts: never close a
// reserved port and bind the number again).
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Every entry under `root`, with each file's content hash.
function snapshot(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      Object.assign(out, snapshot(root, rel));
    } else {
      out[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
    }
  }
  return out;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid!;
}

test('tts-bench against a fake Remote and sidecar: voices, substitutions, cold, env and the sidecar dir', { timeout: 150_000 }, async () => {
  const remoteRequests: Array<{ voice: string }> = [];
  let flakyCalls = 0;
  const remoteUrl = await serve(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    const { voice } = await body<{ voice: string }>(req);
    remoteRequests.push({ voice });
    if (voice === 'flaky' && ++flakyCalls === 1) {
      res.writeHead(503).end('loading');
      return;
    }
    const headers: Record<string, string> = { 'content-type': 'audio/wav' };
    if (voice === 'subst') {
      Object.assign(headers, { 'x-tts-fell-back': '1', 'x-tts-voice-used': 'default', 'x-tts-fell-back-reason': 'unknown voice' });
    }
    res.writeHead(200, headers).end(WAV);
  });

  const sidecarRequests: SidecarRequest[] = [];
  const sidecarUrl = await serve(async (req, res) => {
    const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'GET' && req.url === '/health') {
      json(200, { ok: true, engines: ['chatterbox', 'pocket-tts'] });
      return;
    }
    const request = await body<SidecarRequest>(req);
    sidecarRequests.push(request);
    // The real sidecar writes where it is told; a temp path it cannot reach
    // would fail here as it fails there.
    writeFileSync(request.out, WAV);
    json(200, request.voice === 'alba'
      ? { ok: true, path: request.out, fell_back: true, fell_back_reason: 'no such voice', voice_used: 'default' }
      : { ok: true, path: request.out });
  });

  // The station: a Piper voice and a reference WAV in voices/, and its render
  // dir voice/ holding a dir a killed run left behind.
  const root = createTempDir(join(tmpdir(), 'subwave-tts-bench-source-'));
  mkdirSync(join(root, 'voices'));
  writeFileSync(join(root, 'voices', 'present.onnx'), 'not a model');
  writeFileSync(join(root, 'voices', 'present.onnx.json'), '{}');
  writeFileSync(join(root, 'voices', 'present.wav'), WAV);
  const abandoned = join('voice', `tts-bench-${await deadPid()}-AbC123`);
  mkdirSync(join(root, abandoned), { recursive: true });
  const before = snapshot(root);
  const tmp = createTempDir(join(tmpdir(), 'subwave-tts-bench-tmp-'));
  const out = join(tmp, 'run');

  const env: NodeJS.ProcessEnv = {
    ...process.env, STATE_DIR: root, TMPDIR: tmp, TTS_HEAVY_URL: sidecarUrl,
    TTS_SPEED: '0.5', PIPER_OUT: join(root, 'voice'),
  };
  for (const name of ['TTS_VOICE_DIR', 'CHATTERBOX_VOICE_DIR', 'PIPER_SPEED', 'KOKORO_SPEED', 'CLOUD_TTS_SPEED']) delete env[name];
  const engines = [
    'remote:flaky', 'remote:subst', 'chatterbox', 'chatterbox:present.wav', 'chatterbox:absent.wav',
    'pocket-tts:alba', 'piper:present.onnx', 'piper:absent.onnx',
  ];
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'scripts/tts-bench/cli.ts', '--engines', engines.join(','), '--remote-url', remoteUrl,
    '--lines', 'ident-short', '--iterations', '2', '--wait', '20', '--out', out,
  ], { cwd: controller, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d; });
  child.stderr.on('data', (d: Buffer) => { output += d; });
  const kill = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const [code] = await once(child, 'exit');
  clearTimeout(kill);
  assert.equal(code, 0, output);

  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const records: BenchRecord[] = report.records;
  const of = (engine: string) => records.filter((r) => r.engine === engine);
  const summary = (engine: string) => (report.summary as EngineSummary[]).find((s) => s.engine === engine)!;

  // Env: the speed and the render dir the station would have used are gone.
  assert.deepEqual(report.meta.neutralizedEnv, { TTS_SPEED: '0.5', PIPER_OUT: join(root, 'voice') }, output);
  assert.equal(report.meta.voiceDir, join(root, 'voices'));

  // A voice that is not in the folder never runs; one that is does.
  for (const missing of ['piper:absent.onnx', 'chatterbox:absent.wav']) {
    const [rec, ...rest] = of(missing);
    assert.equal(rest.length, 0, missing);
    assert.equal(rec.outcome, 'unavailable', missing);
    assert.match(rec.error!, /is not in .*voices/, missing);
  }
  assert.ok(of('piper:present.onnx').length > 0 && of('piper:present.onnx').every((r) => r.outcome !== 'unavailable'), output);
  const present = sidecarRequests.filter((r) => r.engine === 'chatterbox' && r.reference_wav);
  assert.equal(present.length, 2);
  for (const r of present) assert.equal(r.reference_wav, join(root, 'voices', 'present.wav'), 'the station\'s real path');
  assert.ok(of('chatterbox:present.wav').every((r) => r.outcome === 'ok'), output);

  // A voice the engine did not honour is a fallback, not an ok.
  for (const engine of ['remote:subst', 'pocket-tts:alba']) {
    const recs = of(engine);
    assert.equal(recs.length, 2, engine);
    for (const r of recs) {
      assert.equal(r.outcome, 'fell-back', engine);
      assert.match(r.voiceUsed!, /^default \((unknown voice|no such voice)\)$/, engine);
      assert.equal(r.engineUsed, undefined, `${engine}: the engine itself spoke`);
    }
    assert.equal(summary(engine).ok, 0);
    assert.equal(summary(engine).failed, 2);
  }

  // Cold is the first render that succeeds.
  const [flaky1, flaky2] = of('remote:flaky');
  assert.notEqual(flaky1.outcome, 'ok');
  assert.equal(flaky1.cold, true);
  assert.equal(flaky2.outcome, 'ok', output);
  assert.equal(flaky2.cold, true, 'the render after a failed first one carries the load');
  assert.equal(summary('remote:flaky').coldMs, flaky2.ms);
  assert.equal(summary('remote:flaky').warmP50Ms, null);
  const [cb1, cb2] = of('chatterbox');
  assert.deepEqual([cb1.outcome, cb1.cold, cb2.outcome, cb2.cold], ['ok', true, 'ok', false]);
  assert.equal(summary('chatterbox').coldMs, cb1.ms);
  assert.equal(summary('chatterbox').warmP50Ms, cb2.ms);

  // Every clip that rendered is in the report dir.
  for (const r of records.filter((x) => x.clip)) assert.ok(existsSync(join(out, r.clip!)), r.clip);

  // The sidecar wrote only into the run's own dir under voice/, which is gone,
  // as is the killed run's; nothing else in the state root changed.
  assert.ok(sidecarRequests.length >= 6);
  for (const r of sidecarRequests) {
    assert.match(r.out, new RegExp(`^${join(root, 'voice', `tts-bench-${child.pid}-`)}[A-Za-z0-9]{6}/`), r.out);
  }
  const expected = Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith(`${abandoned}/`)));
  assert.deepEqual(snapshot(root), expected);
  assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith('subwave-tts-bench-')), [], 'the isolated dir is removed');

  // The measurements, on clips whose shape is known.
  if (hasFfmpeg) {
    for (const r of [flaky2, cb1, cb2]) {
      assert.equal(r.audioSec, 1.5, JSON.stringify(r));
      assert.ok(Math.abs(r.leadMs! - 200) <= 25, `lead ${r.leadMs}`);
      assert.ok(Math.abs(r.trailMs! - 300) <= 25, `tail ${r.trailMs}`);
      assert.ok(Math.abs(r.truePeakDb! - -6) <= 0.5, `peak ${r.truePeakDb}`);
      assert.equal(typeof r.lufs, 'number');
      assert.deepEqual(r.flags, []);
    }
  }
  assert.ok(statSync(join(out, 'report.json')).size > 0);
});
