import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const controller = fileURLToPath(new URL('../', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Hold a real settings read, rather than racing a sleep against a fast machine.
// Only the test preload changes I/O: the production server has no test switches.
test('HTTP readiness waits for startup recovery, then a new reconciliation survives', { timeout: 45_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'subwave-startup-'));
  const preload = join(state, 'hold-startup.mjs');
  writeFileSync(join(state, 'settings.json'), JSON.stringify({
    tts: { enabled: false }, embedding: { enabled: false },
    llm: { ollamaUrl: 'http://127.0.0.1:1', pickerAgent: false },
  }));
  writeFileSync(preload, `
import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
let port;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  this.once('listening', () => { port = this.address().port; });
  return listen.apply(this, args);
};
const read = fs.promises.readFile;
let held = false;
fs.promises.readFile = async function(path, ...args) {
  if (!held && String(path) === process.env.STATE_DIR + '/settings.json') {
    held = true;
    await new Promise(resolve => {
      process.once('message', resolve);
      process.send({ type: 'startup-held', port });
    });
  }
  return read.call(this, path, ...args);
};
// The managed worker uses /app in Docker; map that cwd for checkout tests.
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (command === 'npx' && options?.cwd === '/app') {
    return spawn(process.execPath, ['--import', 'tsx', ...args.slice(1)],
      { ...options, cwd: ${JSON.stringify(controller)} });
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('external network disabled in startup test'));
  return fetch(input, init);
};
`);
  const mock = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      'subsonic-response': { status: 'ok', albumList2: { album: [] }, playlists: { playlist: [] } },
      icestats: { source: [] },
    }));
  });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockAddress = mock.address();
  assert.ok(mockAddress && typeof mockAddress === 'object');
  const mockUrl = `http://127.0.0.1:${mockAddress.port}`;
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const orphanExit = once(orphan, 'exit');
  writeFileSync(join(state, 'tagger.pid'), JSON.stringify({
    pid: orphan.pid, mode: 'reconcile', startedAt: '2026-09-01T00:00:00Z', args: [],
  }));
  const child = fork(join(controller, 'src/server.ts'), [], {
    cwd: controller,
    execArgv: ['--import', 'tsx', '--import', pathToFileURL(preload).href],
    env: { ...process.env, STATE_DIR: state, PORT: '0', NODE_ENV: 'production',
      ADMIN_USER: 'test', ADMIN_PASS: 'test', NAVIDROME_URL: mockUrl,
      NAVIDROME_USER: 'test', NAVIDROME_PASS: 'test', ICECAST_STATUS_URL: mockUrl,
      LIQUIDSOAP_HOST: '127.0.0.1', LIQUIDSOAP_PORT: '1', ANALYZE_URL: mockUrl },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });
  const childExit = once(child, 'exit');
  try {
    const [held] = await once(child, 'message');
    assert.equal(held.type, 'startup-held');
    assert.ok(held.port > 0);
    const url = `http://127.0.0.1:${held.port}`;
    const auth = { Authorization: `Basic ${Buffer.from('test:test').toString('base64')}`, 'Content-Type': 'application/json' };
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 503, 'health must not advertise readiness while startup recovery is pending');
    assert.equal(health.headers.get('retry-after'), '1');
    assert.equal((await health.json()).status, 'starting');
    for (const path of ['/library/reconcile', '/tag-library', '/library/analyze', '/settings']) {
      const r = await fetch(url + path, { method: 'POST', headers: auth, body: '{}' });
      assert.equal(r.status, 503, `${path} must not run during initialization`);
    }
    assert.equal((await fetch(`${url}/state`)).status, 503, 'do not expose default state before loading persisted privacy');
    assert.equal((await fetch(`${url}/health`, { method: 'OPTIONS' })).status, 200, 'CORS preflight remains available');
    assert.equal(JSON.parse(readFileSync(join(state, 'tagger.pid'), 'utf8')).pid, orphan.pid,
      'early starts must not replace the old worker recovery record');
    child.send('release');
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if ((await fetch(`${url}/health`)).status === 200) { ready = true; break; }
      await pause(50);
    }
    assert.ok(ready, logs);
    await orphanExit;
    assert.equal(orphan.signalCode, 'SIGTERM', 'startup must still reap the actual orphan');
    const denied = await fetch(`${url}/library/reconcile`, { method: 'POST' });
    assert.equal(denied.status, 401, 'normal admin authentication still applies after readiness');
    const response = await fetch(`${url}/library/reconcile`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(response.status, 200, logs);
    const start = await response.json();
    let outcome: string | undefined;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${url}/library/tagger`, { headers: auth });
      const { tagger } = await r.json();
      if (!tagger.running && tagger.startedAt === start.tagger.startedAt) {
        outcome = tagger.lastRun?.outcome;
        break;
      }
      await pause(50);
    }
    assert.equal(outcome, 'ok', `the new managed reconciliation must finish, not be killed as an orphan\n${logs}`);
  } finally {
    child.kill('SIGTERM');
    await childExit;
    orphan.kill('SIGTERM');
    await orphanExit;
    mock.closeAllConnections();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(state, { recursive: true, force: true });
  }
});
