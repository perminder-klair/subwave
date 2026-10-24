// Pins the wiring of broadcast/tagger-run-log.ts into broadcast/tagger.ts: a
// maintenance child that prints faster than any poll still lands every line,
// once, in order, in both the cursor feed and the run's file, ending with its
// exit line, and a second run starts a new log. The state dir sits under a
// hidden directory, which is where a native clone under ~/.local keeps it.
// Run: npm test -- tagger-run-log-wiring
import { createTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const STATE = createTempDir(join(tmpdir(), '.subwave-tagger-run-log-'));
process.env.STATE_DIR = STATE;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
// Nothing in this test may reach a real music server or mixer.
process.env.NAVIDROME_URL = 'http://127.0.0.1:1';
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = '1';

const LINES = 400;
// The child: a burst of raw lines, one event with its terse echo just before
// it (the shape makeEventLogger prints), and a last line written as it exits.
const CHILD = `
const ev = { kind: 'success', text: 'Reconciled 3 tracks', at: '2026-10-21T05:27:41.000Z' };
let out = '';
for (let i = 1; i <= ${LINES}; i++) out += '[tag] line ' + i + '\\n';
out += '[tag] Reconciled 3 tracks\\n';
out += '[event] ' + JSON.stringify(ev) + '\\n';
process.stdout.write(out);
process.stdout.write('[tag] last words\\n', () => process.exit(0));
`;

// A child that exits while a grandchild still holds its stdout, the shape of
// npx's wrapper leaving before the worker under it: 'exit' fires, then the
// grandchild's line, then 'close'.
const DRAINING_CHILD = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "setTimeout(() => process.stdout.write('[tag] drained after exit\\\\n'), 300)"], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write('[tag] parent done\\n', () => process.exit(0));
`;
let childScript = CHILD;

const spawn = cp.spawn;
cp.spawn = ((command: string, args: readonly string[], opts: cp.SpawnOptions) => {
  if (command === 'npx' && opts?.cwd === '/app') {
    return spawn(process.execPath, ['-e', childScript], { ...opts, cwd: STATE });
  }
  return spawn(command, args, opts);
}) as typeof cp.spawn;
syncBuiltinESMExports();

const { EVENT_PREFIX } = await import('../src/music/tagger-progress.js');
assert.equal(EVENT_PREFIX, '[event] ', 'the fake child spells the event sentinel by hand');
const t = await import('../src/broadcast/tagger.js');

async function runOnce(): Promise<string> {
  t.startReconcile();
  const id = t.tagger.runLogId;
  assert.ok(id, 'a started run names its log');
  for (let i = 0; i < 400 && !(t.tagger.running === false && t.taggerLogSince(0)?.entries.at(-1)?.line?.toString().startsWith('[exit')); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // The held-back last raw line is released by the close itself.
  return id;
}

test('every line of a fast run reaches the cursor feed and the file, once, in order', async () => {
  const id = await runOnce();
  const page = t.taggerLogSince(0, id);
  assert.ok(page);
  const lines = page.entries.map(e => (typeof e.line === 'string' ? e.line : `[${e.line.kind}] ${e.line.text}`));
  const expected = [
    ...Array.from({ length: LINES }, (_, i) => `[tag] line ${i + 1}`),
    '[success] Reconciled 3 tracks',
    '[tag] last words',
    '[exit 0]',
  ];
  assert.deepEqual(lines, expected, 'no line lost or doubled; the echo folds into its event');
  assert.deepEqual(page.entries.map(e => e.seq), expected.map((_, i) => i + 1));
  assert.equal(page.closed, true, 'the pipes have closed');
  // The snapshot keeps its short tail, unchanged.
  assert.ok(t.taggerView().lastLog.length <= 30);

  const file = t.taggerLogFile(id);
  assert.ok(file, 'the run has a file');
  const body = readFileSync(file, 'utf8').trimEnd().split('\n').map(l => l.replace(/^\d\d:\d\d:\d\d {2}/, ''));
  assert.deepEqual(body, expected);

  // A cursor at the end reads nothing new.
  assert.equal(t.taggerLogSince(page.nextSeq, id)?.entries.length, 0);
});

test('a second run gets its own log; a cursor from the first reads it from the start', async () => {
  const first = t.tagger.runLogId!;
  const end = t.taggerLogSince(0, first)!.nextSeq;
  // No wait: a run started in the same second as the first gets its own id.
  const second = await runOnce();
  assert.notEqual(second, first);
  const page = t.taggerLogSince(end, first);
  assert.equal(page?.runId, second);
  assert.equal(page?.entries[0]?.seq, 1, 'the old run\'s cursor does not skip the new run\'s head');
  const files = t.taggerLogFiles().map(f => f.id);
  assert.deepEqual(files, [second, first], 'newest first');
  assert.deepEqual(readdirSync(join(STATE, 'tagger-logs')).sort(), [`${first}.log`, `${second}.log`].sort());
});

test('a run started before the last one drained leaves that run\'s file whole', async () => {
  childScript = DRAINING_CHILD;
  t.startReconcile();
  const draining = t.tagger.runLogId!;
  while (t.tagger.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.taggerLogSince(0, draining)?.closed, false, "'exit' came first: a reader keeps polling");
  // The first child has exited but its grandchild still holds the pipe, and
  // the operator presses Start again.
  childScript = CHILD;
  const next = await runOnce();
  assert.notEqual(next, draining);
  const file = t.taggerLogFile(draining)!;
  for (let i = 0; i < 200 && !readFileSync(file, 'utf8').includes('[exit'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const body = readFileSync(file, 'utf8').trimEnd().split('\n').map(l => l.replace(/^\d\d:\d\d:\d\d {2}/, ''));
  assert.deepEqual(body, ['[tag] parent done', '[tag] drained after exit', '[exit 0]']);
});

test('the download route serves the run\'s file, from under a hidden state dir too', async () => {
  const express = (await import('express')).default;
  const { router } = await import('../src/routes/library/maintenance.js');
  const app = express();
  app.use(router);
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/library/tagger/logs`;
    const id = t.tagger.runLogId!;
    const res = await fetch(`${base}/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${id}.log"`);
    assert.equal(await res.text(), readFileSync(t.taggerLogFile(id)!, 'utf8'));
    const missing = await fetch(`${base}/tagger-run-20200101-000000-tag`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('content-disposition'), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a log id outside the writer\'s pattern reads nothing', () => {
  assert.equal(t.taggerLogFile('../settings'), null);
  assert.equal(t.taggerLogFile('tagger-run-20261021-052741-other'), null);
});
