// music/file-changes.ts against a fake Navidrome: the native song list sorted
// by updated_at, newest first, stopped at the floor (the previous walk's mark
// less the margin, or on a first walk the library's oldest measurement), a
// failed deep page kept as a partial answer that does not move the mark, and
// a server that names itself as something else never asked.
//
// Run: npm test -- file-changes

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-28T16:00:00Z');
// 2,500 songs, one hour apart, newest first.
let SONGS = Array.from({ length: 2_500 }, (_, i) => ({ id: `s${i}`, updatedAt: new Date(T0 - i * HOUR).toISOString() }));
const BASE_SONGS = SONGS;
let serverType = 'navidrome';
let failFromStart: number | null = null;
const listCalls: number[] = [];

function handler(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? '/', 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/rest/ping' || u.pathname === '/rest/ping.view') {
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: serverType, serverVersion: '0.58', openSubsonic: true } }));
    return;
  }
  if (u.pathname === '/auth/login') { res.end(JSON.stringify({ token: 'tok' })); return; }
  if (u.pathname === '/api/song') {
    assert.equal(req.headers['x-nd-authorization'], 'Bearer tok');
    assert.equal(u.searchParams.get('_sort'), 'updated_at');
    assert.equal(u.searchParams.get('_order'), 'DESC');
    const start = Number(u.searchParams.get('_start'));
    listCalls.push(start);
    if (failFromStart != null && start >= failFromStart) {
      res.statusCode = 500;
      res.end('{"error":"ambiguous column name: updated_at"}');
      return;
    }
    res.end(JSON.stringify(SONGS.slice(start, Number(u.searchParams.get('_end')))));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const dir = createTempDir(join(tmpdir(), 'subwave-file-changes-'));
process.env.STATE_DIR = dir;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';

const fc = await import('../src/music/file-changes.js');
const { CHANGE_MARK_MARGIN_MS } = await import('../src/music/replaced-file-policy.js');
const markFile = join(dir, 'navidrome-file-changes.json');

after(async () => { server.close(); await removeTempDir(dir); });
beforeEach(async () => {
  serverType = 'navidrome';
  failFromStart = null;
  listCalls.length = 0;
  SONGS = BASE_SONGS;
  rmSync(markFile, { force: true });
});

test('a first walk pages down to the oldest measurement, then the mark bounds the next', async () => {
  // Oldest measurement 1,500 h before T0: songs s0..s1500 can postdate it.
  const r = await fc.changedFiles(new Date(T0 - 1_500 * HOUR).toISOString());
  assert.ok(r);
  assert.equal(r.complete, true);
  assert.equal(r.changes.length, 1_501);
  assert.equal(r.newest, SONGS[0].updatedAt);
  assert.deepEqual(listCalls, [0, 1000], 'stops at the floor, never pages the rest');
  await fc.saveMark(r.newest);
  assert.ok(existsSync(markFile));

  listCalls.length = 0;
  const next = await fc.changedFiles(new Date(T0 - 1_500 * HOUR).toISOString());
  assert.equal(next?.changes.length, CHANGE_MARK_MARGIN_MS / HOUR + 1, 'only the margin behind the mark');
  assert.deepEqual(listCalls, [0]);
});

test('nothing measured yet: nothing is stale, Navidrome is not paged', async () => {
  const r = await fc.changedFiles(null);
  assert.deepEqual(r, { changes: [], newest: null, complete: true, since: null, futureDated: 0 });
  assert.deepEqual(listCalls, []);
});

test('a failed deep page keeps the newest changes and says the answer is partial', async () => {
  failFromStart = 1000;
  const r = await fc.changedFiles(new Date(T0 - 2_400 * HOUR).toISOString());
  assert.ok(r);
  assert.equal(r.complete, false, 'the walk must not move the mark past what it did not read');
  assert.equal(r.changes.length, 1000);
  assert.equal(r.changes[0].id, 's0');
});

test('a failed first page, or another server, is no answer at all', async () => {
  failFromStart = 0;
  assert.equal(await fc.changedFiles(new Date(T0 - 10 * HOUR).toISOString()), null);
  failFromStart = null;
  serverType = 'gonic';
  listCalls.length = 0;
  assert.equal(await fc.changedFiles(new Date(T0 - 10 * HOUR).toISOString()), null);
  assert.deepEqual(listCalls, [], 'never asks a server that is not Navidrome');
});

test('a future-dated file is skipped, never moves the mark past now, and a future mark is read as now', async () => {
  // updatedAt is the file's mtime: one file from a device with a wrong clock
  // used to become the saved mark, blinding every later walk, and to postdate
  // every measurement, re-analysed on every walk.
  const now = T0 + HOUR;
  SONGS = [{ id: 'skewed', updatedAt: new Date(now + 400 * 24 * HOUR).toISOString() }, ...BASE_SONGS];
  const r = await fc.changedFiles(new Date(T0 - 10 * HOUR).toISOString(), now);
  assert.ok(r);
  assert.equal(r.futureDated, 1);
  assert.ok(!r.changes.some(c => c.id === 'skewed'), 'not a change');
  assert.equal(r.newest, SONGS[1].updatedAt, 'the mark is the newest real change');
  assert.equal(r.changes.length, 11);
  // A mark already saved in the future (an older build, a skewed clock) is read as now.
  writeFileSync(markFile, JSON.stringify({ newest: new Date(now + 30 * 24 * HOUR).toISOString() }));
  const next = await fc.changedFiles(null, now);
  assert.ok(next);
  assert.equal(next.since, new Date(now - CHANGE_MARK_MARGIN_MS).toISOString());
  assert.ok(next.changes.length > 0, 'the floor is now less the margin, not above every change');
  assert.ok(Date.parse(next.newest!) <= now, 'never saved past now');
});
