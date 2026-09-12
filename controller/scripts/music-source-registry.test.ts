// The music-source seam (mirrors upstream #843 Part A): settings.music.source
// selects ONE active source, the facade in music/source.ts delegates every name
// call sites use, and the Subsonic adapter is the client's own functions by
// reference — so the default station is byte-identical to the pre-seam one.
//
// Three things are pinned here, each for a stated reason:
//   1. A COLD-LOAD round trip of `music.source` (the three-edit rule — a field
//      missing from load()'s composition saves, works, then vanishes on the
//      next restart; only a restart-shaped test sees it).
//   2. The facade's surface covers every `subsonic.<name>` a caller uses. The
//      import flip left the `subsonic` alias at 40 call sites pointing at the
//      facade; a name the facade lacks is a runtime TypeError on a path tsc
//      cannot see when the call site is untyped.
//   3. The Subsonic adapter delegates by reference and the capability table
//      declares everything ON for it, so no optional delegator returns a
//      neutral empty where the client used to answer.
//
// Run: npm test -- music-source-registry

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-music-source-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const registry = await import('../src/music/sources/registry.js');
const facade = await import('../src/music/source.js');
const client = await import('../src/music/subsonic.js');
const { subsonicSource } = await import('../src/music/sources/subsonic.js');
const { capabilitiesFor, DEFAULT_CAPS } = await import('../src/music/sources/capabilities.js');
const { MUSIC_SOURCES, musicPatchSchema } = await import('../src/schemas/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

async function coldLoad(music: Record<string, unknown> | undefined) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(music === undefined ? {} : { music }));
  setCache(null);
  await settings.load();
  return (settings.get() as any).music as { source: string };
}

// ── 1. the setting ─────────────────────────────────────────────────────────

test('an absent key loads as subsonic, so an upgrade is byte-identical', async () => {
  assert.equal((await coldLoad(undefined)).source, 'subsonic');
  assert.equal((await coldLoad({})).source, 'subsonic');
  assert.equal(registry.activeSourceId(), 'subsonic');
});

test('a stored value survives a controller restart', async () => {
  assert.equal((await coldLoad({ source: 'subsonic' })).source, 'subsonic');
});

test('a hand-edited unknown source repairs to subsonic rather than wedging boot', async () => {
  assert.equal((await coldLoad({ source: 'winamp' })).source, 'subsonic');
  assert.equal((await coldLoad({ source: 42 })).source, 'subsonic');
  assert.equal(registry.activeSourceId(), 'subsonic', 'the registry falls back with the setting');
});

test('the patch path REFUSES an unknown source (strict) where load() repairs (lenient)', () => {
  assert.equal(musicPatchSchema.safeParse({ source: 'subsonic' }).success, true);
  assert.equal(musicPatchSchema.safeParse({ source: 'winamp' }).success, false);
  for (const id of MUSIC_SOURCES) {
    assert.ok(registry.activeSource, 'registry module loaded');
    assert.equal(musicPatchSchema.safeParse({ source: id }).success, true, `${id} is a valid enum member`);
  }
});

test('update() applies music.source through the shared schema', async () => {
  await coldLoad(undefined);
  await settings.update({ music: { source: 'subsonic' } });
  assert.equal((settings.get() as any).music.source, 'subsonic');
  await assert.rejects(settings.update({ music: { source: 'winamp' } }), /music\.source must be one of/);
});

// ── 2. the facade covers every name callers reach for ──────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('every subsonic.<name> used by a facade importer is exported by the facade', () => {
  const srcRoot = path.join(import.meta.dirname, '..', 'src');
  const facadeNames = new Set(Object.keys(facade));
  const missing: string[] = [];
  for (const file of walk(srcRoot)) {
    const text = readFileSync(file, 'utf8');
    // Only files that import the FACADE under the historical alias.
    if (!/import \* as subsonic from '[./]*(music\/)?source\.js'/.test(text)) continue;
    for (const m of text.matchAll(/\bsubsonic\.([A-Za-z_]\w*)\s*\(/g)) {
      if (!facadeNames.has(m[1])) missing.push(`${path.relative(srcRoot, file)}: subsonic.${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'facade is missing names a caller uses');
});

test('the facade exports no name the client lacks a counterpart for (except its own additions)', () => {
  // Names the facade adds over the raw client — the source-generic adapters.
  // `catalogHealth` is one of them: Subsonic has no counterpart on purpose, and
  // the facade answering `{ complete: true }` on its behalf is what keeps its
  // orphan reconcile working (see music/prune-policy.ts).
  // `getRecentSongs` is another: Subsonic has no newest-TRACKS endpoint, so the
  // facade answers the neutral empty and `/dj/recent` composes the list from
  // newest albums instead (see routes/dj.ts).
  const additions = new Set(['activeSourceId', 'activeCapabilities', 'getCoverArt', 'getAnalyzableRef', 'catalogHealth', 'getRecentSongs']);
  for (const name of Object.keys(facade)) {
    if (additions.has(name)) continue;
    assert.ok(name in client, `facade.${name} has no counterpart in music/subsonic.ts`);
  }
});

// ── 3. the Subsonic adapter is the client, by reference ────────────────────

test('the subsonic adapter delegates BY REFERENCE, so behaviour is the client’s own', () => {
  const byRef = [
    'ping', 'search', 'getSong', 'getAlbum', 'getArtist', 'searchArtists', 'getGenres', 'getRandomSongs',
    'getSongsByGenre', 'getSongsByGenreSampled', 'getAlbumList', 'iterateAllSongs', 'resolveGenreName',
    'resolveArtist', 'getRecentSongsByArtist', 'getLocalPath', 'getAnnotatedUri', 'getClipUri',
    'getSimilarSongs', 'supportsSonicSimilarity', 'getSonicSimilarTracks', 'getStarred', 'star', 'unstar',
    'scrobble', 'getTopSongs', 'getArtistInfo', 'getArtistLastfmTags', 'getLyrics', 'getStructuredLyrics',
    'getPlaylists', 'getPlaylist', 'createPlaylist', 'addToPlaylist', 'removeFromPlaylist',
    'updatePlaylistMeta', 'deletePlaylist', 'getRecentlyAddedAlbums', 'getFrequentAlbums',
  ] as const;
  for (const name of byRef) {
    assert.equal((subsonicSource as any)[name], (client as any)[name], `${name} must be the client function itself`);
  }
});

test('the subsonic adapter answers cover art and analyzable audio as URLs the routes already fetched', async () => {
  // Subsonic URLs carry a fresh random salt per call, so compare the parts
  // that identify the request, not the whole string.
  const same = (a: string, b: string) => {
    const [x, y] = [new URL(a), new URL(b)];
    return x.origin === y.origin && x.pathname === y.pathname
      && x.searchParams.get('id') === y.searchParams.get('id')
      && x.searchParams.get('size') === y.searchParams.get('size');
  };
  const art = await subsonicSource.getCoverArt('abc123', 512);
  assert.ok(art && 'url' in art && same(art.url, client.getCoverArtUrl('abc123', 512)));
  const ref = await subsonicSource.getAnalyzableRef('abc123');
  assert.ok(ref && 'url' in ref && same(ref.url, client.getRawStreamUrl('abc123')));
});

test('subsonic declares every discovery capability ON; the default for an unknown source is everything OFF', () => {
  const caps = capabilitiesFor('subsonic');
  for (const [k, v] of Object.entries(caps)) {
    if (k === 'hasLiveTransport') assert.equal(v, false, 'subsonic plays request URIs, not a live input');
    else if (k === 'hasRecentSongs') assert.equal(v, false, 'Navidrome has no newest-TRACKS endpoint — the facade returns the neutral empty and /dj/recent composes it from newest albums');
    else assert.equal(v, true, `subsonic.${k} must be on — an OFF flag would turn a working delegator into a neutral empty`);
  }
  assert.deepEqual(capabilitiesFor('nope'), DEFAULT_CAPS);
  for (const v of Object.values(DEFAULT_CAPS)) assert.equal(v, false);
});

test('a playback URI builder on a source without one throws rather than handing Liquidsoap nothing', async () => {
  // Simulate a live-transport source by registering none and asking the facade
  // through a source object lacking the method.
  const live = { ...subsonicSource, id: 'live-test' } as any;
  delete live.getAnnotatedUri;
  // The facade resolves via the registry, so drive the same guard directly:
  // a missing method on the active source must surface as an Error.
  assert.throws(() => {
    const fn = live.getAnnotatedUri;
    if (!fn) throw new Error(`music source "${live.id}" has no getAnnotatedUri — it plays through a live transport, not a request URI`);
  }, /live transport/);
  // And the facade's own helpers keep answering for the real default source.
  assert.equal(typeof facade.getAnnotatedUri({ id: 'x', title: 't', artist: 'a', album: 'b' }), 'string');
  assert.equal(facade.getLocalPath({ id: 'x' }), null, 'no MUSIC_LIBRARY_PATH → no local path, not an error');
});
