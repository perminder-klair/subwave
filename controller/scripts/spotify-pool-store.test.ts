// The persisted Spotify pool and the snapshot_id revalidate (pool-store.ts +
// the refresh paths in pool.ts).
//
// Every assertion here stands for requests the station used to spend against a
// rolling 30-second quota that Development Mode cannot buy its way out of:
//
//   • a RESTART costs nothing. The pool used to live only in memory, so every
//     controller restart re-walked every playlist and every saved track — ~100
//     back-to-back requests on a 5000-track pool, and Docker restart policies
//     made that a loop;
//   • a REFRESH revalidates rather than rebuilds. An unchanged `snapshot_id` is
//     Spotify's own statement that a playlist's contents did not move, and the
//     listing that carries it is already walked, so reusing on it is free;
//   • what is persisted is NOT the whole row: everything map.ts derives is
//     rebuilt on load, so those conventions have exactly one definition;
//   • a snapshot restored from disk must NOT be read as an authoritative
//     catalogue walk — the orphan reconcile deletes the tags, moods and vectors
//     of every track a walk did not yield (music/prune-policy.ts);
//   • the genre drip runs WITHOUT a rebuild and resumes on its own after a
//     rate-limit hold, which is the whole reason it was moved out of build().
//
// Run: npm test -- spotify-pool-store

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-pool-'));
process.env.STATE_DIR = stateRoot;

const { SpotifyPoolCache, POOL_TTL_MS, GENRE_DRIP_INTERVAL_MS } = await import('../src/music/sources/spotify/pool.js');
const store = await import('../src/music/sources/spotify/pool-store.js');
const { invalidateSpotifyReads } = await import('../src/music/sources/spotify/reads.js');

// The shared catalogue reads are memoised at module scope (see reads.ts), so
// every test starts cold or an earlier one answers its walk for free.
beforeEach(() => { invalidateSpotifyReads(); });

let seq = 0;
const freshPaths = () => {
  seq++;
  return {
    cache: path.join(stateRoot, `genres-${seq}.json`),
    snapshot: path.join(stateRoot, `pool-${seq}.json`),
  };
};

// Move the pool's injected clock, and drop the shared catalogue reads with it.
// Those memos (reads.ts) keep their own five-minute TTL on the REAL clock, which
// a fake one cannot move — in production a 30-minute pool refresh always outruns
// them, so this is what the passage of that time actually looks like.
const advanceBy = (ms: number, bump: (ms: number) => void) => { bump(ms); invalidateSpotifyReads(); };

const cfg = (over: Record<string, unknown> = {}) => () => ({
  playlistIds: [] as string[],
  includeSaved: false,
  includeSavedAlbums: false,
  maxTracks: 5000,
  fullWalkHours: 24,
  genresPerHour: 0,
  ...over,
} as any);

const artist = (id: string, name: string) => ({ id, name });
const album = (id: string, name: string, extra: any = {}) => ({ id, name, release_date: '1994-08-22', images: [{ url: `http://img/${id}`, width: 640 }], artists: [artist('ar1', 'Portishead')], ...extra });
const track = (id: string, name: string, extra: any = {}) => ({ id, name, duration_ms: 300_000, artists: [artist('ar1', 'Portishead')], album: album('al1', 'Dummy'), uri: `spotify:track:${id}`, ...extra });

const T1 = 'AAAAAAAAAAAAAAAAAAAAAA';
const T2 = 'BBBBBBBBBBBBBBBBBBBBBB';
const T3 = 'CCCCCCCCCCCCCCCCCCCCCC';

// A client stub that records every call and lets a test move a playlist's
// snapshot_id — which is the entire mechanism under test.
function fakeClient(opts: { snapshotId?: string; items?: any[]; limitedMs?: number } = {}) {
  const calls: string[] = [];
  const state = {
    snapshotId: opts.snapshotId ?? 'snap-1',
    items: opts.items ?? [
      { item: track(T1, 'Glory Box'), added_at: '2024-01-01T00:00:00Z' },
      { item: track(T2, 'Roads'), added_at: '2024-02-01T00:00:00Z' },
    ],
    limitedMs: opts.limitedMs ?? 0,
  };
  const client: any = {
    async getMyPlaylists() {
      calls.push('playlists');
      return { items: [{ id: 'PL1', name: 'Night', items: { total: 2 }, snapshot_id: state.snapshotId }], next: null };
    },
    async getPlaylist(id: string) { calls.push(`playlist:${id}`); return { id, name: `ext ${id}`, items: { total: 1 } }; },
    async getPlaylistItems() { calls.push('items:PL1'); return { items: state.items, next: null }; },
    async getSavedTracks({ limit }: any = {}) {
      calls.push(limit === 1 ? 'saved-probe' : 'saved');
      return { items: [{ track: track(T3, 'Sour Times'), added_at: '2023-01-01T00:00:00Z' }], total: 1, next: null };
    },
    async getSavedAlbums() { calls.push('saved-albums'); return { items: [], total: 0, next: null }; },
    async getArtist(id: string) { calls.push(`artist:${id}`); return { id, genres: ['trip hop'] }; },
    rateLimitedForMs: () => state.limitedMs,
    async *paginate<T>(page: (o: number) => Promise<any>) { const p = await page(0); for (const it of p.items ?? []) yield it as T; },
  };
  return { client, calls, state };
}

// ── the round trip ──────────────────────────────────────────────────────────

test('a compacted row drops what map.ts derives and gets it back on expand', () => {
  const song: any = {
    id: T1, title: 'Glory Box', artist: 'Portishead', artistId: 'ar1',
    album: 'Dummy', albumId: 'al1', year: 1994, duration: 300,
    coverArt: T1, spotifyUri: `spotify:track:${T1}`, genres: ['trip hop'], genre: 'trip hop',
    srcPlaylistId: 'PL1', isPlayable: true,
  };
  const row = store.compactTrack(song);
  for (const k of ['coverArt', 'spotifyUri', 'genres', 'genre']) {
    assert.ok(!(k in row), `${k} is derived and must not be stored — two definitions is how they drift`);
  }
  assert.equal(row.srcPlaylistId, 'PL1', 'which source a row came from IS stored: it is what makes a revalidate possible');

  const back = store.expandTrack(row, () => ['downtempo'])!;
  assert.equal(back.coverArt, T1, 'coverArt is the track id, exactly as map.ts says');
  assert.equal(back.spotifyUri, `spotify:track:${T1}`);
  assert.deepEqual(back.genres, ['downtempo'], 'genres come back from the LIVE genre cache, not from the file');
  assert.equal(back.genre, 'downtempo');
  assert.equal(back.title, 'Glory Box');
});

test('an unreadable, empty or superseded snapshot is simply not a snapshot', async () => {
  const { snapshot } = freshPaths();
  assert.equal(await store.readSnapshot(snapshot), null, 'a missing file is the normal first run');

  const write = async (body: unknown) => {
    const { writeFileSync } = await import('node:fs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, JSON.stringify(body));
  };
  await write({ nope: true });
  assert.equal(await store.readSnapshot(snapshot), null, 'junk starts empty rather than wedging the station');
  await write({ version: store.POOL_SNAPSHOT_VERSION + 99, tracks: [{ id: T1 }] });
  assert.equal(await store.readSnapshot(snapshot), null, 'a future version rebuilds rather than being half-read');
  await write({ version: store.POOL_SNAPSHOT_VERSION, tracks: [] });
  assert.equal(await store.readSnapshot(snapshot), null, 'a snapshot of nothing is not worth serving');

  // …but a good one with a few bad rows keeps the good ones.
  await write({ version: store.POOL_SNAPSHOT_VERSION, cfgSig: 'x', tracks: [{ id: T1, title: 'ok' }, null, { title: 'no id' }] });
  const snap = await store.readSnapshot(snapshot);
  assert.equal(snap?.tracks.length, 1, 'rows are repaired away, the file is not rejected');
});

// ── the restart ─────────────────────────────────────────────────────────────

test('a restart serves the pool off disk and spends NOT ONE catalogue request', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const first = fakeClient();
  const a = new SpotifyPoolCache(() => first.client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  const built = await a.get();
  assert.equal(built.tracks.size, 2);
  assert.equal(built.fromDisk, false);
  assert.ok(first.calls.includes('playlists'), 'the first build really did walk');

  // The restart: a brand-new cache over the same files, and a client that would
  // record anything it was asked for.
  invalidateSpotifyReads();
  const second = fakeClient();
  const b = new SpotifyPoolCache(() => second.client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  const restored = await b.get();
  assert.deepEqual(second.calls, [], 'zero requests — this is the walk a restart used to pay for');
  assert.equal(restored.tracks.size, 2);
  assert.equal(restored.tracks.get(T1)?.title, 'Glory Box');
  assert.equal(restored.tracks.get(T1)?.coverArt, T1, 'derived fields are rebuilt, not restored');
  assert.equal(restored.fromDisk, true, 'and it says so — the reconcile must not delete against it');
});

test('a snapshot written under a different curation is discarded, not served', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const a = new SpotifyPoolCache(() => fakeClient().client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  await a.get();

  // The operator narrowed the pool to one playlist id since the file was written.
  const second = fakeClient();
  const b = new SpotifyPoolCache(() => second.client, cfg({ playlistIds: ['PL1'] }), () => {}, () => now, paths.cache, paths.snapshot);
  const p = await b.get();
  assert.ok(second.calls.includes('items:PL1'), 'the wrong curation is rebuilt rather than served');
  assert.equal(p.fromDisk, false);
});

// ── the revalidate ──────────────────────────────────────────────────────────

test('an unchanged snapshot_id keeps a playlist without re-walking it; a moved one re-walks', async () => {
  const paths = freshPaths();
  let now = 1_000_000;
  const { client, calls, state } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();
  const walks = () => calls.filter((x) => x === 'items:PL1').length;
  assert.equal(walks(), 1);

  // A stale pool is SERVED at once and refreshed behind it — the station must
  // never wait on Spotify to answer a pick.
  advanceBy(POOL_TTL_MS + 1_000, (ms) => { now += ms; });
  const served = await pool.get();
  assert.equal(served.tracks.size, 2, 'the stale pool answered immediately');
  await pool.settled();
  assert.equal(walks(), 1, 'Spotify said the contents did not change, so they were not re-read');
  assert.equal((await pool.get()).tracks.size, 2, 'and the rows survived the revalidate');

  // Now the playlist actually changes.
  state.snapshotId = 'snap-2';
  state.items = [{ item: track(T1, 'Glory Box') }, { item: track(T2, 'Roads') }, { item: track(T3, 'Sour Times') }];
  advanceBy(POOL_TTL_MS + 1_000, (ms) => { now += ms; });
  await pool.get();
  await pool.settled();
  assert.equal(walks(), 2, 'a moved snapshot_id is re-walked');
  assert.equal((await pool.get()).tracks.size, 3);
});

test('a saved-tracks list is checked with a one-item probe, not a walk', async () => {
  const paths = freshPaths();
  let now = 1_000_000;
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg({ includeSaved: true }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();
  const fullWalks = () => calls.filter((x) => x === 'saved').length;
  assert.equal(fullWalks(), 1, 'the first build walks it');

  now += POOL_TTL_MS + 1_000;
  await pool.get();
  await pool.settled();
  assert.equal(fullWalks(), 1, 'unchanged count + newest id means no walk');
  assert.ok(calls.includes('saved-probe'), 'one cheap probe instead');
  assert.ok((await pool.get()).tracks.has(T3), 'and the saved track is still in the pool');
});

test('a refresh is FULL again once the snapshot is older than fullWalkHours', async () => {
  const paths = freshPaths();
  let now = 1_000_000;
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg({ fullWalkHours: 1 }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();
  const walks = () => calls.filter((x) => x === 'items:PL1').length;

  // Inside the full-walk window: revalidate, so an unchanged playlist is skipped.
  now += POOL_TTL_MS + 1_000;
  await pool.get();
  await pool.settled();
  assert.equal(walks(), 1);

  // Past it: the fingerprints cannot see a swap that keeps the count and the
  // newest id, so the walk happens anyway.
  now += 3_600_000;
  await pool.get();
  await pool.settled();
  assert.equal(walks(), 2, 'the full walk is what catches what a fingerprint cannot');
});

test('a playlist that fails to re-read keeps its rows — a blip is not a deletion', async () => {
  const paths = freshPaths();
  let now = 1_000_000;
  const { client, state } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();

  state.snapshotId = 'snap-2';                       // forces a re-walk…
  client.getPlaylistItems = async () => { throw new Error('503'); }; // …which fails
  advanceBy(POOL_TTL_MS + 1_000, (ms) => { now += ms; });
  await pool.get();
  await pool.settled();
  const p = await pool.get();
  assert.equal(p.tracks.size, 2, 'the rows are kept, not dropped');
  assert.equal(p.partial, true, 'and the pool says it is incomplete, which stands the reconcile down');
});

// ── the genre drip ──────────────────────────────────────────────────────────

test('the drip enriches without a rebuild, and resumes by itself after a hold', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client, calls, state } = fakeClient();
  // A hold is already in force when the pool is built, so the build's own
  // top-up fills nothing and the drip has work to do.
  state.limitedMs = 60_000;
  const pool = new SpotifyPoolCache(() => client, cfg({ genresPerHour: 3600 }), () => {}, () => now, paths.cache, paths.snapshot);
  const built = await pool.get();
  assert.equal(built.genresPending, 1, 'one artist, no genres yet');
  assert.equal(calls.filter((x) => x.startsWith('artist:')).length, 0, 'nothing was asked for while held');

  // Held: the drip stands down without touching the network.
  assert.deepEqual(await pool.dripGenresOnce(), { filled: 0, pending: 1 });
  assert.equal(calls.filter((x) => x.startsWith('artist:')).length, 0);

  // The window clears. Nothing re-arms it and no rebuild happens — that is the
  // point of moving the fill out of build(), which get() refuses to run while
  // the gate is closed.
  state.limitedMs = 0;
  const walksBefore = calls.filter((x) => x === 'items:PL1').length;
  const r = await pool.dripGenresOnce();
  assert.equal(r.filled, 1);
  assert.equal(r.pending, 0);
  assert.equal(calls.filter((x) => x === 'items:PL1').length, walksBefore, 'no catalogue was re-walked to enrich a genre');

  // The live pool is re-stamped, so genre browsing sharpens at once rather than
  // at the next rebuild.
  const p = pool.peek()!;
  assert.deepEqual(p.tracks.get(T1)?.genres, ['trip hop']);
  assert.equal(p.genres.get('trip hop'), 2);
  assert.equal(p.genresPending, 0);

  // …and it landed on disk, so the next restart starts enriched.
  const restored = await store.readSnapshot(paths.snapshot);
  assert.ok(restored, 'the drip persisted the pool it just improved');
});

test('genresPerHour 0 turns the drip off without touching anything else', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg({ genresPerHour: 0 }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();
  const before = pool.peek()!.genresPending;
  assert.deepEqual(await pool.dripGenresOnce(), { filled: 0, pending: before });
  assert.ok(GENRE_DRIP_INTERVAL_MS > 0);
});

// ── the landmine: a failed rebuild must not take the library with it ────────

// "Rebuild pool now" pressed during a rate-limit hold used to be a grenade: it
// discarded the pool and marked the disk snapshot as already-read BEFORE
// attempting anything, every request was then refused, an empty pool was
// published, and `get()` served that empty pool for as long as the hold lasted.
// The station went to the mixer's emergency loop and only a restart got it
// back. It is also the button the doctor's own hint told operators to press.
test('a rebuild that cannot read anything keeps the library and the snapshot', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client, state } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  const built = await pool.get();
  assert.equal(built.tracks.size, 2);

  // Now Spotify refuses everything, exactly as it does under a hold.
  state.limitedMs = 3_706_000;
  const refuse = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
  client.getMyPlaylists = refuse;
  client.getPlaylistItems = refuse;
  client.getSavedTracks = refuse;
  invalidateSpotifyReads();

  const after = await pool.rebuild();
  assert.equal(after.tracks.size, 2, 'the library survived the operator pressing the button at the worst moment');
  assert.equal(after.partial, true, 'and reports itself incomplete, which stands the orphan reconcile down');
  assert.equal(pool.peek()?.tracks.size, 2);

  // The good snapshot is still on disk AND still reachable — the old code set
  // `snapshotLoaded` so it could never be served again in this process.
  const onDisk = await store.readSnapshot(paths.snapshot);
  assert.equal(onDisk?.tracks.length, 2, 'the snapshot was not overwritten with nothing');

  // And a fresh process still restores it.
  invalidateSpotifyReads();
  const restarted = new SpotifyPoolCache(() => fakeClient().client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  assert.equal((await restarted.get()).tracks.size, 2);
});

// An account that genuinely HAS nothing is a different thing from a walk that
// could not read, and must still publish its empty pool with the explanation.
test('an account with nothing in it still publishes an empty pool, with the reason', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client } = fakeClient();
  client.getMyPlaylists = async () => ({ items: [], next: null });
  const pool = new SpotifyPoolCache(() => client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  const p = await pool.get();
  assert.equal(p.tracks.size, 0);
  assert.equal(p.partial, false, 'an empty account is a configuration, not a failure');
  assert.ok(p.notes.some((n) => /no playlists/.test(n)));
});

// ── the drip must say when it is standing down ─────────────────────────────

// Eight hours of "0 of 123 artists tagged" with no log line and nothing on the
// admin card is what a silent early return buys. A paused drip and a finished
// one looked identical.
test('the drip records why it did nothing', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client, state } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg({ genresPerHour: 3600 }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();

  state.limitedMs = 3_706_000;
  await pool.dripGenresOnce();
  assert.match(pool.peek()!.dripSkip ?? '', /paused/, 'a hold is reported, not swallowed');
  assert.match(pool.peek()!.dripSkip ?? '', /3706s/, 'with how long is left');

  state.limitedMs = 0;
  await pool.dripGenresOnce();
  assert.equal(pool.peek()!.dripSkip, null, 'and cleared once it is working again');
});

test('genre enrichment switched off says so rather than looking finished', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const { client } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, cfg({ genresPerHour: 0 }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();
  await pool.dripGenresOnce();
  assert.match(pool.peek()!.dripSkip ?? '', /switched off/);
});

// The drip reads the in-memory pool directly, and only get() used to populate
// it — so on a station whose pick paths had not run, enrichment was dead and
// reported `pending: 0`, which the admin card renders as "finished".
test('the drip loads the snapshot itself rather than waiting for a pick', async () => {
  const paths = freshPaths();
  const now = 1_000_000;
  const first = fakeClient();
  const a = new SpotifyPoolCache(() => first.client, cfg(), () => {}, () => now, paths.cache, paths.snapshot);
  await a.get();

  invalidateSpotifyReads();
  const second = fakeClient();
  // A COLD genre cache, so there is actually work for the drip to find — the
  // shared snapshot is what it has to restore on its own.
  const b = new SpotifyPoolCache(() => second.client, cfg({ genresPerHour: 3600 }), () => {}, () => now, freshPaths().cache, paths.snapshot);
  // No get() at all — straight to the drip, as the interval does at boot.
  const r = await b.dripGenresOnce();
  assert.ok(b.peek(), 'it restored the pool by itself');
  assert.equal(r.filled, 1, 'and enriched it');
  assert.deepEqual(second.calls.filter((x) => x === 'items:PL1'), [], 'without walking the catalogue to do it');
});

// `rankedArtists` is a STABLE sort, so a persistently failing head of the list
// blocked everything behind it: the drip recomputed the identical `missing`
// list every tick, sliced the identical first batch, logged "+0, N pending" and
// never reached artist N+1.
test('an artist that keeps failing does not block the queue behind it', async () => {
  const paths = freshPaths();
  let now = 1_000_000;
  const { client, calls } = fakeClient({
    items: [
      // ar1 has two tracks so it ranks first; ar2 has one.
      { item: track(T1, 'One', { artists: [{ id: 'ar1', name: 'A' }] }) },
      { item: track(T2, 'Two', { artists: [{ id: 'ar1', name: 'A' }] }) },
      { item: track(T3, 'Three', { artists: [{ id: 'ar2', name: 'B' }] }) },
    ],
  });
  // The busiest artist is permanently broken; a 404 already resolves to null,
  // so this is the "genuine failure" case.
  client.getArtist = async (id: string) => {
    calls.push(`artist:${id}`);
    if (id === 'ar1') throw Object.assign(new Error('boom'), { status: 500 });
    return { id, genres: ['trip hop'] };
  };
  const pool = new SpotifyPoolCache(() => client, cfg({ genresPerHour: 3600 }), () => {}, () => now, paths.cache, paths.snapshot);
  await pool.get();

  await pool.dripGenresOnce();
  await pool.dripGenresOnce();
  assert.ok(
    calls.includes('artist:ar2'),
    `the second artist was reached despite the first failing (asked: ${calls.filter((x) => x.startsWith('artist:')).join(', ')})`,
  );
  assert.deepEqual(pool.peek()!.tracks.get(T3)!.genres, ['trip hop']);

  // …and the broken one is retried later rather than written off.
  now += 31 * 60_000;
  const before = calls.filter((x) => x === 'artist:ar1').length;
  await pool.dripGenresOnce();
  assert.ok(calls.filter((x) => x === 'artist:ar1').length > before, 'the backoff expires — it is a backoff, not a verdict');
});
