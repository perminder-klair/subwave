import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const OLD = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_PL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_PL = '7rke2SAWaicSeSYzkhww6R';
const self = fileURLToPath(import.meta.url);

function child(mode: string, state: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', self, mode], {
    env: { ...process.env, STATE_DIR: state }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function scenario(mode: string) {
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

  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', playlists: { playlist: [{ id: NEW_PL }] } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  process.env.NAVIDROME_URL = `http://127.0.0.1:${addr.port}`;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
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

if (process.argv[2]) {
  await scenario(process.argv[2]);
} else {
  test('controller boot recovers a committed adoption after the child exits before publishing its map', () => {
    const state = mkdtempSync(join(tmpdir(), 'id-rotation-crash-'));
    try { seed(state); child('commit-and-exit', state); child('recover-boot', state); }
    finally { rmSync(state, { recursive: true, force: true }); }
  });
  for (const file of ['blocklist.json', 'likes.json', 'playlist-recipes.json', 'schedule.json']) {
    test(`a failed ${file} write is persisted on retry before the recovery map is consumed`, () => {
      const state = mkdtempSync(join(tmpdir(), 'id-rotation-write-'));
      try { seed(state); child(file, state); }
      finally { rmSync(state, { recursive: true, force: true }); }
    });
  }
}
