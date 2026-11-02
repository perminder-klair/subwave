// The orphan purge ROUTES, over real HTTP against a real state dir and library.
//
// scripts/orphan-purge.test.ts pins what a pass does; this pins the surface an
// operator touches: the admin gate on a route that moves and deletes, the dry
// run behind the panel, the toggle, and the booth log's record of a manual pass.
//
// Run: `npm test -- stems-routes`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { listen as listenHttp } from './test-utils/http.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stems-routes-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const cache = await import('../src/music/stem-cache.js');
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/stems.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });
await settings.load();

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

const ROOT = cache.stemsRoot();
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
db.upsertTrackMeta('in-the-library', { title: 'Song', artist: 'A', album: 'B', duration: 200 });

function seedOrphan(id: string) {
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'head-drums.flac'), 'x');
  const t = new Date(Date.now() - 2 * 86400_000);
  utimesSync(dir, t, t);
}

const ADMIN = { authorization: `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}` };
const post = (body: unknown) => fetch(`${base}/stems/orphans`, {
  method: 'POST',
  headers: { ...ADMIN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('a toggle flips the setting and spends no walk', async () => {
  const res = await post({ setEnabled: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: true });
  assert.equal(settings.get()?.audio?.stemOrphanPurgeEnabled, true);
  await post({ setEnabled: false });
  assert.equal(settings.get()?.audio?.stemOrphanPurgeEnabled, false);
});

test('a confirmed pass reports what it did and logs it to the booth', async () => {
  seedOrphan('left-the-library');
  const res = await post({ confirm: true });
  const body = await res.json() as { report: { dryRun: boolean; quarantined: number } };
  assert.equal(body.report.dryRun, false);
  assert.equal(body.report.quarantined, 1);
  const entry = queue.djLog.find((e: { message: string }) => e.message.startsWith('Stem orphan purge (manual):'));
  assert.ok(entry, 'the pass is on the booth log');
  assert.match(entry.message, /quarantined 1, released 0, deleted 0/);
});

for (const [method, path] of [['GET', '/stems/orphans'], ['GET', '/stems/orphans/tracks'], ['POST', '/stems/orphans']]) {
  test(`${method} ${path} is admin-only`, async () => {
    seedOrphan('gate-check');
    const init = { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"confirm":true}' } : {}) };
    const res = await fetch(`${base}${path}`, init);
    assert.equal(res.status, 401);
    assert.ok(existsSync(join(ROOT, 'gate-check')), 'an unauthenticated press moved nothing');
    const wrong = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Basic ${Buffer.from('test-admin:nope').toString('base64')}` },
    });
    assert.equal(wrong.status, 401);
  });
}

test('a toggle from outside the admin gate changes nothing', async () => {
  const res = await fetch(`${base}/stems/orphans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"setEnabled":true}',
  });
  assert.equal(res.status, 401);
  assert.equal(settings.get()?.audio?.stemOrphanPurgeEnabled, false);
});

test('GET /stems/orphans is a dry run: it reports the orphan and moves nothing', async () => {
  seedOrphan('dry-run-orphan');
  const res = await fetch(`${base}/stems/orphans`, { headers: ADMIN });
  assert.equal(res.status, 200);
  const body = await res.json() as { enabled: boolean; report: { dryRun: boolean; quarantined: number } };
  assert.equal(body.enabled, false);
  assert.equal(body.report.dryRun, true);
  assert.ok(body.report.quarantined >= 1);
  assert.ok(existsSync(join(ROOT, 'dry-run-orphan')));
});

test('POST without confirm stays a dry run, and logs no pass', async () => {
  seedOrphan('still-dry');
  const logged = queue.djLog.length;
  const res = await post({});
  const body = await res.json() as { report: { dryRun: boolean } };
  assert.equal(body.report.dryRun, true);
  assert.ok(existsSync(join(ROOT, 'still-dry')));
  assert.equal(queue.djLog.length, logged);
});

test('GET /stems/orphans/tracks lists the orphans and leaves the library out', async () => {
  seedOrphan('listed-orphan');
  mkdirSync(join(ROOT, 'in-the-library'), { recursive: true });
  const res = await fetch(`${base}/stems/orphans/tracks`, { headers: ADMIN });
  assert.equal(res.status, 200);
  const { tracks } = await res.json() as { tracks: Array<{ id: string; state: string }> };
  assert.ok(tracks.some(t => t.id === 'listed-orphan' && t.state === 'orphan'));
  assert.ok(!tracks.some(t => t.id === 'in-the-library'));
});

test('a confirmed pass while another runs comes back refused, and that is logged too', async () => {
  seedOrphan('race-a');
  const [a, b] = await Promise.all([post({ confirm: true }), post({ confirm: true })]);
  const reports = await Promise.all([a.json(), b.json()]) as Array<{ report: { refused?: boolean; reason?: string } }>;
  const refused = reports.find(r => r.report.refused);
  assert.ok(refused, 'one of the two was refused');
  assert.match(refused.report.reason ?? '', /another purge pass is running/);
  const entry = queue.djLog.find((e: { message: string }) => /manual\): refused/.test(e.message));
  assert.ok(entry, 'the refusal is on the booth log');
});
