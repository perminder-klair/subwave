// The operator's answer to a replaced-file hold reaches the walk from the API:
// POST /library/reconcile and POST /tag-library forward confirmReplaced and
// acceptReplaced through broadcast/tagger.ts as the CLI flags, only for an
// explicit true, and a run with neither body field stays as it was. The walk's
// side of the flags is in replaced-file-walk.test.ts.
// Run: npm test -- tagger-replaced-flags
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import type { Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const STATE = createTempDir(join(tmpdir(), 'subwave-tagger-replaced-'));
process.env.STATE_DIR = STATE;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
// Nothing in this test may reach a real music server or mixer.
process.env.NAVIDROME_URL = 'http://127.0.0.1:1';
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = '1';

const started: string[][] = [];
const spawn = cp.spawn;
cp.spawn = ((command: string, args: readonly string[], opts: cp.SpawnOptions) => {
  if (command === 'npx' && opts?.cwd === '/app') {
    started.push([...args]);
    return spawn(process.execPath, ['-e', 'process.exit(0)'], { ...opts, cwd: STATE });
  }
  return spawn(command, args, opts);
}) as typeof cp.spawn;
syncBuiltinESMExports();

const t = await import('../src/broadcast/tagger.js');
const express = (await import('express')).default;
const maintenance = await import('../src/routes/library/maintenance.js');
const jingles = await import('../src/routes/jingles.js');

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(maintenance.router);
  app.use(jingles.router);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await removeTempDir(STATE);
});

// One run through the route: the flags it spawned with, past the script path.
async function flagsOf(path: string, body: unknown): Promise<string[]> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  for (let i = 0; i < 400 && t.tagger.running; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(t.tagger.running, false);
  return (started.at(-1) as string[]).filter(a => a.endsWith('-replaced'));
}

test('POST /library/reconcile forwards the answer', async () => {
  assert.deepEqual(await flagsOf('/library/reconcile', {}), []);
  assert.ok(started.at(-1)?.includes('--reconcile-only'));
  assert.deepEqual(await flagsOf('/library/reconcile', { confirmReplaced: true }), ['--confirm-replaced']);
  assert.deepEqual(await flagsOf('/library/reconcile', { acceptReplaced: true }), ['--accept-replaced']);
});

test('POST /tag-library forwards the answer', async () => {
  assert.deepEqual(await flagsOf('/tag-library', {}), []);
  assert.deepEqual(await flagsOf('/tag-library', { confirmReplaced: true }), ['--confirm-replaced']);
  assert.deepEqual(await flagsOf('/tag-library', { acceptReplaced: true }), ['--accept-replaced']);
});

test('only an explicit true counts: this answer can clear the library\'s analysis', async () => {
  assert.deepEqual(await flagsOf('/library/reconcile', { confirmReplaced: 'true', acceptReplaced: 1 }), []);
  assert.deepEqual(await flagsOf('/tag-library', { confirmReplaced: 'yes' }), []);
});
