// The admin preview player's routes (routes/library/preview.ts): an admin asks
// for a signed link, and the link streams the track from a fake Subsonic
// server on a real socket, Range passed through so the browser can seek.
//
// Run: npm test -- library-preview

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-library-preview-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'preview-admin';
process.env.ADMIN_PASS = 'preview-pass';

const { config } = await import('../src/config.js');
const express = (await import('express')).default;
const { router: previewRoutes, previewLinkValid, previewPath, PREVIEW_TTL_SEC } = await import('../src/routes/library/preview.js');

const AUDIO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const fake = { requests: [] as Array<{ path: string; id: string | null; format: string | null; range: string | undefined }> };
const nd = await listen((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const id = u.searchParams.get('id');
  fake.requests.push({ path: u.pathname, id, format: u.searchParams.get('format'), range: req.headers.range });
  if (u.pathname !== '/rest/stream') { res.writeHead(404); return res.end(); }
  if (id === 'gone') {
    // Subsonic answers an unknown id with a 200 error document.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"subsonic-response":{"status":"failed","error":{"code":70}}}');
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : AUDIO.length - 1;
    res.writeHead(206, {
      'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${from}-${to}/${AUDIO.length}`, 'Content-Length': String(to - from + 1),
    });
    return res.end(AUDIO.subarray(from, to + 1));
  }
  res.writeHead(200, { 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes', 'Content-Length': String(AUDIO.length) });
  res.end(AUDIO);
});
nd.server.unref();
config.navidrome.url = nd.url;

const app = express();
app.use(previewRoutes);
const { server, url: base } = await listen(app);
server.unref();
after(async () => { await removeTempDir(dir); });

const auth = { Authorization: `Basic ${Buffer.from('preview-admin:preview-pass').toString('base64')}` };
async function linkFor(id: string) {
  const r = await fetch(`${base}/library/${id}/preview`, { method: 'POST', headers: auth });
  assert.equal(r.status, 200);
  return (await r.json() as { path: string; expiresInSec: number });
}

beforeEach(() => { fake.requests = []; });

test('only an admin gets a link, and it names the track and expires', async () => {
  assert.equal((await fetch(`${base}/library/abc/preview`, { method: 'POST' })).status, 401);
  const { path, expiresInSec } = await linkFor('abc');
  assert.equal(expiresInSec, PREVIEW_TTL_SEC);
  assert.match(path, /^\/library\/preview\/abc\?exp=\d+&sig=[\w-]+$/);
  assert.equal((await fetch(`${base}/library/a%2Fb/preview`, { method: 'POST', headers: auth })).status, 400);
});

test('the link streams the original file without the admin header', async () => {
  const { path } = await linkFor('abc');
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/flac');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(String(r.headers.get('cache-control')), /no-store/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), AUDIO);
  assert.equal(fake.requests.length, 1);
  assert.deepEqual({ path: fake.requests[0].path, id: fake.requests[0].id, format: fake.requests[0].format },
    { path: '/rest/stream', id: 'abc', format: 'raw' });
});

test('a Range request seeks: 206 with the slice and its Content-Range', async () => {
  const { path } = await linkFor('abc');
  const r = await fetch(`${base}${path}`, { headers: { Range: 'bytes=500-599' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 500-599/1000');
  assert.equal(r.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), AUDIO.subarray(500, 600));
  assert.equal(fake.requests[0].range, 'bytes=500-599');
});

test('a forged, swapped, expired or missing signature never reaches the music server', async () => {
  const { path } = await linkFor('abc');
  const sig = new URL(path, 'http://x').searchParams.get('sig')!;
  const exp = new URL(path, 'http://x').searchParams.get('exp')!;
  for (const p of [
    `/library/preview/abc?exp=${exp}&sig=${sig.slice(0, -2)}xx`,
    `/library/preview/other?exp=${exp}&sig=${sig}`,
    `/library/preview/abc?exp=${Number(exp) + 1}&sig=${sig}`,
    '/library/preview/abc',
  ]) {
    assert.equal((await fetch(`${base}${p}`)).status, 403, p);
  }
  // An expired link: signed by the same rule, its expiry in the past.
  const old = previewPath('abc', Date.now() - (PREVIEW_TTL_SEC + 60) * 1000);
  assert.equal((await fetch(`${base}${old}`)).status, 403);
  const q = new URL(old, 'http://x').searchParams;
  assert.equal(previewLinkValid('abc', q.get('exp'), q.get('sig'), Date.now() - (PREVIEW_TTL_SEC + 60) * 1000 + 1000), true);
  assert.equal(fake.requests.length, 0);
});

test('an id the music server does not know is a 404, not a JSON body played as audio', async () => {
  const { path } = await linkFor('gone');
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 404);
});
