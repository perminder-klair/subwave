// Pins removeTempDir (test-utils/temp-dir.ts), the after() teardown for a file
// that removes its own temp dir. The race it closes: src's best-effort writers
// (logEvent, the pick and Subsonic call logs) leave an fs request on libuv's
// threadpool, which keeps running while a synchronous rmSync holds the main
// thread, so a request still queued at teardown can land inside the dir being
// removed: ENOTEMPTY when it straddles the walk (pick-transition-context, #2021),
// a write into a deleted dir when it comes after. Holding the threadpool makes
// "still queued at teardown" certain instead of a busy host's bad luck.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { appendFile, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const fifoRoot = createTempDir(join(tmpdir(), 'subwave-remove-temp-dir-fifo-'));
const stateRoot = createTempDir(join(tmpdir(), 'subwave-remove-temp-dir-'));
process.env.STATE_DIR = stateRoot;
const { logEvent } = await import('../src/observability/events.js');

// libuv runs fs requests on UV_THREADPOOL_SIZE threads (4 unless set), in the
// order they were queued. Opening a FIFO for reading blocks its thread until a
// writer opens the other end, so one open per thread parks every later fs
// request in the queue until the returned release() is called. release() is
// safe to repeat: a second writer open with no reader left would block forever.
let fifoCount = 0;
function holdThreadpool(): () => Promise<void> {
  const size = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const fifos = Array.from({ length: size }, () => join(fifoRoot, `hold-${fifoCount++}`));
  for (const fifo of fifos) assert.equal(spawnSync('mkfifo', [fifo]).status, 0, `mkfifo ${fifo}`);
  const readers = fifos.map((fifo) => open(fifo, 'r'));
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // A reader blocked in open() already counts as one, so these return at once.
    for (const fifo of fifos) closeSync(openSync(fifo, 'w'));
    for (const reader of readers) await (await reader).close();
  };
}

test('a write queued before teardown lands before the directory is removed', async () => {
  const dir = stateRoot;
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const release = holdThreadpool();
  let removal: Promise<void> | undefined;
  try {
    // The real best-effort writer (into STATE_DIR/logs), plus a stand-in whose
    // outcome the test can read.
    logEvent('teardown.probe');
    const probe = appendFile(join(dir, 'logs', 'probe.log'), 'line\n')
      .then(() => 'landed', (err: NodeJS.ErrnoException) => err.code);
    removal = removeTempDir(dir);
    for (let i = 0; i < 20; i++) await tick();
    assert.ok(existsSync(dir), 'a write is still queued, so the directory must still be there');
    await release();
    await removal;
    assert.equal(await probe, 'landed', 'the queued write ran before the removal, not into a removed directory');
    assert.equal(existsSync(dir), false);
  } finally {
    await release();
    await removal?.catch(() => {});
  }
});

test('a pending FileHandle close still counts, because a rename can follow it', async () => {
  const dir = createTempDir(join(tmpdir(), 'subwave-remove-temp-dir-close-'));
  const temp = join(dir, 'queue.json.tmp');
  const handle = await open(temp, 'wx');
  await handle.writeFile('{}');
  await tick(); // the write's own request is still listed until a turn has passed
  // writeFileAtomic's tail: close the temp, then rename it into place. The
  // close is now the only fs request in flight.
  const write = handle.close().then(() => rename(temp, join(dir, 'queue.json')))
    .then(() => 'landed', (err: NodeJS.ErrnoException) => err.code);
  await removeTempDir(dir);
  assert.equal(await write, 'landed', 'the rename ran before the removal, not into a removed directory');
  assert.equal(existsSync(dir), false);
});

test('a request that never settles fails the teardown instead of removing the directory under it', async () => {
  const dir = createTempDir(join(tmpdir(), 'subwave-remove-temp-dir-stuck-'));
  const release = holdThreadpool();
  try {
    await assert.rejects(removeTempDir(dir, 50), /Not removing .*stuck-\w+: \d+ fs request\(s\) still in flight after 50 ms/);
    assert.ok(existsSync(dir));
  } finally {
    await release();
  }
});
