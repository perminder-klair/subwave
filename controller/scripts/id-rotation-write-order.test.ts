import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const OLD = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW = '6VHl3uR4kss6sUPKA8Cwnk';
const self = fileURLToPath(import.meta.url);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function scenario(mode: string, store: string) {
  const state = process.env.STATE_DIR!;
  if (mode === 'reload') {
    const likes = await import('../src/broadcast/likes.js');
    const blocklist = await import('../src/music/blocklist.js');
    const db = await import('../src/music/library-db.js');
    await likes.load();
    await blocklist.load();
    if (store === 'likes') {
      assert.equal(likes.index()[NEW]?.count, 1, 'migrated like survives restart');
      assert.equal(likes.index()[OLD], undefined);
    } else {
      assert.equal(blocklist.isBlocked({ id: NEW }), true, 'migrated track remains blocked after restart');
    }
    assert.equal(db.pendingIdRotations().size, 0);
    return;
  }

  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', playlists: { playlist: [] } } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
  writeFileSync(join(state, 'likes.json'), JSON.stringify({ secret: 'fixture', likes: [] }));
  writeFileSync(join(state, 'blocklist.json'), JSON.stringify({ entries: [], rules: [] }));

  const target = join(state, `${store}.json`);
  const held = deferred(), release = deferred(), laterFinished = deferred();
  const originalWrite = fs.writeFile, originalRename = fs.rename;
  let writes = 0;
  let intercepted = false;
  fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(`${target}.`)) writes++;
    return originalWrite(...args);
  };
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) !== target) return originalRename(...args);
    if (!intercepted) {
      intercepted = true;
      held.resolve();
      await release.promise;
      // If a newer write overtakes this held save, make the older snapshot
      // finish last. An ordered writer has not started that newer I/O yet.
      if (writes > 1) await laterFinished.promise;
      if (mode === 'fail-earlier') throw new Error('injected earlier save failure');
      return originalRename(...args);
    }
    await originalRename(...args);
    laterFinished.resolve();
  };
  syncBuiltinESMExports();

  const db = await import('../src/music/library-db.js');
  const likes = await import('../src/broadcast/likes.js');
  const blocklist = await import('../src/music/blocklist.js');
  const rotation = await import('../src/music/id-rotation.js');
  let ordinary: Promise<unknown> | undefined;
  try {
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    db.upsertTrackMeta(OLD, { title: 'Song', artist: 'Artist' });
    db.upsertTrackMeta(NEW, { title: 'Song', artist: 'Artist' });
    assert.equal(db.adoptRotatedIds(new Set([NEW])).adopted, 1);
    await blocklist.load();
    if (store === 'likes') {
      await likes.recordLike({ track: { id: OLD, title: 'Song' }, ip: '192.0.2.1' });
    } else {
      ordinary = blocklist.add({ type: 'track', id: OLD, name: 'Song' })
        .then(() => null, error => error);
    }
    await held.promise;
    const migration = rotation.applyPendingRotation();
    const remapped = () => store === 'likes' ? !!likes.index()[NEW] : blocklist.isBlocked({ id: NEW });
    const deadline = Date.now() + 5_000;
    while (!remapped() && Date.now() < deadline) await setImmediate();
    assert.ok(remapped(), 'migration must reach the store while the earlier save is held');
    release.resolve();
    assert.deepEqual(await migration, { applied: true, complete: true });
    if (store === 'blocklist') {
      const error = await ordinary;
      if (mode === 'fail-earlier') assert.match(String(error), /injected earlier save failure/);
      else assert.equal(error, null);
    }
    assert.equal(db.pendingIdRotations().size, 0);
  } finally {
    release.resolve();
    fs.writeFile = originalWrite;
    fs.rename = originalRename;
    syncBuiltinESMExports();
    db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (process.argv[2]) {
  await scenario(process.argv[2], process.argv[3]);
} else {
  for (const store of ['likes', 'blocklist']) {
    for (const scenario of ['race', 'fail-earlier']) {
      const behavior = scenario === 'race'
        ? `an older ${store} save cannot undo an acknowledged ID migration after restart`
        : `a failed earlier ${store} save does not prevent durable ID migration`;
      test(behavior, () => {
        const state = mkdtempSync(join(tmpdir(), 'id-rotation-write-order-'));
        try {
          for (const mode of [scenario, 'reload']) {
            const result = spawnSync(process.execPath, ['--import', 'tsx', self, mode, store], {
              env: { ...process.env, STATE_DIR: state }, encoding: 'utf8', timeout: 15_000,
            });
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
          }
        } finally {
          rmSync(state, { recursive: true, force: true });
        }
      });
    }
  }
}
