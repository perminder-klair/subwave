import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'failed-fetch-integration-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test-password';
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/debug.js');
const { readPlaybackFailures } = await import('../src/observability/playback-failures.js');

test('confirmed queued failures persist once and admin list/export share safe records', async () => {
  queue.autoPick = false;
  const item = { track: { id: 'backend-1', title: 'Song', artist: 'Artist', album: 'Album', streamUrl: 'https://secret/' }, resolveProbeId: 'handoff-1', operator: true, requestedBy: 'studio' };
  queue.upcoming = [item];
  queue.onPushResolveFailed(item);
  queue.onPushResolveFailed(item);
  assert.equal(queue.upcoming.length, 0);
  let history = await readPlaybackFailures({ stationDir: dir });
  for (let i = 0; i < 50 && history.failures.length === 0; i++) {
    await new Promise(r => setTimeout(r, 20));
    history = await readPlaybackFailures({ stationDir: dir });
  }
  assert.equal(history.failures.length, 1);
  assert.equal(history.failures[0].source, 'operator');
  assert.equal(history.failures[0].sourceTrackId, 'backend-1');
  const restarted = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { readPlaybackFailures } from './src/observability/playback-failures.ts'; console.log(JSON.stringify(await readPlaybackFailures({stationDir: process.env.STATE_DIR})));`],
  { encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), history, 'new process sees durable history');
  for (const [source, probe] of [['request', 'handoff-2'], ['ai', 'handoff-3']] as const) {
    const later = { track: item.track, resolveProbeId: probe, requestedBy: source === 'request' ? 'private listener name' : null };
    queue.upcoming = [later];
    queue.onPushResolveFailed(later);
  }
  for (let i = 0; i < 50; i++) {
    history = await readPlaybackFailures({ stationDir: dir });
    if (history.failures.length === 3) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(history.failures.map(row => row.source).sort(), ['ai', 'operator', 'request']);
  assert.equal(JSON.stringify(history).includes('private listener name'), false);
  for (let i = 0; i < 50; i++) {
    try { await readFile(join(dir, 'queue.json')); break; }
    catch { await new Promise(r => setTimeout(r, 20)); }
  }
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}` };
  try {
    for (const route of ['/debug/playback-failures', '/debug/playback-failures/export']) {
      const denied = await fetch(base + route);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
    }
    const list = await fetch(base + '/debug/playback-failures', { headers });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await list.json(), history);
    const download = await fetch(base + '/debug/playback-failures/export', { headers });
    assert.match(download.headers.get('content-type') || '', /application\/x-ndjson/);
    assert.match(download.headers.get('content-disposition') || '', /attachment; filename="subwave-playback-failures-/);
    assert.equal(download.headers.get('x-history-retention-days'), '14');
    assert.equal(download.headers.get('x-history-truncated'), 'false');
    assert.deepEqual((await download.text()).trim().split('\n').map(line => JSON.parse(line)), history.failures);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
