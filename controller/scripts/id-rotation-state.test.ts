// Tests for the controller-side half of the Navidrome ID-rotation handoff
// (music/id-rotation.ts applyPendingRotation): the tagger child adopts rotated
// library rows and leaves state/id-rotation.json; the controller then rewrites
// every id-keyed state file through its own store module — blocklist, likes,
// playlist recipes, show playlist pins — and removes the manifest.
//
// Ordering is the point: this must complete BEFORE the post-tag playlist sync,
// or syncRecipe() sees every recipe's playlist id as vanished and deletes the
// lot (playlist-sync.ts prunedMissing).
//
// Playlist ids are the half the manifest CAN'T prove (the walk only confirms
// song ids), so they are checked against the live playlist index instead — and
// both branches of that check are pinned here:
//   • reachable   → a dead id moves only when its canonical image is actually
//                   live; the manifest is consumed.
//   • unreachable → the playlist half is DEFERRED, not guessed. The track half
//                   still lands and the manifest survives for the next attempt.
//                   Guessing and then deleting the manifest would leave a wrong
//                   playlist id with no way to notice or retry, and a wrong
//                   playlist id is not inert — it is a recipe syncAllAfterTag
//                   deletes as vanished.
// A tiny local HTTP server stands in for Navidrome so the reachable branch is
// exercised for real, rather than only in the sandbox's unreachable mode.
//
// Runs against a temp STATE_DIR set before any src import (dynamic imports
// below), matching scripts/stem-backfill.test.ts.
// Run: `tsx scripts/id-rotation-state.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
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
// Old-style playlist uuid → canonical re-encode. Not carried by the manifest:
// resolved by the shape transform and confirmed against the live index.
const OLD_PL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_PL = '7rke2SAWaicSeSYzkhww6R';
// A playlist uuid whose canonical image is NOT live — deleted in Navidrome
// rather than rotated. It must be left exactly as it is: rewriting it to an id
// nothing answers for is how a pin silently stops resolving.
const DEAD_PL = '11111111-2222-3333-4444-555555555555';
// Hash-family id — canonicalId fixed point; must never change.
const FIXED_ARTIST = '5cLJPkLA5DK2BADhoeotPk';

// Stand-in Navidrome. Answers getPlaylists with NEW_PL live (the post-rotation
// state) and every other endpoint with an empty OK, which is all
// applyPendingRotation asks of it.
function fakeNavidrome(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const body = req.url?.includes('getPlaylists')
      ? { 'subsonic-response': { status: 'ok', playlists: { playlist: [{ id: NEW_PL, name: 'Sunset Drive' }] } } }
      : { 'subsonic-response': { status: 'ok' } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-rotation-'));
  process.env.STATE_DIR = stateDir;
  // Hermetic: never let the dev box's real Navidrome answer. The fake below is
  // the only server this test talks to.
  const { server, url } = await fakeNavidrome();
  process.env.NAVIDROME_URL = url;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';

  // ---- seed the id-keyed state files (pre-rotation shapes) -----------------
  writeFileSync(join(stateDir, 'blocklist.json'), JSON.stringify({
    entries: [
      { type: 'track', id: OLD_TRACK, name: 'Blocked Song', artist: 'A', album: 'B', addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'track', id: UNMAPPED_TRACK, name: 'Unknown Song', artist: 'C', album: 'D', addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'album', id: OLD_TRACK2, name: 'Blocked Album', artist: 'E', album: null, addedAt: '2026-07-01T00:00:00.000Z' },
      { type: 'artist', id: FIXED_ARTIST, name: 'Blocked Artist', artist: null, album: null, addedAt: '2026-07-01T00:00:00.000Z' },
    ],
    // Rules carry ids too (#1300 FR 1). Exactly one field does — `playlist`,
    // whose values are Navidrome playlist ids. A stale one is INERT by design
    // (empty member set → the rule silently blocks nothing), so a rotation
    // that skipped rules would quietly switch a never-play rule off.
    rules: [
      {
        id: 'rule-playlist', label: 'Christmas songs', field: 'playlist',
        values: [OLD_PL], season: null, showIds: [], addedAt: '2026-07-01T00:00:00.000Z',
      },
      // Every other field is free text. A genre that happens to look like an
      // id must come through untouched.
      {
        id: 'rule-genre', label: 'No spoken word', field: 'genre',
        values: ['Spoken Word', OLD_TRACK2], season: null, showIds: [],
        addedAt: '2026-07-01T00:00:00.000Z',
      },
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
    shows: [{ name: 'Test Show', personaId, playlistIds: [OLD_PL], excludedPlaylistIds: [DEAD_PL] }],
  });

  const result = await rotation.applyPendingRotation();

  console.log('state-file migration after a confirmed rotation:');

  await test('reports having applied and fully consumed the manifest', () => {
    assert.equal(result.applied, true);
    assert.equal(result.complete, true, 'the playlist index answered, so nothing is deferred');
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

  await test('blocklist: playlist RULE ids remap; free-text rule values do not', async () => {
    const raw = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
    const byId = Object.fromEntries(
      raw.rules.map((r: { id: string; values: string[] }) => [r.id, r.values]),
    );
    assert.deepEqual(byId['rule-playlist'], [NEW_PL], 'a playlist rule follows its playlist');
    // Same string, different field: `genre` values are operator text, not ids.
    assert.deepEqual(byId['rule-genre'], ['Spoken Word', OLD_TRACK2]);
    // …and the in-memory compiled rules moved with the file.
    assert.deepEqual(
      blocklist.listRules().find((r) => r.id === 'rule-playlist')?.values,
      [NEW_PL],
    );
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
    // Its canonical image is not in the live index, so it is a DELETED playlist,
    // not a rotated one — leave it alone rather than point it somewhere new.
    assert.deepEqual(show.excludedPlaylistIds, [DEAD_PL]);
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
    assert.equal(again.complete, true);
  });

  // ---- Navidrome unreachable: defer the playlist half, keep the manifest ----
  console.log('\nwith the playlist index unreachable:');

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // A fresh rotation: one more track pair, and the show is re-pinned to an
  // un-rotated uuid so there IS a playlist decision to get wrong.
  const OLD_TRACK3 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const NEW_TRACK3 = '4V7sy1hL4SujOBMYLPtQuk';
  await settings.update({
    shows: [{ name: 'Test Show', personaId, playlistIds: [OLD_PL], excludedPlaylistIds: [] }],
  });
  await blocklist.add({ type: 'track', id: OLD_TRACK3, name: 'Later Block' });
  writeFileSync(join(stateDir, 'id-rotation.json'), JSON.stringify({
    version: 1,
    at: '2026-08-01T00:00:00.000Z',
    trackMap: { [OLD_TRACK3]: NEW_TRACK3 },
  }));

  const deferred = await rotation.applyPendingRotation();

  await test('the track half still lands', () => {
    assert.equal(deferred.applied, true);
    const raw = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
    const byName = Object.fromEntries(raw.entries.map((e: { name: string; id: string }) => [e.name, e.id]));
    assert.equal(byName['Later Block'], NEW_TRACK3);
  });

  await test('the playlist half is deferred, not guessed', () => {
    assert.equal(deferred.complete, false);
    const show = settings.get().shows.find((s: { name: string }) => s.name === 'Test Show');
    assert.deepEqual(show.playlistIds, [OLD_PL], 'no unvalidated rewrite');
  });

  await test('the manifest survives for the next attempt', () => {
    assert.equal(existsSync(join(stateDir, 'id-rotation.json')), true);
    // …and re-running it is harmless: the track ids it names are already gone
    // from the state files, so the track half is a no-op the second time.
    const raw = JSON.parse(readFileSync(join(stateDir, 'id-rotation.json'), 'utf8'));
    assert.deepEqual(raw.trackMap, { [OLD_TRACK3]: NEW_TRACK3 });
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
