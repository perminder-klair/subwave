// GET /archives/file/:date/:hour, over real HTTP against a temp state dir.
//
// Three properties:
//  - a read failure answers the request instead of escaping as an unhandled
//    stream 'error' (which takes the whole controller down);
//  - the body never runs past the Content-Length it announced, because the
//    current hour is still being appended to while it downloads;
//  - an hour that vanished between lookup and stat is a 404, not a throw.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router
// mounts bare.
//
// Run: `npm test -- archive-download`.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-archive-download-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const day = path.join(stateRoot, 'archive', '2026-10-01');
mkdirSync(day, { recursive: true });

const express = (await import('express')).default;
const { router } = await import('../src/routes/archives.js');

const app = express();
app.use(router);
const server = createServer(app);
await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// A route that never answers must fail its test, not wedge the suite.
const get = (hour: string, signal: AbortSignal = AbortSignal.timeout(5000)) =>
  fetch(`${base}/archives/file/2026-10-01/${hour}`, { signal });

test('a finished hour downloads byte for byte', async () => {
  const bytes = Buffer.from('ID3 a finished hour of audio');
  writeFileSync(path.join(day, '10-00.mp3'), bytes);
  const res = await get('10-00.mp3');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  assert.match(res.headers.get('content-disposition') ?? '', /2026-10-01_10-00\.mp3/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
});

test('the body is pinned to the size announced at stat time', async () => {
  // A large file so the read is still in flight when the append lands.
  const file = path.join(day, '11-00.mp3');
  const head = Buffer.alloc(4 * 1024 * 1024, 7);
  writeFileSync(file, head);
  const res = await get('11-00.mp3');
  appendFileSync(file, Buffer.alloc(256 * 1024, 9));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(head.length));
  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(got.length, head.length);
});

test('an unreadable hour answers 500 and the server keeps serving', { skip: process.getuid?.() === 0 }, async () => {
  const file = path.join(day, '12-00.mp3');
  writeFileSync(file, 'locked');
  chmodSync(file, 0o000);
  try {
    const res = await get('12-00.mp3');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'archive read failed' });
  } finally {
    chmodSync(file, 0o644);
  }
  const again = await get('10-00.mp3');
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});

test('a directory where an hour should be is a 404', async () => {
  mkdirSync(path.join(day, '13-00.mp3'));
  const res = await get('13-00.mp3');
  assert.equal(res.status, 404);
});

test('an aborted download does not take the server down', async () => {
  writeFileSync(path.join(day, '14-00.mp3'), Buffer.alloc(8 * 1024 * 1024, 1));
  const ac = new AbortController();
  const res = await get('14-00.mp3', ac.signal);
  assert.equal(res.status, 200);
  ac.abort();
  await res.arrayBuffer().catch(() => {});
  const again = await get('10-00.mp3');
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});
