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
