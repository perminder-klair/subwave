// /listen.pls and /listen.m3u hand players absolute stream URLs. Without
// SITE_URL the origin comes from the request, so two things are pinned here,
// through a real Express app:
//   - the origin is the Host the request arrived on (every shipped proxy
//     forwards the public Host unchanged), never X-Forwarded-Host, and the
//     scheme is only ever http/https;
//   - the files are never stored by a shared cache, so one request's origin
//     cannot be served to every listener behind the same edge.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-tune-in-origin-'));
delete process.env.SITE_URL;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/public.js');
await settings.load();

const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

// node:http rather than fetch, which refuses to let a caller set Host.
function get(path: string, headers: Record<string, string>): Promise<{ status: number; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, cache: String(res.headers['cache-control'] || ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const file of ['/listen.pls', '/listen.m3u']) {
  test(`${file}: origin is the request Host, not X-Forwarded-Host`, async () => {
    const r = await get(file, {
      host: 'radio.example.com',
      'x-forwarded-host': 'elsewhere.example',
      'x-forwarded-proto': 'https',
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /https:\/\/radio\.example\.com\/stream\.mp3/);
    assert.doesNotMatch(r.body, /elsewhere/);
  });

  test(`${file}: never stored by a shared cache`, async () => {
    const r = await get(file, { host: 'radio.example.com' });
    assert.equal(r.cache, 'no-store');
  });

  test(`${file}: scheme is http/https only, and a malformed Host falls back`, async () => {
    const odd = await get(file, { host: 'radio.example.com:7700', 'x-forwarded-proto': 'javascript' });
    assert.match(odd.body, /http:\/\/radio\.example\.com:7700\/stream\.mp3/);
    const bad = await get(file, { host: 'radio.example.com/evil?x=' });
    assert.match(bad.body, /http:\/\/localhost\/stream\.mp3/);
    const v6 = await get(file, { host: '[::1]:7700' });
    assert.match(v6.body, /http:\/\/\[::1\]:7700\/stream\.mp3/);
  });

  test(`${file}: SITE_URL wins over any request header`, async () => {
    process.env.SITE_URL = 'https://canonical.example/';
    try {
      const r = await get(file, { host: 'radio.example.com', 'x-forwarded-host': 'elsewhere.example' });
      assert.match(r.body, /https:\/\/canonical\.example\/stream\.mp3/);
      assert.equal(r.cache, 'no-store');
    } finally {
      delete process.env.SITE_URL;
    }
  });
}
