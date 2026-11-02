// Durable ID rotation across process exits, failed state writes and older
// in-flight saves. Each scenario gets a fresh process to isolate store caches
// and the filesystem interception used to hold an ordinary save before migration.

import { createTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { deferred } from './test-utils/async.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const OLD = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_PL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_PL = '7rke2SAWaicSeSYzkhww6R';
const self = fileURLToPath(import.meta.url);

function child(mode: string, state: string, store?: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', self, mode, ...(store ? [store] : [])], {
    env: { ...process.env, STATE_DIR: state }, encoding: 'utf8', timeout: store ? 15_000 : 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function startNavidrome(playlistIds: string[]) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', playlists: { playlist: playlistIds.map(id => ({ id })) } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  process.env.NAVIDROME_URL = `http://127.0.0.1:${addr.port}`;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
  return server;
}

async function recoveryScenario(mode: string) {
  const state = process.env.STATE_DIR!;
  if (mode === 'commit-and-exit') {
    const db = await import('../src/music/library-db.js');
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    db.upsertTrackMeta(OLD, { title: 'Song', artist: 'Artist' });
    db.upsertTrackTags(OLD, { moods: ['warm'], energy: 'medium', source: 'llm', confidence: 1 });
    db.upsertTrackMeta(NEW, { title: 'Song', artist: 'Artist' });
    const stems = await import('../src/music/stem-cache.js');
    mkdirSync(stems.dirFor(OLD), { recursive: true });
    writeFileSync(join(stems.dirFor(OLD), 'vocals.wav'), 'cached audio');
    assert.equal(db.adoptRotatedIds(new Set([NEW])).adopted, 1);
    // Stop at the exact seam: SQLite committed, no filesystem handoff ran.
    process.exit(0);
  }

  const server = await startNavidrome([NEW_PL]);
  const db = await import('../src/music/library-db.js');
  const rotation = await import('../src/music/id-rotation.js');
  const blocklist = await import('../src/music/blocklist.js');
  const likes = await import('../src/broadcast/likes.js');
  const recipes = await import('../src/music/playlist-recipes.js');
  const settings = await import('../src/settings.js');
  const read = (name: string) => JSON.parse(readFileSync(join(state, name), 'utf8'));
  try {
    await settings.load();
    await settings.update({ shows: [{ name: 'Show', personaId: settings.get().personas[0].id, playlistIds: [OLD_PL] }] });
    await blocklist.load();
    await likes.load();
    recipes.list();
    if (mode === 'recover-boot') {
      assert.equal(db.isOpen(), false, 'boot recovery must work before library.load');
      assert.equal(existsSync(rotation.manifestPath()), false);
      assert.deepEqual(await rotation.applyPendingRotation(), { applied: true, complete: true });
      assert.equal(read('blocklist.json').entries[0].id, NEW);
      const stems = await import('../src/music/stem-cache.js');
      assert.equal(readFileSync(join(stems.dirFor(NEW), 'vocals.wav'), 'utf8'), 'cached audio');
      assert.equal(existsSync(stems.dirFor(OLD)), false);
      assert.deepEqual(await rotation.applyPendingRotation(), { applied: false, complete: true });
      return;
    }
    writeFileSync(rotation.manifestPath(), JSON.stringify({ version: 1, at: new Date().toISOString(), trackMap: { [OLD]: NEW } }));
    const target = join(state, mode);
    renameSync(target, `${target}.saved`);
    mkdirSync(target); // reject atomic rename after the in-memory mutation
    await assert.rejects(rotation.applyPendingRotation());
    assert.equal(existsSync(rotation.manifestPath()), true);
    rmSync(target, { recursive: true });
    renameSync(`${target}.saved`, target);
    assert.deepEqual(await rotation.applyPendingRotation(), { applied: true, complete: true });
    assert.equal(existsSync(rotation.manifestPath()), false);
    assert.equal(read('blocklist.json').entries[0].id, NEW);
    assert.equal(read('likes.json').likes[0].songId, NEW);
    assert.equal(read('likes.json').likes[0].track.id, NEW);
    assert.equal(read('playlist-recipes.json').recipes[0].playlistId, NEW_PL);
    assert.deepEqual(read('playlist-recipes.json').recipes[0].recipe.seedTrackIds, [NEW]);
    assert.deepEqual(read('schedule.json').shows[0].playlistIds, [NEW_PL]);
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function seed(state: string) {
  writeFileSync(join(state, 'blocklist.json'), JSON.stringify({ entries: [{ type: 'track', id: OLD, name: 'Song', artist: 'Artist', album: null, addedAt: new Date().toISOString() }], rules: [] }));
  writeFileSync(join(state, 'likes.json'), JSON.stringify({ secret: 'test', likes: [{ songId: OLD, track: { id: OLD, title: 'Song' }, airingKey: `${OLD}|operator`, listenerKey: 'test', likedAt: new Date().toISOString() }] }));
  writeFileSync(join(state, 'playlist-recipes.json'), JSON.stringify({ version: 1, recipes: [{ playlistId: OLD_PL, name: 'Playlist', recipe: { seedTrackIds: [OLD], knobs: {}, sources: {} }, perSyncCap: 25, createdAt: new Date().toISOString(), lastSyncedAt: null, lastResult: null }] }));
}


async function orderedSaveScenario(mode: string, store: string) {
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

  const server = await startNavidrome([]);
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
  if (process.argv[3]) await orderedSaveScenario(process.argv[2], process.argv[3]);
  else await recoveryScenario(process.argv[2]);
} else {
  test('controller boot recovers a committed adoption after the child exits before publishing its map', () => {
    const state = createTempDir(join(tmpdir(), 'id-rotation-crash-'));
    try { seed(state); child('commit-and-exit', state); child('recover-boot', state); }
    finally { rmSync(state, { recursive: true, force: true }); }
  });
  for (const file of ['blocklist.json', 'likes.json', 'playlist-recipes.json', 'schedule.json']) {
    test(`a failed ${file} write is persisted on retry before the recovery map is consumed`, () => {
      const state = createTempDir(join(tmpdir(), 'id-rotation-write-'));
      try { seed(state); child(file, state); }
      finally { rmSync(state, { recursive: true, force: true }); }
    });
  }
  for (const store of ['likes', 'blocklist']) {
    for (const scenario of ['race', 'fail-earlier']) {
      const behavior = scenario === 'race'
        ? `an older ${store} save cannot undo an acknowledged ID migration after restart`
        : `a failed earlier ${store} save does not prevent durable ID migration`;
      test(behavior, () => {
        const state = createTempDir(join(tmpdir(), 'id-rotation-write-order-'));
        try {
          for (const mode of [scenario, 'reload']) {
            child(mode, state, store);
          }
        } finally {
          rmSync(state, { recursive: true, force: true });
        }
      });
    }
  }
}
