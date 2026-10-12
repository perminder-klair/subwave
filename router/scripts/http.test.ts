// The router as the controller, Liquidsoap and the analyzer see it: Subsonic
// over HTTP, the internal API, config reloads, and the failure statuses the
// station's downloaders depend on.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configWith, startRouter, type RunningRouter } from './helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

let r: RunningRouter;

before(async () => {
  r = await startRouter({ pluginsDir: FIXTURES });
});

after(async () => {
  await r.close();
});

async function reload(): Promise<any> {
  const resp = await r.internal('/reload', { method: 'POST' });
  assert.equal(resp.status, 200);
  return resp.json();
}

test('with no config the router serves nothing and refuses every login', async () => {
  const health = (await (await fetch(`${r.base}/health`)).json()) as any;
  assert.deepEqual(health.serving, null);
  const ping = await r.rest('ping');
  assert.equal(ping.status, 'failed');
  assert.equal(ping.error.code, 40);
  // The binary endpoints never answer an error with 200.
  const stream = await fetch(`${r.base}/rest/stream?${r.auth()}&id=x`);
  assert.equal(stream.status, 401);
});

test('the internal API needs the router credentials', async () => {
  r.writeConfig(configWith([{ plugin: 'mock' }]));
  const anon = await fetch(`${r.base}/internal/status`);
  assert.equal(anon.status, 401);
  const status = await reload();
  assert.equal(status.configured, true);
  assert.deepEqual(status.active.map((a: any) => a.plugin), ['mock']);
  assert.equal(status.active[0].health.state, 'healthy');
  assert.equal(status.active[0].health.stats.songs, 261);
  // Broken fixtures are listed with their reasons, built-ins without errors.
  const byName = new Map(status.plugins.map((p: any) => [p.name, p]));
  assert.equal((byName.get('jellyfin') as any).error, null);
  assert.match((byName.get('old-api') as any).error, /plugin API v99/);
});

test('the demo library is reported devOnly, and is still selectable and served', async () => {
  r.writeConfig(configWith([{ plugin: 'mock' }]));
  const status = await reload();
  // Built-ins and the working fixture only: the clash-name fixture also calls itself `mock`.
  const listed = status.plugins.filter((p: any) => p.builtin || p.name === 'good');
  const devOnly = Object.fromEntries(listed.map((p: any) => [p.name, p.devOnly]));
  assert.equal(devOnly.mock, true);
  for (const name of ['navidrome', 'jellyfin', 'plex', 'good']) assert.equal(devOnly[name], false, `${name} is not devOnly`);
  // Hiding it is the station's job: the router builds, serves and tests it as before.
  assert.deepEqual(status.active.map((a: any) => a.plugin), ['mock']);
  assert.equal(status.serving.name, 'mock');
  const random = await r.rest('getRandomSongs', { size: 2 });
  assert.equal(random.randomSongs.song.length, 2);
  const tested = (await (await r.internal('/test', { method: 'POST', body: JSON.stringify({ plugin: 'mock' }) })).json()) as any;
  assert.equal(tested.ok, true);
});

test('Subsonic auth: wrong credentials are code 40, wrong user too', async () => {
  const resp = await fetch(`${r.base}/rest/ping?${r.auth('subwave', 'wrong-password-xxxxxxxx')}`);
  const body = ((await resp.json()) as any)['subsonic-response'];
  assert.equal(resp.status, 200);
  assert.equal(body.error.code, 40);
  const other = await fetch(`${r.base}/rest/ping?${r.auth('admin')}`);
  assert.equal(((await other.json()) as any)['subsonic-response'].error.code, 40);
  const ok = await r.rest('ping');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.type, 'subwave-router');
  assert.match(ok.serverVersion, /\(mock\)/);
});

test('browsing returns namespaced ids that resolve back', async () => {
  const random = await r.rest('getRandomSongs', { size: 3 });
  const song = random.randomSongs.song[0];
  assert.match(song.id, /^mock-[0-9a-f]{32}$/);
  const got = await r.rest('getSong', { id: song.id });
  assert.equal(got.song.id, song.id);
  const album = await r.rest('getAlbum', { id: song.albumId });
  assert.ok(album.album.song.some((s: any) => s.id === song.id));
  const unknown = await r.rest('getSong', { id: 'mock-0000' });
  assert.equal(unknown.error.code, 70);
  const foreign = await r.rest('getSong', { id: 'jf-abc' });
  assert.equal(foreign.error.code, 70);
});

test('getArtists groups the library by initial, as getLibraryArtists parses it', async () => {
  const body = await r.rest('getArtists');
  const index = body.artists.index;
  assert.ok(index.length > 3);
  for (const group of index) for (const a of group.artist) assert.ok(a.id && a.name);
  assert.ok(index.flatMap((g: any) => g.artist).some((a: any) => a.name === 'Neon Harbor'));
});

test('search3 honours counts and offsets', async () => {
  const page1 = await r.rest('search3', { query: '', songCount: 5, songOffset: 0, artistCount: 1, albumCount: 1 });
  const page2 = await r.rest('search3', { query: '', songCount: 5, songOffset: 5, artistCount: 1, albumCount: 1 });
  assert.equal(page1.searchResult3.song.length, 5);
  assert.equal(page1.searchResult3.artist.length, 1);
  const ids = new Set(page1.searchResult3.song.map((s: any) => s.id));
  assert.ok(page2.searchResult3.song.every((s: any) => !ids.has(s.id)));
});

test('stream: audio for a known id, 404 for an unknown one', async () => {
  const song = (await r.rest('getRandomSongs', { size: 1 })).randomSongs.song[0];
  const ok = await fetch(`${r.base}/rest/stream?${r.auth()}&id=${song.id}&format=raw`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'audio/wav');
  assert.ok((await ok.arrayBuffer()).byteLength > 4096);
  const missing = await fetch(`${r.base}/rest/stream?${r.auth()}&id=mock-nope`);
  assert.equal(missing.status, 404);
});

test('cover art by song id, and lyrics', async () => {
  const song = (await r.rest('getRandomSongs', { size: 1 })).randomSongs.song[0];
  const art = await fetch(`${r.base}/rest/getCoverArt?${r.auth()}&id=${song.id}&size=64`);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/png');
  const noArt = await fetch(`${r.base}/rest/getCoverArt?${r.auth()}&id=mock-nope`);
  assert.equal(noArt.status, 404);
  const lyr = await r.rest('getLyricsBySongId', { id: song.id });
  assert.equal(lyr.status, 'ok');
});

test('scan status, scrobble and stars round-trip', async () => {
  const scan = await r.rest('getScanStatus');
  assert.deepEqual(scan.scanStatus, { scanning: false, count: 261 });
  const song = (await r.rest('getRandomSongs', { size: 1 })).randomSongs.song[0];
  assert.equal((await r.rest('scrobble', { id: song.id, submission: 'true' })).status, 'ok');
  assert.equal((await r.rest('getSong', { id: song.id })).song.playCount, song.playCount + 1);
  await r.rest('star', { id: song.id });
  assert.ok((await r.rest('getStarred2')).starred2.song.some((s: any) => s.id === song.id));
  assert.ok((await r.rest('getSong', { id: song.id })).song.starred);
  await r.rest('unstar', { id: song.id });
  assert.ok(!(await r.rest('getStarred2')).starred2.song.some((s: any) => s.id === song.id));
});

test('playlists: create with songs, append, remove by index, delete', async () => {
  const songs = (await r.rest('getRandomSongs', { size: 3 })).randomSongs.song.map((s: any) => s.id);
  const created = await r.rest('createPlaylist', { name: 'Test list', songId: songs.slice(0, 2) });
  const id = created.playlist.id;
  assert.match(id, /^mock-pl-\d+$/);
  assert.equal(created.playlist.entry.length, 2);
  await r.rest('updatePlaylist', { playlistId: id, songIdToAdd: songs[2], songIndexToRemove: '0' });
  const after = await r.rest('getPlaylist', { id });
  assert.deepEqual(after.playlist.entry.map((s: any) => s.id), [songs[1], songs[2]]);
  assert.equal((await r.rest('deletePlaylist', { id })).status, 'ok');
  assert.equal((await r.rest('getPlaylist', { id })).error.code, 70);
});

test('formPost: a POSTed form is read like a query string', async () => {
  const song = (await r.rest('getRandomSongs', { size: 1 })).randomSongs.song[0];
  const resp = await fetch(`${r.base}/rest/getSong`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `${r.auth()}&id=${song.id}`,
  });
  const body = ((await resp.json()) as any)['subsonic-response'];
  assert.equal(body.song.id, song.id);
});

test('an unknown endpoint is a Subsonic error, not a crash', async () => {
  const body = await r.rest('getNowPlaying');
  assert.equal(body.status, 'failed');
  assert.match(body.error.message, /not implemented/);
});

test('a bad selection is refused whole and the running source keeps serving', async () => {
  r.writeConfig(configWith([{ plugin: 'does-not-exist' }]));
  const status = await reload();
  assert.match(status.configError, /no music-source plugin named 'does-not-exist'/);
  assert.equal((await r.rest('ping')).serverVersion.includes('mock'), true);
  r.writeConfig(configWith([{ plugin: 'good' }]));
  const missing = await reload();
  assert.match(missing.configError, /missing required settings: greeting/);
  assert.equal((await r.rest('ping')).serverVersion.includes('mock'), true);
  r.writeConfig(configWith([{ plugin: 'mock' }, { plugin: 'good', config: { greeting: 'hi' } }]));
  assert.match((await reload()).configError, /merging is off/);
});

test('the config poll picks up a change without a nudge', async () => {
  r.writeConfig(configWith([{ plugin: 'good', config: { greeting: 'polled' } }]));
  for (let i = 0; i < 40; i++) {
    const ping = await r.rest('ping');
    if (ping.serverVersion?.includes('good')) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const album = await r.rest('getAlbum', { id: 'good-al1' });
  assert.equal(album.album.name, 'Fixture Album (polled)');
});

test('the media guard refuses a text body where audio was expected', async () => {
  r.writeConfig(configWith([{ plugin: 'json-stream' }]));
  await reload();
  const resp = await fetch(`${r.base}/rest/stream?${r.auth()}&id=js-x1`);
  assert.equal(resp.status, 502);
  const body = ((await resp.json()) as any)['subsonic-response'];
  assert.match(body.error.message, /refused a application\/json body/);
});

// #1827 review: a client that gave up while stream() was still waiting on the
// backend left the handler writing into a closed response forever, and its
// body — a fetch body or a file stream — open with it. Liquidsoap and the
// analyzer abandon streams routinely.
test('a client that leaves early releases the body, before or after the first byte', async () => {
  const counts = ((globalThis as any).__slowStream ??= { opened: 0, closed: 0 });
  const settle = async () => {
    for (let i = 0; i < 40 && counts.closed < counts.opened; i++) await new Promise((ok) => setTimeout(ok, 50));
  };
  for (const kind of ['web', 'node']) {
    r.writeConfig(configWith([{ plugin: 'slow-stream', config: { delayMs: 300, kind } }]));
    await reload();
    const url = `${r.base}/rest/stream?${r.auth()}&id=slow-s1`;

    // Gone before stream() resolved: 'close' had already fired.
    const early = new AbortController();
    const pending = fetch(url, { signal: early.signal }).catch(() => undefined);
    setTimeout(() => early.abort(), 100);
    await pending;
    await new Promise((ok) => setTimeout(ok, 400));
    await settle();
    assert.equal(counts.closed, counts.opened, `${kind}: a body opened after the client left is released`);

    // Gone mid-body, while the response is backpressured.
    const mid = new AbortController();
    const resp = await fetch(url, { signal: mid.signal });
    assert.equal(resp.status, 200);
    await resp.body!.getReader().read();
    mid.abort();
    await settle();
    assert.equal(counts.closed, counts.opened, `${kind}: the body is released when the client hangs up`);
  }
  assert.equal(counts.opened, 4);
});

// #1827 review: reloads ran concurrently. A slow build of an older selection
// that finished last swapped it in after the newer one, and nothing re-read
// config.json to put it right.
test('reloads apply in order: the newest config.json wins', async () => {
  // Imported here, after startRouter set ROUTER_DIR: config.ts reads it at import.
  const { activeEntries, reloadConfig } = await import('../src/host/registry.js');
  r.writeConfig(configWith([{ plugin: 'slow-factory', config: { delayMs: 400 } }]));
  const first = reloadConfig();
  await new Promise((ok) => setTimeout(ok, 20));
  r.writeConfig(configWith([{ plugin: 'mock' }]));
  await Promise.all([first, reloadConfig()]);
  assert.deepEqual(activeEntries().map((e) => e.plugin), ['mock']);
  assert.match((await r.rest('ping')).serverVersion, /\(mock\)/);
});

test('ids that cannot be published are dropped; packed ids round-trip', async () => {
  r.writeConfig(configWith([{ plugin: 'odd-ids' }]));
  await reload();
  const songs = (await r.rest('getRandomSongs', { size: 10 })).randomSongs.song;
  assert.deepEqual(songs.map((s: any) => s.title).sort(), ['Numeric id', 'Path id']);
  const packed = songs.find((s: any) => s.title === 'Path id');
  assert.match(packed.id, /^odd_[\w-]+$/);
  assert.equal((await r.rest('getSong', { id: packed.id })).song.title, 'Path id');
  assert.deepEqual((await r.rest('getGenres')).genres.genre.map((g: any) => g.value), ['Jazz', 'Rock']);
  // A plugin with no scanStatus does not claim "not scanning".
  assert.equal((await r.rest('getScanStatus')).status, 'failed');
});

test('POST /internal/test reports a draft selection without swapping', async () => {
  r.writeConfig(configWith([{ plugin: 'mock' }]));
  await reload();
  const missing = (await (await r.internal('/test', { method: 'POST', body: JSON.stringify({ plugin: 'good', config: {} }) })).json()) as any;
  assert.equal(missing.state, 'not-configured');
  assert.deepEqual(missing.missing, ['greeting']);
  const ok = (await (await r.internal('/test', { method: 'POST', body: JSON.stringify({ plugin: 'good', config: { greeting: 'x' } }) })).json()) as any;
  assert.equal(ok.ok, true);
  assert.equal(ok.state, 'healthy');
  assert.equal(ok.capabilities.stars, false);
  const unreachable = (await (await r.internal('/test', {
    method: 'POST',
    body: JSON.stringify({ plugin: 'jellyfin', config: { url: 'http://127.0.0.1:9', apiKey: 'k' } }),
  })).json()) as any;
  assert.equal(unreachable.state, 'unreachable');
  assert.match(unreachable.error, /could not connect|ECONNREFUSED/);
  // Still serving the saved selection.
  assert.match((await r.rest('ping')).serverVersion, /\(mock\)/);
});

test('merge: two sources answer as one library, each id routed to its owner', async () => {
  r.writeConfig(configWith([{ plugin: 'mock' }, { plugin: 'good', config: { greeting: 'merged' } }], { merge: true }));
  const status = await reload();
  assert.equal(status.configError, null);
  assert.deepEqual(status.active.map((a: any) => a.plugin), ['mock', 'good']);
  assert.equal((await r.rest('getSong', { id: 'good-s1' })).song.title, 'Song 1');
  const mockSong = (await r.rest('search3', { query: 'neon', songCount: 1 })).searchResult3.song[0];
  assert.match(mockSong.id, /^mock-/);
  assert.equal((await r.rest('getSong', { id: mockSong.id })).song.id, mockSong.id);
  const hits = (await r.rest('search3', { query: 'song', songCount: 50 })).searchResult3.song.map((s: any) => s.id);
  assert.ok(hits.includes('good-s1'));
  const genres = (await r.rest('getGenres')).genres.genre.map((g: any) => g.value);
  assert.ok(genres.includes('Test') && genres.includes('Synthwave'));
});
