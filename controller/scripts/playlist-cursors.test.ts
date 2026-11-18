import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createPlaylistCursorStore } from '../src/music/playlist-cursors.js';
import { cursorFor } from '../src/music/playlist-order.js';

test('an overlapping reset survives a cold load after an earlier pick is delayed', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playlist-cursors-order-'));
  const file = join(dir, 'playlist-cursors.json');
  const store = () => createPlaylistCursorStore({ file, knownShowIds: () => ['show'] });
  const active = store();
  await active.load();

  let release = () => {};
  let started = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const originalMkdir = fs.mkdir;
  let calls = 0;
  let reset: Promise<boolean> | undefined;
  let pick: Promise<void> | undefined;
  const mkdir = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (++calls === 1) {
      started();
      await held;
      // If a later mutation overtook this operation, finish the older one
      // last. A serialized store has not started the reset's I/O yet.
      if (calls > 1) await reset;
    }
    return originalMkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    pick = active.commit('show', cursorFor({ id: 't6', title: 'Track 6', artist: 'Artist' }, 5, 'playlist'));
    await firstStarted;
    reset = active.reset('show');
    await setImmediate();
    release();
    await pick;
    assert.equal(await reset, true);
    assert.equal(await active.get('show'), null);
    assert.equal(await store().get('show'), null, 'a successful reset must survive a restart');
  } finally {
    release();
    await Promise.allSettled([pick, reset]);
    mkdir.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed pick save does not prevent a queued reset from reaching disk', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playlist-cursors-retry-'));
  const file = join(dir, 'playlist-cursors.json');
  const store = () => createPlaylistCursorStore({ file, knownShowIds: () => ['show'] });
  const active = store();
  const originalMkdir = fs.mkdir;
  let calls = 0;
  const mkdir = t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (++calls === 1) throw new Error('injected directory failure');
    return originalMkdir(...args);
  });
  syncBuiltinESMExports();
  try {
    const failed = assert.rejects(
      active.commit('show', cursorFor({ id: 't6' }, 5, 'playlist')),
      /injected directory failure/,
    );
    const reset = active.reset('show');
    await failed;
    assert.equal(await reset, true);
    assert.equal(await store().get('show'), null);
  } finally {
    mkdir.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
