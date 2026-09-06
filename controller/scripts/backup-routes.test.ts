// The backup ROUTES, over real HTTP against a real state dir (#1570).
//
// scripts/backup-schedule.test.ts pins the decisions; this pins the surface an
// operator actually touches. Three of them had no test at all:
//
//   GET  /backup/restorable   which files are offered, and which are marked
//                             as the schedule's own
//   GET  /backup/file/:name   download a STORED snapshot (the whole reason a
//                             rotation is worth having: it gets a backup off
//                             the box). It reads a caller-supplied name out of
//                             STATE_DIR, so its guard is the interesting part,
//                             not its happy path.
//   POST /backup/import-file  the claim the feature rests on: a zip the
//                             SCHEDULE wrote restores like any other. If the
//                             two archives could differ, this is where it shows.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset (middleware/auth.ts),
// so the router mounts bare. No containers, no network beyond loopback.
//
// Run: `npm test -- backup-routes`.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-backup-routes-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const { router } = await import('../src/routes/backup.js');
const { isScheduledBackupName, scheduledBackupName } = await import('../src/backup/pure.js');

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
// unref, or the listening socket holds the event loop open and the test FILE
// never exits — which under scripts/run-tests.ts (concurrency 1) wedges the
// whole suite rather than failing it. An in-flight fetch still keeps the loop
// alive on its own while a request is being served.
server.unref();
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// Two files one word apart: the schedule's own, and the one an operator
// downloaded and copied back to restore past a proxy's upload cap (#612).
const AUTO = scheduledBackupName(new Date('2026-09-06T04:23:17Z'));
const HAND = 'subwave-backup-2026-09-01.zip';
const AUTO_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x7a, 0x00, 0x01]);
writeFileSync(path.join(stateRoot, AUTO), AUTO_BYTES);
writeFileSync(path.join(stateRoot, HAND), 'hand-copied bytes');
writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
// A half-written scheduled backup, which must be offered to nobody.
writeFileSync(path.join(stateRoot, `${AUTO}.deadbeef.tmp`), 'half a zip');

test('GET /backup/restorable offers both zips and marks only the schedule own', async () => {
  const res = await fetch(`${base}/backup/restorable`);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.stateDir, stateRoot);

  const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f]));
  assert.ok(byName[AUTO], 'the scheduled backup must be restorable');
  assert.ok(byName[HAND], 'the hand-copied backup must stay restorable - that is the #612 hatch');
  assert.equal(byName[AUTO].auto, true);
  assert.equal(byName[HAND].auto, false, 'one word apart, and the badge must not confuse them');
  assert.equal(byName[AUTO].size, AUTO_BYTES.length);

  // The badge is the same grammar retention prunes by, asked server-side once.
  for (const f of body.files) assert.equal(f.auto, isScheduledBackupName(f.name));

  // Neither the half-written temp nor an ordinary state file is a candidate.
  assert.equal(body.files.some((f: any) => f.name.endsWith('.tmp')), false);
  assert.equal(body.files.some((f: any) => f.name === 'settings.json'), false);
});

test('GET /backup/file/:name returns the STORED bytes, not a fresh archive', async () => {
  const res = await fetch(`${base}/backup/file/${encodeURIComponent(AUTO)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`filename="${AUTO}"`));
  const got = Buffer.from(await res.arrayBuffer());
  // Byte-for-byte. GET /backup/export builds a NEW archive taken now, which is
  // exactly what this route exists not to do.
  assert.deepEqual(got, AUTO_BYTES);
  assert.deepEqual(got, readFileSync(path.join(stateRoot, AUTO)));
});

test('GET /backup/file/:name cannot read outside the state dir', async () => {
  // The guard, not the happy path: this hands a caller-supplied name to join().
  const outside = path.join(stateRoot, '..', 'subwave-escaped-probe.zip');
  writeFileSync(outside, 'must never be served');

  for (const name of [
    '../subwave-escaped-probe.zip',
    '..%2Fsubwave-escaped-probe.zip',
    '%2e%2e%2fsubwave-escaped-probe.zip',
    '/etc/passwd',
    '..',
    'settings.json',            // in the dir, but not a .zip
    `${AUTO}.deadbeef.tmp`,     // a half-written backup is not a backup
  ]) {
    const res = await fetch(`${base}/backup/file/${encodeURIComponent(name)}`);
    assert.ok(res.status === 400 || res.status === 404,
      `${JSON.stringify(name)} must be refused, got ${res.status}`);
    const body = await res.text();
    assert.equal(body.includes('must never be served'), false);
  }

  // A well-formed name that simply is not there.
  const missing = await fetch(`${base}/backup/file/subwave-auto-backup-2011-01-01-000000.zip`);
  assert.equal(missing.status, 404);
});

test('a zip the SCHEDULE wrote restores like any other', async () => {
  // The claim the whole feature rests on: POST /backup/import-file cannot tell
  // a scheduled archive from a hand-pressed one, because buildBackupZip() is
  // the single assembly behind both. Export one, park it under the SCHEDULED
  // name, and restore it back through the disk path.
  const exported = await fetch(`${base}/backup/export`);
  assert.equal(exported.status, 200, await exported.clone().text().catch(() => ''));
  const zip = Buffer.from(await exported.arrayBuffer());
  assert.ok(zip.length > 0);

  const asScheduled = scheduledBackupName(new Date('2026-09-07T04:23:00Z'));
  writeFileSync(path.join(stateRoot, asScheduled), zip);

  // It shows up as the schedule's own...
  const list = await (await fetch(`${base}/backup/restorable`)).json() as any;
  assert.equal(list.files.find((f: any) => f.name === asScheduled)?.auto, true);

  // ...downloads byte-identically...
  const dl = await fetch(`${base}/backup/file/${encodeURIComponent(asScheduled)}`);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), zip);

  // ...and restores.
  const restored = await fetch(`${base}/backup/import-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: asScheduled }),
  });
  const outcome = await restored.json() as any;
  assert.equal(restored.status, 200, JSON.stringify(outcome));
  assert.equal(outcome.ok, true);
  assert.ok(outcome.restored.includes('settings.json'),
    `a station snapshot must carry settings.json; got ${JSON.stringify(outcome.restored)}`);
});

test('POST /backup/import-file refuses a name it must not read', async () => {
  for (const file of ['../subwave-escaped-probe.zip', '/etc/passwd', 'settings.json', '', null, 7]) {
    const res = await fetch(`${base}/backup/import-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(file)} must be refused`);
  }
});
