// The controller's Subsonic client against the real SUB/WAVE music router
// (#692). music/subsonic.ts is the spec the router was written to; this test
// keeps the two honest by driving every export the station uses against a
// live router serving its deterministic demo library — not a stub.
//
// Needs the router's dependencies: `npm --prefix router install` (or `ci`).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { startRouterProcess } from './test-utils/router-process.js';

const USER = 'subwave';
const PASS = 'contract-test-password-0123';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-router-contract-'));
const routerDir = join(stateRoot, 'router');
mkdirSync(routerDir, { recursive: true });
writeFileSync(
  join(routerDir, 'config.json'),
  JSON.stringify({ version: 1, auth: { user: USER, pass: PASS }, merge: false, sources: [{ plugin: 'mock', config: {} }] }),
);
const routerProc = await startRouterProcess(routerDir);
const port = routerProc.port;

after(() => {
  routerProc.stop();
  rmSync(stateRoot, { recursive: true, force: true });
});

process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = USER;
process.env.NAVIDROME_PASS = PASS;

const subsonic = await import('../src/music/subsonic.js');

// One known song, album and artist from the demo library, resolved once.
const seed = (await subsonic.search('Neon Harbor', { songCount: 1 }))[0];

test('connection: ping and the connection test both authenticate', async () => {
  assert.deepEqual(await subsonic.ping(), { ok: true });
  const probe = await subsonic.pingWith({ url: process.env.NAVIDROME_URL!, user: USER, pass: PASS });
  assert.equal(probe.ok, true);
  assert.equal(probe.serverType, 'subwave-router');
  const wrong = await subsonic.pingWith({ url: process.env.NAVIDROME_URL!, user: USER, pass: 'nope' });
  assert.equal(wrong.ok, false);
});

test('search, random songs (with era bounds) and genres', async () => {
  assert.ok(seed?.id?.startsWith('mock-'), 'search returned a namespaced song');
  assert.equal(seed.artist, 'Neon Harbor');
  const page = await subsonic.search('', { songCount: 5, songOffset: 5 });
  assert.equal(page.length, 5);
  const era = await subsonic.getRandomSongs({ size: 20, fromYear: 1990, toYear: 1999 });
  assert.ok(era.length > 0);
  assert.ok(era.every((s: any) => s.year >= 1990 && s.year <= 1999));
  const genres = await subsonic.getGenres();
  assert.ok(genres.some((g: any) => g.value === 'Synthwave' && g.songCount > 0));
  assert.equal(await subsonic.resolveGenreName('synthwave'), 'Synthwave');
  const byGenre = await subsonic.getSongsByGenre('Synthwave', { count: 3 });
  assert.equal(byGenre.length, 3);
  assert.ok((await subsonic.getSongsByGenreSampled('Ambient', { count: 4 })).length > 0);
  // songGenres reads the OpenSubsonic multi-genre list the router sends.
  assert.deepEqual(subsonic.songGenres(seed), ['Synthwave', 'Electronic']);
});

test('lookups: song, album (with era fields), artist, artist search', async () => {
  const song = await subsonic.getSong(seed.id);
  assert.equal(song.id, seed.id);
  assert.ok(song.replayGain && typeof song.replayGain.trackGain === 'number', 'replayGain survives the router');
  const albumSongs = await subsonic.getAlbum(seed.albumId);
  assert.ok(albumSongs.some((s: any) => s.id === seed.id));
  const artist = await subsonic.getArtist(seed.artistId);
  assert.equal(artist.name, 'Neon Harbor');
  assert.ok(artist.album.length >= 1);
  const resolved = await subsonic.resolveArtist('neon harbour');
  assert.equal(resolved?.name, 'Neon Harbor', 'fuzzy artist resolution works over search3');
  const found = await subsonic.searchArtists('Velvet');
  assert.ok(found.some((a: any) => a.name === 'Velvet Antenna'));
  const libraryArtists = await subsonic.getLibraryArtists();
  assert.ok(libraryArtists.length >= 17, 'getArtists parses');
  await assert.rejects(subsonic.getSong('mock-0000'), /not found/i);
});

test('discovery: similar, sonic similarity, top songs, artist info, recent by artist', async () => {
  assert.equal((await subsonic.getSimilarSongs(seed.id, { count: 5 })).length, 5);
  assert.equal(await subsonic.supportsSonicSimilarity(), true);
  const sonic = await subsonic.getSonicSimilarTracks(seed.id, { count: 3 });
  assert.equal(sonic.length, 3);
  assert.ok(sonic[0].entry?.id || sonic[0].id);
  assert.ok((await subsonic.getTopSongs('Neon Harbor', { count: 3 })).length > 0);
  const info = await subsonic.getArtistInfo(seed.artistId);
  assert.ok(info?.similarArtist?.length > 0);
  assert.ok((await subsonic.getArtistLastfmTags(seed.artistId)).length > 0);
  assert.ok((await subsonic.getRecentSongsByArtist('Neon Harbor', { albums: 1, count: 3 })).length > 0);
  assert.ok((await subsonic.getRecentlyAddedAlbums({ size: 3 })).length === 3);
  assert.ok((await subsonic.getFrequentAlbums({ size: 3 })).length === 3);
});

test('the full library walk carries every era signal', async () => {
  const songs: any[] = [];
  for await (const s of subsonic.iterateAllSongs({ requireComplete: true })) songs.push(s);
  assert.equal(songs.length, 261);
  assert.equal(new Set(songs.map((s) => s.id)).size, 261);
  assert.ok(songs.some((s) => s.albumIsCompilation === true), 'the compilation flag arrives');
  assert.ok(songs.some((s) => Number.isFinite(s.albumOriginalYear)), 'reissue years arrive');
  assert.ok(songs.every((s) => s.albumId));
});

test('stars, scrobble and scan status', async () => {
  await subsonic.star(seed.id);
  assert.ok((await subsonic.getStarred()).some((s: any) => s.id === seed.id));
  await subsonic.unstar(seed.id);
  assert.ok(!(await subsonic.getStarred()).some((s: any) => s.id === seed.id));
  const before = (await subsonic.getSong(seed.id)).playCount;
  await subsonic.scrobble(seed.id, { submission: true, timeMs: Date.now() });
  assert.equal((await subsonic.getSong(seed.id)).playCount, before + 1);
  assert.equal(await subsonic.getScanStatus(), false);
});

test('lyrics: plain and structured', async () => {
  // About a third of demo tracks have lyrics; find one.
  const pool = await subsonic.getRandomSongs({ size: 60 });
  let found = false;
  for (const s of pool) {
    const text = await subsonic.getLyrics(s.id);
    if (!text) continue;
    const structured = await subsonic.getStructuredLyrics(s.id);
    assert.ok(structured && structured.lines.length > 0);
    found = true;
    break;
  }
  assert.ok(found, 'some track had lyrics');
});

test('playlists: create, overwrite, append, remove, rename, delete', async () => {
  const songs = (await subsonic.getRandomSongs({ size: 4 })).map((s: any) => s.id);
  const created = await subsonic.createPlaylist('Contract test', songs.slice(0, 2));
  assert.ok(created.id);
  await subsonic.addToPlaylist(created.id, [songs[2]]);
  await subsonic.removeFromPlaylist(created.id, [0]);
  await subsonic.updatePlaylistMeta(created.id, { name: 'Contract test (renamed)', comment: 'c' });
  // getPlaylist returns the entries; the name lives on the getPlaylists row.
  assert.deepEqual((await subsonic.getPlaylist(created.id)).map((s: any) => s.id), [songs[1], songs[2]]);
  assert.equal((await subsonic.getPlaylists()).find((p: any) => p.id === created.id)?.name, 'Contract test (renamed)');
  await subsonic.createPlaylist('Contract test (renamed)', [songs[3]], { playlistId: created.id });
  assert.deepEqual((await subsonic.getPlaylist(created.id)).map((s: any) => s.id), [songs[3]]);
  assert.ok((await subsonic.getPlaylists()).some((p: any) => p.id === created.id));
  await subsonic.deletePlaylist(created.id);
  assert.ok(!(await subsonic.getPlaylists()).some((p: any) => p.id === created.id));
});

test('media URLs: cover art by song id, raw stream bytes, and the Liquidsoap URI', async () => {
  const art = await fetch(subsonic.getCoverArtUrl(seed.id, 128));
  assert.equal(art.status, 200);
  assert.match(art.headers.get('content-type') ?? '', /^image\//);
  const raw = await fetch(subsonic.getRawStreamUrl(seed.id));
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type') ?? '', /^audio\//);
  assert.ok((await raw.arrayBuffer()).byteLength > 4096, 'over the subhttp 4 KiB floor');
  const uri = subsonic.getAnnotatedUri(seed, { resolveProbeId: 'probe123' });
  assert.match(uri, /^annotate:/);
  assert.ok(uri.includes(`subsonic_id="${seed.id}"`), 'the frozen wire field carries the router id');
  assert.match(uri, /:subhttp:http:\/\/127\.0\.0\.1:\d+\/rest\/stream\?/);
  assert.match(uri, /#subwave_probe=probe123$/);
  // An unknown id never answers 200 — Liquidsoap and the analyzer write 200s to disk.
  const missing = await fetch(subsonic.getRawStreamUrl('mock-0000'));
  assert.equal(missing.status, 404);
});
