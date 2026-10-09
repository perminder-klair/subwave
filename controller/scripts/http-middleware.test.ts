import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import express, { type Express } from 'express';
import { configureHttp, httpErrorHandler } from '../src/middleware/http.js';
import { createTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-http-'));
process.env.STATE_DIR = join(root, '.config', 'subwave');
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
process.env.TTS_VOICE_DIR = join(process.env.STATE_DIR, 'voices');
const auth = { Authorization: `Basic ${Buffer.from('test:test').toString('base64')}` };

async function listen(app: Express, t: TestContext): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('HTTP middleware preserves empty bodies and extended queries, including raw and form parsers', async t => {
  const app = express();
  configureHttp(app);
  app.post('/body', (req, res) => res.json(req.body));
  app.get('/query', (req, res) => res.json(req.query));
  app.post('/raw', express.raw({ type: 'application/zip' }), (req, res) => {
    assert.ok(Buffer.isBuffer(req.body));
    res.send(req.body);
  });
  app.post('/form', express.urlencoded({ extended: false }), (req, res) => res.json(req.body));
  app.use(httpErrorHandler);
  const url = await listen(app, t);
  assert.deepEqual(await (await fetch(`${url}/body`, { method: 'POST' })).json(), {});
  assert.deepEqual(await (await fetch(`${url}/query?ids[]=a&ids[]=b&filter[mood]=calm`)).json(), {
    ids: ['a', 'b'], filter: { mood: 'calm' },
  });
  const raw = await fetch(`${url}/raw`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: 'ZIP bytes' });
  assert.equal(await raw.text(), 'ZIP bytes');
  const form = await fetch(`${url}/form`, { method: 'POST', body: new URLSearchParams({ action: 'listener_add', pass: 'test' }) });
  assert.deepEqual(await form.json(), { action: 'listener_add', pass: 'test' });
});

test('malformed and oversized JSON return readable JSON errors with CORS and security headers', async t => {
  const app = express();
  configureHttp(app);
  app.post('/body', (_req, res) => res.sendStatus(204));
  app.use(httpErrorHandler);
  const url = await listen(app, t);
  for (const [body, status, error] of [
    ['{"secret":', 400, 'Invalid JSON body'],
    [JSON.stringify({ text: 'x'.repeat(600 * 1024) }), 413, 'Request body too large'],
  ] as const) {
    const response = await fetch(`${url}/body`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), null);
    assert.deepEqual(await response.json(), { error });
  }
  const preflight = await fetch(`${url}/body`, { method: 'OPTIONS', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(preflight.status, 200, 'preflight must not attempt JSON parsing');
});

test('Express forwards rejected route promises to JSON errors without exposing internal messages', async t => {
  const app = express();
  configureHttp(app);
  app.get('/reject', async () => { throw new Error('private provider credential'); });
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.use(httpErrorHandler);
  const url = await listen(app, t);
  const log = t.mock.method(console, 'error', () => {});
  const rejected = await fetch(`${url}/reject`, { signal: AbortSignal.timeout(2000) });
  assert.equal(rejected.status, 500);
  assert.deepEqual(await rejected.json(), { error: 'Internal server error' });
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(await (await fetch(`${url}/ok`)).json(), { ok: true });
});

test('all admin audio previews serve files under hidden state parents and still require authentication', async t => {
  for (const kind of ['sfx', 'beds', 'jingles', 'voices']) {
    mkdirSync(join(process.env.STATE_DIR!, kind), { recursive: true });
    writeFileSync(join(process.env.STATE_DIR!, kind, 'preview.wav'), 'preview audio bytes');
    if (kind !== 'voices') {
      const key = kind === 'jingles' ? 'preview.wav' : 'preview';
      writeFileSync(join(process.env.STATE_DIR!, `${kind}.json`), JSON.stringify({ items: { [key]: { file: 'preview.wav' } } }));
    }
  }
  const app = express();
  configureHttp(app);
  for (const kind of ['sfx', 'beds', 'jingles', 'voices']) {
    const { router } = await import(`../src/routes/${kind}.js`);
    app.use(router);
  }
  app.use(httpErrorHandler);
  const url = await listen(app, t);
  for (const route of ['/sfx/preview/audio', '/beds/preview/audio', '/jingles/preview.wav/audio', '/voices/preview.wav/audio']) {
    assert.equal((await fetch(url + route)).status, 401);
    const response = await fetch(url + route, { headers: auth });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(await response.text(), 'preview audio bytes');
    const range = await fetch(url + route, { headers: { ...auth, Range: 'bytes=0-6' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'preview');
  }
  assert.equal((await fetch(`${url}/voices/%2e%2e%2fsettings.json/audio`, { headers: auth })).status, 404);
});
