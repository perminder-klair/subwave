import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, unlink, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { createSessionArchiveReader } from '../src/util/session-archives.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-session-archives-'));
const dir = join(root, 'sessions');
await mkdir(dir);
process.env.STATE_DIR = root;
process.env.ADMIN_USER = 'archive-admin';
process.env.ADMIN_PASS = 'archive-test';
test.after(() => rm(root, { recursive: true, force: true }));

function archive(id: string, startedAt: string, turns = 2) {
  return JSON.stringify({
    id, kind: 'auto', key: `auto:${id}`, startedAt, endedAt: null,
    show: { name: 'Night Show' }, persona: { name: 'Host' },
    messages: Array.from({ length: turns }, () => ({ text: 'A conversation turn' })),
  });
}

test('lists summaries in chronological order and shares concurrent reads', async () => {
  await writeFile(join(dir, 'older.json'), archive('older', '2026-01-01', 5));
  await writeFile(join(dir, 'newer.json'), archive('newer', '2026-02-01'));
  await writeFile(join(dir, 'broken.json'), '{broken');
  await writeFile(join(dir, 'ignore.txt'), archive('ignored', '2026-12-01'));
  const list = createSessionArchiveReader(dir);
  const first = list();
  assert.equal(list(), first, 'concurrent requests share one scan');
  const summaries = await first;
  assert.deepEqual(summaries.map(s => s.id), ['newer', 'older']);
  assert.deepEqual(summaries[1], {
    id: 'older', kind: 'auto', key: 'auto:older', startedAt: '2026-01-01', endedAt: null,
    show: 'Night Show', persona: 'Host', turns: 5,
  });
  const again = await list();
  assert.equal(again[0], summaries[0], 'unchanged archives reuse summaries');
  assert.equal(again[1], summaries[1]);
});

test('refreshes changed, replaced and previously corrupt files, and forgets deletions', async () => {
  const changing = join(root, 'changing');
  await mkdir(changing);
  const file = join(changing, 'session.json');
  await writeFile(file, archive('first', '2026-01-01'));
  const list = createSessionArchiveReader(changing);
  const original = await list();
  const times = await stat(file);
  await writeFile(join(changing, 'replacement'), archive('other', '2026-01-01'));
  await rename(join(changing, 'replacement'), file);
  await utimes(file, times.atime, times.mtime);
  const replaced = await list();
  assert.equal(replaced[0]?.id, 'other', 'replacement with the same length and mtime is detected');
  assert.notEqual(replaced[0], original[0]);

  await writeFile(file, '{broken');
  assert.deepEqual(await list(), []);
  await writeFile(file, archive('fixed', '2026-02-01', 9));
  assert.equal((await list())[0]?.turns, 9);
  await unlink(file);
  assert.deepEqual(await list(), []);
  assert.deepEqual(await createSessionArchiveReader(join(root, 'missing'))(), []);
});

test('the admin endpoint preserves its default response and accepts bounded pagination', async () => {
  const { router } = await import('../src/routes/debug.js');
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Basic ${Buffer.from('archive-admin:archive-test').toString('base64')}` };
  try {
    assert.equal((await fetch(`${base}/sessions`)).status, 401);
    const full = await fetch(`${base}/sessions`, { headers });
    assert.equal(full.status, 200);
    const list = createSessionArchiveReader(dir);
    assert.deepEqual(await full.json(), { sessions: await list() });
    const paged = await fetch(`${base}/sessions?limit=1&offset=1`, { headers });
    assert.deepEqual(await paged.json(), { sessions: (await list()).slice(1, 2) });
    for (const query of ['limit=0', 'limit=501', 'offset=-1', 'limit=bad']) {
      assert.equal((await fetch(`${base}/sessions?${query}`, { headers })).status, 400);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
