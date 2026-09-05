// downloadCapped must not leave its staging file behind when it throws — and
// must KEEP it on every path that returns one, including the deliberate
// cap-hit truncation the outro analysis depends on.
//
// Every failing case here SEEDS the destination first, so the assertion is
// "the cleanup ran", not the weaker "no file happened to be created" — that
// distinction is what makes the two guards ABOVE the pipeline (a non-200, an
// honest error envelope caught on the content type) worth pinning alongside
// the three throws that do write a file.
//
// Loopback HTTP only, no external network: the same shape as
// analyzer-path-fallback.test.ts — stand a server up, point NAVIDROME_URL at
// it, then dynamically import analyzer.js so its module-level ANALYZE_TMP_DIR
// and ANALYZE_MAX_BYTES resolve against the temp STATE_DIR and the small cap
// set below.

import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

// One behaviour per song id, so each test names the failure it is pinning.
type Mode = 'truncated' | 'empty' | 'tiny-envelope' | 'json-header' | 'server-error' | 'over-cap' | 'tiny-audio' | 'ok';

const AUDIO = 'audio/mpeg';

// The byte cap the module reads at import time. Small enough that a test can
// serve past it in one response — the real default is 12 MB.
const MAX_BYTES = 4096;

// One envelope shared by the two cases that serve one, so they can only ever
// differ in the header under test.
const ERROR_BODY = JSON.stringify({
  'subsonic-response': { status: 'failed', error: { code: 70, message: 'Song not found' } },
});

function respond(mode: Mode, res: ServerResponse): void {
  switch (mode) {
    // Promises more body than it sends, then kills the socket — the shape a
    // request-timeout abort or a dropped connection takes mid-download.
    case 'truncated':
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': '4096' });
      res.write(Buffer.alloc(64, 0x41));
      setTimeout(() => res.destroy(), 10);
      return;
    // 200, audio content type, no bytes — trips the `read === 0` guard after
    // the write stream has already created the file.
    case 'empty':
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': '0' });
      res.end();
      return;
    // A Subsonic error envelope wearing an audio content type: slips the header
    // guard, gets written to disk, and is caught by the <1024-byte backstop.
    case 'tiny-envelope':
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': String(Buffer.byteLength(ERROR_BODY)) });
      res.end(ERROR_BODY);
      return;
    // Honest error envelope — rejected by the content-type guard, before any
    // file is created. Seeded anyway, so this pins that the cleanup is blanket.
    case 'json-header':
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(ERROR_BODY)) });
      res.end(ERROR_BODY);
      return;
    // The other pre-pipeline throw: `!res.ok`. Also creates no file, also
    // seeded, for the same reason.
    case 'server-error':
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('navidrome exploded');
      return;
    // More audio than the cap — the SUCCESS path that truncates. `capped()`
    // returns normally, pipeline resolves, and the short file is kept with
    // complete:false so outro analysis can veto itself.
    case 'over-cap': {
      const body = Buffer.alloc(MAX_BYTES * 16, 0x5a);
      body.writeUInt8(0xff, 0);
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    // Real audio SHORTER than the 1024-byte backstop window: re-read, found not
    // to start with '{' or '<', and kept. The backstop's own false-positive edge.
    case 'tiny-audio': {
      const body = Buffer.alloc(512, 0x5a);
      body.writeUInt8(0xff, 0);
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
    // Real (if short) audio, over the backstop window and under the cap — the
    // plain success path, which must KEEP its file.
    case 'ok': {
      const body = Buffer.alloc(2048, 0x5a);
      body.writeUInt8(0xff, 0); // not '{' or '<', so the small-file backstop stays clear
      res.writeHead(200, { 'Content-Type': AUDIO, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }
  }
}

const server = createServer((req, res) => {
  // The cap case abandons the body mid-response, which resets the connection —
  // an unhandled 'error' here would take the test process down with it.
  req.on('error', () => {});
  res.on('error', () => {});
  const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || '';
  respond(id as Mode, res);
});

let analyzer: typeof import('../src/music/analyzer.js');
let tmpDir: string;

// The path downloadCapped stages to, recomputed the way the module does.
function stagedPath(id: string): string {
  return join(tmpDir, 'analyze-tmp', `${encodeURIComponent(id)}.audio`);
}

// Put a file where the download will stage, so "gone afterwards" means the
// cleanup ran rather than nothing having been written in the first place.
function seed(id: string): string {
  const dest = stagedPath(id);
  mkdirSync(join(tmpDir, 'analyze-tmp'), { recursive: true });
  writeFileSync(dest, 'stale');
  return dest;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'subwave-analyzer-cleanup-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.STATE_DIR = tmpDir;
  process.env.ANALYZE_MAX_BYTES = String(MAX_BYTES);
  process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
  analyzer = await import('../src/music/analyzer.js');
});

after(async () => {
  analyzer?.shutdown();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  rmSync(tmpDir, { recursive: true, force: true });
});

test('a download cut off mid-body leaves no partial file behind', async () => {
  const dest = seed('truncated');
  await assert.rejects(analyzer.downloadCapped('truncated'));
  assert.equal(existsSync(dest), false, 'the partial .audio must be removed when the pipeline rejects');
});

test('a 200 with no audio bytes leaves no zero-length file behind', async () => {
  const dest = seed('empty');
  await assert.rejects(analyzer.downloadCapped('empty'), /empty audio/);
  assert.equal(existsSync(dest), false, 'the zero-length .audio must be removed');
});

test('an error envelope wearing an audio content type leaves no file behind', async () => {
  const dest = seed('tiny-envelope');
  await assert.rejects(analyzer.downloadCapped('tiny-envelope'), analyzer.NonAudioResponseError);
  assert.equal(existsSync(dest), false, 'the .audio holding a Subsonic error envelope must be removed');
});

test('an error envelope caught on the content type also clears a stale staging file', async () => {
  const dest = seed('json-header');
  await assert.rejects(analyzer.downloadCapped('json-header'), analyzer.NonAudioResponseError);
  assert.equal(existsSync(dest), false, 'cleanup is blanket — it does not depend on this throw having written a file');
});

test('a non-200 clears a stale staging file too', async () => {
  const dest = seed('server-error');
  await assert.rejects(analyzer.downloadCapped('server-error'), /download 500/);
  assert.equal(existsSync(dest), false, 'the other pre-pipeline guard must not be an exception to the cleanup');
});

test('a download that hits the byte cap KEEPS its truncated file', async () => {
  const { path, complete } = await analyzer.downloadCapped('over-cap');
  assert.equal(path, stagedPath('over-cap'));
  assert.equal(existsSync(path), true, 'the cap is a success, not a failure — the cleanup must not fire');
  assert.equal(complete, false, 'a capped read is incomplete, which is what vetoes outro analysis');
  assert.ok(
    statSync(path).size >= MAX_BYTES,
    `the kept file holds at least the cap (${statSync(path).size} bytes)`,
  );
});

test('real audio shorter than the backstop window is kept', async () => {
  const { path, complete } = await analyzer.downloadCapped('tiny-audio');
  assert.equal(existsSync(path), true, 'the <1024 re-read must not condemn a short file that is real audio');
  assert.equal(statSync(path).size, 512);
  assert.equal(complete, true);
});

test('a successful download keeps its file for the caller to hand on', async () => {
  const { path, complete } = await analyzer.downloadCapped('ok');
  assert.equal(path, stagedPath('ok'));
  assert.equal(existsSync(path), true, 'the success path must keep the staged file — the caller owns it from here');
  assert.equal(statSync(path).size, 2048);
  assert.equal(complete, true, 'a body under the byte cap is a complete file');
});
