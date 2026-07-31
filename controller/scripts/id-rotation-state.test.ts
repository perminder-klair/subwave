// Tests for the controller-side half of the Navidrome ID-rotation handoff
// (music/id-rotation.ts applyPendingRotation): the tagger child adopts rotated
// library rows and leaves state/id-rotation.json; the controller then rewrites
// every id-keyed state file through its own store module — blocklist, likes,
// playlist recipes, show playlist pins — and removes the manifest.
//
// Ordering is the point: this must complete BEFORE the post-tag playlist sync,
// or syncRecipe() sees every recipe's playlist id as vanished and deletes the
// lot (playlist-sync.ts prunedMissing). The test also pins the fallback rule
// for playlist ids: with Navidrome unreachable (as in this sandbox), the raw
// canonicalId transform applies — shape-gated and idempotent, so a fixed-point
// id is untouched and a genuinely dead one degrades exactly as today.
//
// Runs against a temp STATE_DIR set before any src import (dynamic imports
// below), matching scripts/stem-backfill.test.ts.
// Run: `tsx scripts/id-rotation-state.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

// Golden pairs from Navidrome PR #5824 (pinned in scripts/id-canonical.test.ts).
const OLD_TRACK = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW_TRACK = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_TRACK2 = 'zzzzzzzzzzzzzzzzzzzzzz';
const NEW_TRACK2 = '3LyqmwQBm5IRqlVjNYASwb';
// A track id the adoption could NOT confirm (not in the manifest) — track-type
// consumers must leave it alone rather than guess.
const UNMAPPED_TRACK = '0bbbbbbbbbbbbbbbbbbbbb';
// Old-style playlist uuid → canonical re-encode (applied via the transform,
// not the manifest — playlist ids can't be validated against song liveIds).
const OLD_PL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_PL = '7rke2SAWaicSeSYzkhww6R';
// Hash-family id — canonicalId fixed point; must never change.
const FIXED_ARTIST = '5cLJPkLA5DK2BADhoeotPk';

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-rotation-'));
  process.env.STATE_DIR = stateDir;
  // Hermetic: the dev box may have a real Navidrome on the default URL, which
  // would flip mapPlaylistId into its validated mode. Point at a dead port so
  // the test always exercises the unreachable → raw-transform fallback.
  process.env.NAVIDROME_URL = 'http://127.0.0.1:1';

  // ---- seed the id-keyed state files (pre-rotation shapes) -----------------
  writeFileSync(join(stateDir, 'blocklist.json'), JSON.stringify({
    entries: [
      { type: 'track', id: OLD_TRACK, name: 'Blocked Song', artist: 'A', album: 'B', addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'track', id: UNMAPPED_TRACK, name: 'Unknown Song', artist: 'C', album: 'D', addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'album', id: OLD_TRACK2, name: 'Blocked Album', artist: 'E', album: null, addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'artist', id: FIXED_ARTIST, name: 'Blocked Artist', artist: null, album: null, addedAt: '2026-07-01T00:00:00.000Z' },
    ],
  }));

  writeFileSync(join(stateDir, 'likes.json'), JSON.stringify({
    secret: 'test-secret',
    likes: [
      {
        songId: OLD_TRACK,
        track: { id: OLD_TRACK, title: 'Liked Song', artist: 'A' },
        airingKey: `${OLD_TRACK}|2026-07-01T10:00:00.000Z`,
        listenerKey: 'abc', likedAt: '2026-07-01T10:01:00.000Z',
      },
      {
        songId: UNMAPPED_TRACK,
        track: { id: UNMAPPED_TRACK, title: 'Other Song' },
        airingKey: `${UNMAPPED_TRACK}|2026-07-02T10:00:00.000Z`,
        listenerKey: 'def', likedAt: '2026-07-02T10:01:00.000Z',
      },
    ],
  }));

  writeFileSync(join(stateDir, 'playlist-recipes.json'), JSON.stringify({
    version: 1,
    recipes: [{
      playlistId: OLD_PL,
      name: 'Sunset Drive',
      recipe: { prompt: 'golden hour', seedTrackIds: [OLD_TRACK, UNMAPPED_TRACK], knobs: {}, sources: {} },
      perSyncCap: 25,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: null,
      lastResult: null,
    }],
  }));

  // The manifest the tagger child left behind — only CONFIRMED track pairs.
  writeFileSync(join(stateDir, 'id-rotation.json'), JSON.stringify({
    version: 1,
    at: '2026-07-31T00:00:00.000Z',
    trackMap: { [OLD_TRACK]: NEW_TRACK, [OLD_TRACK2]: NEW_TRACK2 },
  }));

  const settings = await import('../src/settings.js');
  const blocklist = await import('../src/music/blocklist.js');
  const recipes = await import('../src/music/playlist-recipes.js');
  const rotation = await import('../src/music/id-rotation.js');
  await settings.load();

  // A show pinned to the old playlist id, created through the real settings
  // write path so validation/normalisation apply.
  const personaId = settings.get().personas[0].id;
  await settings.update({
    shows: [{ name: 'Test Show', personaId, playlistIds: [OLD_PL], excludedPlaylistIds: [OLD_TRACK] }],
  });

  const result = await rotation.applyPendingRotation();

  console.log('state-file migration after a confirmed rotation:');

  await test('reports having applied the manifest', () => {
    assert.equal(result.applied, true);
  });

  await test('blocklist: confirmed track ids remap, unmapped stays, album/artist via transform', async () => {
    const raw = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
    const byName = Object.fromEntries(raw.entries.map((e: { name: string; id: string }) => [e.name, e.id]));
    assert.equal(byName['Blocked Song'], NEW_TRACK);
    assert.equal(byName['Unknown Song'], UNMAPPED_TRACK);
    assert.equal(byName['Blocked Album'], NEW_TRACK2);
    assert.equal(byName['Blocked Artist'], FIXED_ARTIST);
    // The in-memory index moved with the file — enforcement sees the new id.
    assert.equal(blocklist.isBlocked({ id: NEW_TRACK }), true);
    assert.equal(blocklist.isBlocked({ id: OLD_TRACK }), false);
  });

  await test('likes: songId, track snapshot and airingKey prefix all follow the map', () => {
    const raw = JSON.parse(readFileSync(join(stateDir, 'likes.json'), 'utf8'));
    const moved = raw.likes.find((r: { likedAt: string }) => r.likedAt === '2026-07-01T10:01:00.000Z');
    assert.equal(moved.songId, NEW_TRACK);
    assert.equal(moved.track.id, NEW_TRACK);
    assert.equal(moved.airingKey, `${NEW_TRACK}|2026-07-01T10:00:00.000Z`);
    const kept = raw.likes.find((r: { likedAt: string }) => r.likedAt === '2026-07-02T10:01:00.000Z');
    assert.equal(kept.songId, UNMAPPED_TRACK);
    assert.equal(kept.airingKey, `${UNMAPPED_TRACK}|2026-07-02T10:00:00.000Z`);
  });

  await test('playlist recipes: key and confirmed seeds remap before any sync can prune', () => {
    const entry = recipes.list()[0];
    assert.equal(entry.playlistId, NEW_PL);
    assert.deepEqual(entry.recipe.seedTrackIds, [NEW_TRACK, UNMAPPED_TRACK]);
    const raw = JSON.parse(readFileSync(join(stateDir, 'playlist-recipes.json'), 'utf8'));
    assert.equal(raw.recipes[0].playlistId, NEW_PL);
  });

  await test('show playlist pins remap through the settings write path', () => {
    const show = settings.get().shows.find((s: { name: string }) => s.name === 'Test Show');
    assert.deepEqual(show.playlistIds, [NEW_PL]);
    assert.deepEqual(show.excludedPlaylistIds, [NEW_TRACK]);
    const sched = JSON.parse(readFileSync(join(stateDir, 'schedule.json'), 'utf8'));
    const stored = sched.shows.find((s: { name: string }) => s.name === 'Test Show');
    assert.deepEqual(stored.playlistIds, [NEW_PL]);
  });

  await test('the manifest is consumed', () => {
    assert.equal(existsSync(join(stateDir, 'id-rotation.json')), false);
  });

  await test('a second call is a fast no-op', async () => {
    const again = await rotation.applyPendingRotation();
    assert.equal(again.applied, false);
  });

  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall id-rotation-state tests passed');
  process.exit(0);
}

await main();
