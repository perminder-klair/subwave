import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import express from 'express';

const state = mkdtempSync(join(tmpdir(), 'subwave-1779-traffic-'));
process.env.STATE_DIR = state;
process.env.NAVIDROME_USER = 'traffic-fixture';
process.env.NAVIDROME_PASS = 'traffic-fixture-secret';
let requests = 0;
let mode: 'ok' | 'lost-first' | 'http-error' | 'audio' = 'ok';
const server = createServer((_req, res) => {
  requests++;
  if (mode === 'lost-first' && requests === 1) return res.socket?.destroy();
  if (mode === 'audio') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(Buffer.alloc(8192, 1));
  }
  res.writeHead(mode === 'http-error' ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', albumList2: { album: [] } } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.NAVIDROME_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const subsonic = await import('../src/music/subsonic.js');
const traffic = await import('../src/music/subsonic-log.js');
const { withTrace } = await import('../src/observability/events.js');
const analyzer = await import('../src/music/analyzer.js');
const { router } = await import('../src/routes/public.js');
const app = express();
app.use(router);
const proxy = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => proxy.once('listening', resolve));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

test.beforeEach(() => {
  requests = 0;
  mode = 'ok';
  traffic.reset();
});
test.after(async () => {
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(state, { recursive: true, force: true });
});

test('analysis prefetch and cover misses are measured, while cached covers make no request', async () => {
  mode = 'audio';
  const audio = await analyzer.downloadCapped('traffic-song');
  assert.equal(audio.complete, true);
  assert.equal(readFileSync(audio.path).length, 8192);
  const first = await fetch(`${proxyUrl}/cover/traffic-song`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const cached = await fetch(`${proxyUrl}/cover/traffic-song`);
  assert.equal(cached.status, 200);
  await cached.arrayBuffer();
  assert.equal(requests, 2);
  assert.deepEqual(traffic.snapshot().httpAttempts.producers, [
    { endpoint: 'stream', purpose: 'analysis-download', traceKind: null, attempts: 1 },
    { endpoint: 'getCoverArt', purpose: 'cover', traceKind: null, attempts: 1 },
  ]);
  assert.equal(traffic.snapshot().endpoints.length, 0, 'binary fetches remain separate from API calls');
});

test('a retried catalogue read counts both HTTP attempts and one logical call', async () => {
  mode = 'lost-first';
  await withTrace({ kind: 'auto-playlist' }, () => subsonic.getAlbumList());
  assert.equal(requests, 2);
  const snapshot = traffic.snapshot();
  assert.equal(snapshot.endpoints[0].calls, 1);
  assert.equal(snapshot.httpAttempts.total, requests);
  assert.deepEqual(snapshot.httpAttempts.producers, [
    { endpoint: 'getAlbumList2', purpose: 'api', traceKind: 'auto-playlist', attempts: 2 },
  ]);
  assert.equal(snapshot.httpAttempts.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(snapshot.httpAttempts.since)));
});

test('failed connection tests are measured even though they bypass the API call log', async () => {
  mode = 'http-error';
  const result = await subsonic.pingWith({
    url: process.env.NAVIDROME_URL!, user: 'probe-user', pass: 'probe-secret',
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 2);
  const snapshot = traffic.snapshot();
  assert.equal(snapshot.endpoints.length, 0);
  assert.equal(snapshot.httpAttempts.total, requests);
  assert.deepEqual(snapshot.httpAttempts.producers, [
    { endpoint: 'ping', purpose: 'connection-test', traceKind: null, attempts: 2 },
  ]);
});

test('HTTP errors are counted without introducing a retry', async () => {
  mode = 'http-error';
  await assert.rejects(subsonic.getAlbumList(), /503/);
  assert.equal(requests, 1);
  assert.equal(traffic.snapshot().httpAttempts.total, 1);
  assert.equal(traffic.snapshot().endpoints[0].errors, 1);
});

test('concurrent traces keep their request producers and a snapshot is a pure read', async () => {
  await Promise.all([
    withTrace({ kind: 'pick' }, () => subsonic.getAlbumList()),
    withTrace({ kind: 'auto-playlist' }, () => subsonic.getAlbumList()),
  ]);
  const first = traffic.snapshot().httpAttempts;
  for (let i = 0; i < 20; i++) assert.deepEqual(traffic.snapshot().httpAttempts, first);
  assert.equal(requests, 2);
  assert.deepEqual(first.producers.map(p => [p.traceKind, p.attempts]).sort(),
    [['auto-playlist', 1], ['pick', 1]]);
  traffic.reset();
  assert.equal(traffic.snapshot().httpAttempts.total, 0);
  assert.deepEqual(traffic.snapshot().httpAttempts.producers, []);
});

test('durable attempt events carry attribution without URLs or credentials', async () => {
  const { currentTrace } = await import('../src/observability/events.js');
  let traceId: string | undefined;
  await withTrace({ kind: 'auto-playlist' }, async () => {
    traceId = currentTrace()?.traceId;
    await subsonic.getAlbumList();
  });
  const logs = join(state, 'logs');
  // Event appends are best-effort and asynchronous; wait for this attempt only.
  let events: any[] = [];
  for (let i = 0; i < 100; i++) {
    events = readdirSync(logs).filter(n => n.startsWith('events-')).flatMap(n =>
      readFileSync(join(logs, n), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    if (events.some(e => e.type === 'navidrome.http-attempt' && e.traceId === traceId)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const event = events.find(e => e.type === 'navidrome.http-attempt' && e.traceId === traceId);
  assert.ok(event);
  assert.equal(event.pid, process.pid);
  assert.equal(event.endpoint, 'getAlbumList2');
  assert.equal(event.purpose, 'api');
  assert.ok(event.traceId);
  assert.equal(event.process, 'navidrome-traffic.test.ts');
  const serialized = JSON.stringify(event);
  for (const privateText of ['traffic-fixture', 'traffic-fixture-secret', process.env.NAVIDROME_URL!, 'probe-secret']) {
    assert.ok(!serialized.includes(privateText));
  }
  assert.equal(event.params, undefined);
});

test('a separate maintenance process is visible in durable events but not controller counters', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "const s = await import('./src/music/subsonic.ts'); await s.getAlbumList(); console.log(process.pid);",
  ], { env: { ...process.env, STATE_DIR: state } });
  const childPid = Number(stdout.trim());
  assert.equal(requests, 1);
  assert.equal(traffic.snapshot().httpAttempts.total, 0);
  const events = readdirSync(join(state, 'logs')).filter(n => n.startsWith('events-')).flatMap(n =>
    readFileSync(join(state, 'logs', n), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const event = events.find(e => e.type === 'navidrome.http-attempt' && e.pid === childPid);
  assert.ok(event);
  assert.equal(event.endpoint, 'getAlbumList2');
  assert.notEqual(event.pid, process.pid);
});
