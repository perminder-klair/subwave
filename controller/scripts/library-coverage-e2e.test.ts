// End-to-end for #1570: the real Express routes, the real library-coverage
// module and the REAL subsonic walk, driven over HTTP against a stub Navidrome.
//
// The unit test beside this one pins the module's own logic. What it cannot
// see is the thing the bug actually was — how many requests a page view costs.
// Here the stub COUNTS every Subsonic call it serves, so each claim in the PR
// is checked as a number rather than as a shape:
//
//   * a coverage read costs ZERO Navidrome requests, no matter how often the
//     admin page polls it;
//   * pressing Count costs one getAlbumList2 per 500-album page plus one
//     getAlbum PER ALBUM — the cost that had to come off the read path;
//   * a library reset costs ZERO (it was walking the whole catalogue);
//   * the count survives a controller restart, and comes back with the age it
//     was actually taken at;
//   * a count against an unreachable Navidrome reports WHY, and leaves an
//     earlier good count standing.
//
// Run: npm test -- library-coverage-e2e

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-coverage-e2e-'));
const COUNT_FILE = join(STATE, 'library-count.json');

// --- a stub Navidrome that counts what it is asked for ---------------------

const ALBUMS = 7;                 // albums in the fake catalogue
const SONGS_PER_ALBUM = 3;
const TOTAL_SONGS = ALBUMS * SONGS_PER_ALBUM;

let calls: Record<string, number> = {};
let navidromeDown = false;

function resetCalls() { calls = {}; }
const callsTotal = () => Object.values(calls).reduce((a, b) => a + b, 0);

function subsonic(body: Record<string, unknown>) {
  return { 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } };
}

const navi = express();
navi.get('/rest/:endpoint', (req, res) => {
  const ep = req.params.endpoint;
  calls[ep] = (calls[ep] ?? 0) + 1;
  if (navidromeDown) return res.status(503).send('navidrome is having a lie down');

  if (ep === 'getAlbumList2') {
    const offset = Number(req.query.offset ?? 0);
    // One page, then an empty page to end the walk — the real pagination shape.
    const album = offset > 0 ? [] : Array.from({ length: ALBUMS }, (_, i) => ({
      id: `al${i}`, name: `Album ${i}`, artist: `Artist ${i}`, year: 1990 + i,
    }));
    return res.json(subsonic({ albumList2: { album } }));
  }
  if (ep === 'getAlbum') {
    const id = String(req.query.id);
    return res.json(subsonic({
      album: {
        id, name: `Album ${id}`, artist: `Artist ${id}`, year: 1994,
        isCompilation: false,
        song: Array.from({ length: SONGS_PER_ALBUM }, (_, i) => ({
          id: `${id}-s${i}`, title: `Song ${i}`, artist: `Artist ${id}`,
          album: `Album ${id}`, albumId: id, duration: 180, suffix: 'mp3',
        })),
      },
    }));
  }
  // Anything else the controller happens to ask for during boot.
  return res.json(subsonic({}));
});

const naviServer: Server = createServer(navi);
await new Promise<void>((r) => naviServer.listen(0, '127.0.0.1', r));
const naviPort = (naviServer.address() as AddressInfo).port;

// --- boot the controller's real modules against that stub ------------------

process.env.STATE_DIR = STATE;
process.env.NAVIDROME_URL = `http://127.0.0.1:${naviPort}`;
process.env.NAVIDROME_USER = 'tester';
process.env.NAVIDROME_PASS = 'tester';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'hunter2';
process.env.NODE_ENV = 'test';

const AUTH = 'Basic ' + Buffer.from('admin:hunter2').toString('base64');

const { router: libraryRoutes } = await import('../src/routes/library.js');

const app = express();
app.use(express.json());
app.use(libraryRoutes);
const apiServer: Server = createServer(app);
await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { authorization: AUTH, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() as any };
}

// The scan is fire-and-forget, so tests wait for `scanning` to clear rather
// than guessing a duration.
async function waitForScan(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await req('/library/coverage');
    if (!body.scanning) return body;
    if (Date.now() > deadline) throw new Error('scan never finished');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.after(() => {
  apiServer.close();
  naviServer.close();
  rmSync(STATE, { recursive: true, force: true });
});

// --- the bug itself --------------------------------------------------------

test('a coverage read costs ZERO Navidrome requests, however often it is polled', async () => {
  resetCalls();
  // The admin Library page polls this on mount and used to poll it on a timer.
  // Twenty reads is a few minutes of the old 60s poll.
  for (let i = 0; i < 20; i++) {
    const { status, body } = await req('/library/coverage');
    assert.equal(status, 200);
    assert.equal(body.scanning, false, 'a read started a scan');
    assert.equal(body.total, null, 'an uncounted library reports null, not 0 or a guess');
    assert.equal(body.percent, null);
  }
  assert.equal(
    callsTotal(), 0,
    `a read path hit Navidrome ${callsTotal()} times: ${JSON.stringify(calls)}`,
  );
});

test('pressing Count walks the catalogue: one getAlbum PER ALBUM', async () => {
  resetCalls();
  const { status, body } = await req('/library/coverage/refresh', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // The response is the snapshot the scan is starting from, so the meter can
  // flip to "counting…" without waiting for the next poll.
  assert.equal(body.coverage.scanning, true, 'POST must report the scan as under way');

  const done = await waitForScan();
  assert.equal(done.total, TOTAL_SONGS, 'the walk must count every song');
  assert.equal(done.scanError, null);
  assert.ok(done.scannedAt, 'a completed count is stamped');

  // This is the cost the PR moved off the read path — assert its SHAPE, since
  // that is what makes it unaffordable on a real library.
  assert.equal(calls.getAlbum, ALBUMS, 'one getAlbum per album is the documented cost');
  assert.ok((calls.getAlbumList2 ?? 0) >= 1, 'the album pages are walked');
});

test('reads after a count are still free, and serve the stored number', async () => {
  resetCalls();
  for (let i = 0; i < 10; i++) {
    const { body } = await req('/library/coverage');
    assert.equal(body.total, TOTAL_SONGS);
  }
  assert.equal(callsTotal(), 0, 'serving a known total must not re-walk');
});

test('the GET has no ?refresh=1 back door', async () => {
  resetCalls();
  const { body } = await req('/library/coverage?refresh=1');
  assert.equal(body.scanning, false, '?refresh=1 started a scan');
  assert.equal(callsTotal(), 0, '?refresh=1 reached Navidrome');
  assert.equal(body.total, TOTAL_SONGS, 'the read still serves the stored count');
});

test('double-pressing Count walks once, not twice', async () => {
  // The button is now operator-driven, so an impatient double-click is the
  // ordinary case rather than a rare one. refresh() is single-flight; without
  // that guard each press would start its own full catalogue walk.
  resetCalls();
  await Promise.all([
    req('/library/coverage/refresh', { method: 'POST' }),
    req('/library/coverage/refresh', { method: 'POST' }),
    req('/library/coverage/refresh', { method: 'POST' }),
  ]);
  const done = await waitForScan();
  assert.equal(done.total, TOTAL_SONGS);
  assert.equal(
    calls.getAlbum, ALBUMS,
    `three presses walked the catalogue ${(calls.getAlbum ?? 0) / ALBUMS} times`,
  );
});

test('reads stay free while a count is running, and report it as running', async () => {
  resetCalls();
  await req('/library/coverage/refresh', { method: 'POST' });
  // Poll hard during the walk — this is the 3s loop the panel runs.
  let sawScanning = false;
  for (let i = 0; i < 5; i++) {
    const { body } = await req('/library/coverage');
    if (body.scanning) sawScanning = true;
  }
  await waitForScan();
  assert.ok(sawScanning, 'an in-flight count must be visible to the poll that watches it');
  // Only the walk's own calls — the concurrent reads added nothing.
  assert.equal(calls.getAlbum, ALBUMS, 'reads during a scan added Navidrome requests');
});

// --- the reset regression --------------------------------------------------

test('a library reset does not walk Navidrome', async () => {
  resetCalls();
  const { status } = await req('/library/reset', { method: 'POST' });
  assert.equal(status, 200);
  // Let a stray fire-and-forget walk start if one were going to.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(
    callsTotal(), 0,
    `reset hit Navidrome ${callsTotal()} times: ${JSON.stringify(calls)} — it wipes library.db, not the music server`,
  );
  const { body } = await req('/library/coverage');
  assert.equal(body.scanning, false, 'reset kicked a scan');
  assert.equal(body.total, TOTAL_SONGS, 'the Navidrome total is unaffected by a reset');
});

// --- persistence across a restart ------------------------------------------

test('the count is written to state/library-count.json', async () => {
  assert.ok(existsSync(COUNT_FILE), 'the count must persist — nothing recounts unattended');
  const stored = JSON.parse(readFileSync(COUNT_FILE, 'utf8'));
  assert.equal(stored.total, TOTAL_SONGS);
  assert.equal(stored.version, 1);
  assert.ok(stored.scannedAt);
  assert.deepEqual(Object.keys(stored).sort(), ['scannedAt', 'total', 'version']);
});

test('a restarted controller serves the stored count, free, with its real age', async () => {
  const before = JSON.parse(readFileSync(COUNT_FILE, 'utf8'));
  resetCalls();

  // A fresh module graph is as close to a container restart as a test gets.
  const rebooted = await import(`../src/music/library-coverage.js?restart=${Date.now()}`);
  const snap = await rebooted.get();

  assert.equal(snap.total, TOTAL_SONGS, 'the count did not survive the restart');
  assert.equal(snap.scannedAt, before.scannedAt, 'the age must be when it was COUNTED, not boot time');
  assert.equal(snap.scanning, false, 'a restart kicked a scan');
  assert.equal(callsTotal(), 0, 'a restart hit Navidrome');
  assert.equal(rebooted.hasCount(), true);
});

// --- failure is visible ----------------------------------------------------

test('a count against an unreachable Navidrome reports why, and keeps the old number', async () => {
  const good = await req('/library/coverage');
  const previousTotal = good.body.total;
  const previousStamp = good.body.scannedAt;
  assert.equal(previousTotal, TOTAL_SONGS);

  navidromeDown = true;
  try {
    await req('/library/coverage/refresh', { method: 'POST' });
    const after = await waitForScan();

    assert.ok(
      after.scanError,
      'a failed count must say why — the button has no other feedback',
    );
    assert.match(String(after.scanError), /getAlbumList2|503/i);
    assert.equal(after.total, previousTotal, 'a failed re-count blanked a good total');
    assert.equal(after.scannedAt, previousStamp, 'a failed re-count moved the age stamp');
  } finally {
    navidromeDown = false;
  }
});

test('a later successful count clears the error', async () => {
  await req('/library/coverage/refresh', { method: 'POST' });
  const done = await waitForScan();
  assert.equal(done.scanError, null, 'a good count must clear the previous failure');
  assert.equal(done.total, TOTAL_SONGS);
});

// --- the admin gate still applies -----------------------------------------

test('the count command is behind requireAdmin', async () => {
  const res = await fetch(`${api}/library/coverage/refresh`, { method: 'POST' });
  assert.equal(res.status, 401, 'counting is an expensive command — it must stay gated');
});
