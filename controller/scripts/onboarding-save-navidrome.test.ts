// POST /onboarding/save must never wipe stored Navidrome credentials with blanks.
//
// The web wizard always sends a `navidrome` block, and when the operator skips
// that step (the documented path for re-running the wizard to change only the
// DJ brain) the block is all empty strings. saveSetupConfig spreads its patch
// over the stored block, so a blank that reaches it replaces the saved value:
// GET /onboarding/status flips to needsSetup and the next cold boot has no
// music source. A blank field is "not provided".
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router mounts
// bare over real HTTP against a temp state dir.
//
// Run: `npm test -- onboarding-save-navidrome`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-onboarding-save-'));
process.env.STATE_DIR = stateRoot;
process.env.MUSIC_ROUTER_URL = 'http://127.0.0.1:9';
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
delete process.env.NAVIDROME_URL;
delete process.env.NAVIDROME_USER;
delete process.env.NAVIDROME_PASS;

const SETUP = path.join(stateRoot, 'setup-config.json');
const STORED = { url: 'http://127.0.0.1:9', user: 'radio', pass: 's3cret' };

const express = (await import('express')).default;
const { router } = await import('../src/routes/onboarding.js');
const { config } = await import('../src/config.js');
const { loadNavidromeConfig, syncRouterConfig } = await import('../src/setup/config.js');

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

async function seedStored(mode: 'navidrome' | 'router' = 'navidrome') {
  writeFileSync(SETUP, JSON.stringify({
    navidrome: STORED,
    setupCompletedAt: '2026-01-01T00:00:00.000Z',
    ...(mode === 'navidrome' ? { music: { mode, merge: false, sources: [] } } : {}),
  }));
  await syncRouterConfig();
  await loadNavidromeConfig();
}

async function save(body: unknown) {
  const res = await fetch(`${base}/onboarding/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

test('a skipped Navidrome step leaves stored credentials, live and on disk', async () => {
  await seedStored();
  const r = await save({ navidrome: { url: '', user: '', pass: '' }, station: 'Test FM' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status.needsSetup, false);

  const onDisk = JSON.parse(readFileSync(SETUP, 'utf8'));
  assert.deepEqual(onDisk.navidrome, STORED);

  const status = await (await fetch(`${base}/onboarding/status`)).json() as any;
  assert.equal(status.needsSetup, false);

  // What the next controller boot would load.
  config.navidrome.url = '';
  config.navidrome.user = '';
  config.navidrome.password = '';
  await loadNavidromeConfig();
  assert.equal(config.navidrome.url, STORED.url);
  assert.equal(config.navidrome.user, STORED.user);
  assert.equal(config.navidrome.password, STORED.pass);
});

test('whitespace-only fields count as blank too', async () => {
  await seedStored();
  await save({ navidrome: { url: '  ', user: ' ', pass: '' } });
  assert.deepEqual(JSON.parse(readFileSync(SETUP, 'utf8')).navidrome, STORED);
});

test('a partial block changes only the fields it carries', async () => {
  await seedStored();
  const r = await save({ navidrome: { url: 'http://127.0.0.2:9/', user: '', pass: '' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const onDisk = JSON.parse(readFileSync(SETUP, 'utf8'));
  assert.deepEqual(onDisk.navidrome, { ...STORED, url: 'http://127.0.0.2:9' });
  assert.equal(config.navidrome.url, 'http://127.0.0.2:9');
  assert.equal(config.navidrome.password, STORED.pass);
});

test('a full block on a fresh install is still saved', async () => {
  writeFileSync(SETUP, '{}');
  await syncRouterConfig();
  await loadNavidromeConfig();
  const r = await save({ navidrome: STORED });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status.needsSetup, false);
  assert.deepEqual(JSON.parse(readFileSync(SETUP, 'utf8')).navidrome, STORED);
});

test('skipping Navidrome preserves the default routed connection across a boot', async () => {
  await seedStored('router');
  const routed = { ...config.navidrome };
  const r = await save({ navidrome: { url: '', user: '', pass: '' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status.needsSetup, false);
  assert.deepEqual(JSON.parse(readFileSync(SETUP, 'utf8')).navidrome, STORED);
  assert.deepEqual(config.navidrome, routed);
  await syncRouterConfig();
  await loadNavidromeConfig();
  assert.deepEqual(config.navidrome, routed);
  const routerConfig = JSON.parse(readFileSync(path.join(stateRoot, 'router/config.json'), 'utf8'));
  assert.deepEqual(routerConfig.sources[0].config, { url: STORED.url, user: STORED.user, password: STORED.pass });
});
