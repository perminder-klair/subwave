// SpotifyMusicSource: the pure mappers, the pool build against a canned client,
// and the source's behaviour through the facade with settings.music.source =
// spotify. No network — the client is a stub returning fixture pages.
//
// Load-bearing assertions:
//   • a Spotify track maps to the Subsonic-shaped Song the walk/picker read
//     (id, artist string, album year, duration in SECONDS, coverArt = id, the
//     era flags the Navidrome walk stamps);
//   • the pool dedupes across playlists/saved, caps at maxTracks, stamps artist
//     genres from the per-artist call, and marks a compilation untrusted;
//   • BOTH playlist-row shapes read: February 2026 renamed the playlist row's
//     `track` key to `item`, while saved tracks still say `track`;
//   • the artist-genre cache outlives a rebuild, since the batch endpoint is
//     gone and every miss is now a request of its own;
//   • the facade returns neutral empties for capabilities spotify lacks
//     (similar songs, lyrics, scrobble) and THROWS on a request-URI builder;
//   • the picker tool set drops the server-only tools spotify cannot serve —
//     topSongsByArtist among them, since /artists/{id}/top-tracks was removed.
//
// Run: npm test -- spotify-source

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-source-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { mapTrack, mapAlbum, mapArtist, unwrapItem, pickImage, releaseYear, trackIdFromUri } = await import('../src/music/sources/spotify/map.js');
const { SpotifyPoolCache, sample } = await import('../src/music/sources/spotify/pool.js');
const facade = await import('../src/music/source.js');
const { capabilitiesFor } = await import('../src/music/sources/capabilities.js');
const { buildPickerContext } = await import('../src/llm/internal/tools/picker/scope.js');
const { PICKER_TOOLS } = await import('../src/llm/internal/tools/picker/index.js');
const { pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { invalidateSpotifyReads } = await import('../src/music/sources/spotify/reads.js');

// The shared catalogue reads (reads.ts) are memoised at MODULE scope, because
// the client they wrap is a process singleton — that is what lets one
// /me/playlists walk serve both the admin's playlist pickers and every pool
// build. Tests are the one place that is wrong: each builds its own client with
// its own `calls` log, and a memo carried over would let an earlier test's
// listing answer a later test's build and quietly prove nothing. Same reasoning
// as freshCachePath() below, and the same fix — start every test cold.
beforeEach(() => { invalidateSpotifyReads(); });

// ── fixtures ───────────────────────────────────────────────────────────────

// SpotifyClient captures `fetch` at CONSTRUCTION, and the module-level client is
// a singleton with no reset — so the stub has to be in place before anything
// first calls spotifyClient(). Installed once here, steered per test through
// `stubRoutes`; an unrouted URL 404s, which is what every test that does not opt
// in wants (they drive fake clients instead).
// A route's value is normally the JSON body. It may instead be a FUNCTION of the
// URL returning `{ status?, body?, retryAfter? }`, which is how a test drives a
// non-200 (a 429 arming the client's shared rate-limit gate) or counts the calls
// a code path actually makes. Needed because SpotifyClient captures `fetch` at
// construction and the client is a process singleton: a test cannot wrap
// globalThis.fetch afterwards and expect the client to see it.
type StubReply = { status?: number; body?: unknown; retryAfter?: string | null };
let stubRoutes: Array<[RegExp, unknown]> = [];
globalThis.fetch = (async (url: any) => {
  const hit = stubRoutes.find(([re]) => re.test(String(url)));
  let status = hit ? 200 : 404;
  let payload: unknown = hit ? hit[1] : {};
  let retryAfter: string | null = null;
  if (typeof payload === 'function') {
    const r = (payload as (u: string) => StubReply)(String(url)) ?? {};
    status = r.status ?? 200;
    payload = r.body ?? {};
    retryAfter = r.retryAfter ?? null;
  }
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Not Found',
    headers: { get: (h: string) => (/retry-after/i.test(String(h)) ? retryAfter : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as any;
}) as any;

const img = (w: number) => ({ url: `https://i.scdn.co/${w}`, width: w, height: w });
const artist = (id: string, name: string) => ({ id, name, type: 'artist' });
const album = (id: string, name: string, extra: any = {}) => ({
  id, name, album_type: 'album', release_date: '1994-03-08', release_date_precision: 'day',
  images: [img(640), img(300), img(64)], artists: [artist('ar1', 'Portishead')], total_tracks: 11, ...extra,
});
const track = (id: string, name: string, extra: any = {}) => ({
  id, name, uri: `spotify:track:${id}`, duration_ms: 245_400, explicit: false, popularity: 61,
  track_number: 3, disc_number: 1, artists: [artist('ar1', 'Portishead')], album: album('al1', 'Dummy'),
  external_urls: { spotify: `https://open.spotify.com/track/${id}` }, ...extra,
});

test('mapTrack → the Subsonic-shaped Song every consumer reads', () => {
  const s = mapTrack(track('1a2b3c4d5e6f7g8h9i0j1k', 'Glory Box'))!;
  assert.equal(s.id, '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(s.title, 'Glory Box');
  assert.equal(s.artist, 'Portishead');
  assert.equal(s.artistId, 'ar1');
  assert.equal(s.album, 'Dummy');
  assert.equal(s.albumId, 'al1');
  assert.equal(s.year, 1994, 'album release year');
  assert.equal(s.duration, 245, 'SECONDS, rounded — Subsonic parity');
  assert.equal(s.coverArt, s.id, '/cover/:id resolves through the source by track id');
  assert.equal(s.spotifyUri, 'spotify:track:1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(s.albumIsCompilation, false);
  assert.equal(s.albumOriginalYear, null, 'Spotify has no original-release date');
  assert.equal(s._imageUrl, 'https://i.scdn.co/640', 'smallest image ≥ 512 wide');
  assert.deepEqual(s.genres, [], 'no artist cache → no genres, never undefined');
});

test('mapTrack joins multiple artists and flags compilations two ways', () => {
  const multi = mapTrack(track('t2', 'Duet', { artists: [artist('a', 'A'), artist('b', 'B')] }))!;
  assert.equal(multi.artist, 'A, B');
  assert.deepEqual(multi.artists, ['A', 'B']);
  const comp = mapTrack(track('t3', 'X', { album: album('c1', 'Now 42', { album_type: 'compilation' }) }))!;
  assert.equal(comp.albumIsCompilation, true);
  const va = mapTrack(track('t4', 'Y', { album: album('c2', 'Sampler', { artists: [artist('va', 'Various Artists')] }) }))!;
  assert.equal(va.albumIsCompilation, true, 'a Various Artists album artist is the compilation marker');
  assert.equal(va.albumArtist, 'Various Artists');
});

test('mapTrack stamps genres from the artist cache and honours the album extra', () => {
  const genres = new Map([['ar1', ['trip hop', 'downtempo']]]);
  const s = mapTrack({ ...track('t5', 'Roads'), album: undefined }, { album: album('al1', 'Dummy'), artistGenres: genres })!;
  assert.deepEqual(s.genres, ['trip hop', 'downtempo']);
  assert.equal(s.genre, 'trip hop');
  assert.equal(s.album, 'Dummy');
});

test('mappers refuse junk and unwrapItem drops locals, episodes and removed tracks', () => {
  assert.equal(mapTrack(null), null);
  assert.equal(mapTrack({ name: 'no id' }), null);
  assert.equal(mapAlbum({}), null);
  assert.equal(mapArtist(undefined), null);
  assert.equal(unwrapItem({ track: null }), null);
  assert.equal(unwrapItem({ track: { id: 'x', is_local: true } }), null);
  assert.equal(unwrapItem({ track: { id: 'x', type: 'episode' } }), null);
  assert.equal(unwrapItem({ track: { id: 'x', type: 'track' } })?.id, 'x');
  assert.equal(releaseYear('1994'), 1994);
  assert.equal(releaseYear('0000'), undefined);
  assert.equal(pickImage([img(64), img(300)], 512), 'https://i.scdn.co/300', 'largest when none reaches the size');
  assert.equal(trackIdFromUri('spotify:track:1a2b3c4d5e6f7g8h9i0j1k'), '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(trackIdFromUri('https://open.spotify.com/track/1a2b3c4d5e6f7g8h9i0j1k?si=abc'), '1a2b3c4d5e6f7g8h9i0j1k');
  assert.equal(trackIdFromUri('not an id'), null);
});

test('sample is a permutation prefix', () => {
  const out = sample([1, 2, 3, 4, 5], 3, () => 0.5);
  assert.equal(out.length, 3);
  assert.equal(new Set(out).size, 3);
  assert.deepEqual([...sample([1, 2], 9)].sort((a, b) => a - b), [1, 2], 'size is capped at the input length');
});

// ── the pool ───────────────────────────────────────────────────────────────

// The genre cache is PERSISTED now, so every test that must start cold needs a
// file of its own — sharing one would let an earlier test's fill satisfy a
// later test's budget and quietly prove nothing.
let cacheSeq = 0;
const freshCachePath = () => path.join(stateRoot, `genre-cache-${++cacheSeq}.json`);
// The POOL is persisted now too (pool-store.ts), and for the same reason each
// test needs a file of its own: sharing one would let an earlier test's snapshot
// be restored by a later one, which would then assert that no requests were made
// while proving only that the previous test had already made them.
let snapSeq = 0;
const freshSnapshotPath = () => path.join(stateRoot, `pool-snapshot-${++snapSeq}.json`);

function fakeClient(opts: { failSaved?: boolean; failArtists?: boolean; limitedMs?: number } = {}) {
  const calls: string[] = [];
  const t1 = track('AAAAAAAAAAAAAAAAAAAAAA', 'Glory Box');
  const t2 = track('BBBBBBBBBBBBBBBBBBBBBB', 'Roads');
  const comp = track('CCCCCCCCCCCCCCCCCCCCCC', 'Hit', { artists: [artist('ar2', 'Someone')], album: album('cmp', 'Now 42', { album_type: 'compilation', artists: [artist('va', 'Various Artists')] }) });
  const client: any = {
    // `items: { total }` is the post-February-2026 playlist shape; the mappers
    // still accept the old `tracks: { total }`.
    async getMyPlaylists() { calls.push('playlists'); return { items: [{ id: 'PL1', name: 'Night', items: { total: 2 } }], next: null }; },
    async getPlaylist(id: string) { calls.push(`playlist:${id}`); return { id, name: `ext ${id}`, items: { total: 1 } }; },
    async getPlaylistItems(id: string) {
      calls.push(`items:${id}`);
      // GET /playlists/{id}/items wraps the track under `item`, not `track`.
      return id === 'PL1'
        ? { items: [{ item: t1, added_at: '2024-01-01T00:00:00Z' }, { item: t2, added_at: '2024-01-02T00:00:00Z' }, { item: null }], next: null }
        : { items: [{ item: comp }], next: null };
    },
    async getSavedTracks() {
      calls.push('saved');
      if (opts.failSaved) throw new Error('saved down');
      // GET /me/tracks still says `track` — the other half of unwrapItem.
      return { items: [{ track: t1, added_at: '2023-01-01T00:00:00Z' }, { track: comp }], next: null }; // t1 is a dup
    },
    async getSavedAlbums() { calls.push('saved-albums'); return { items: [], next: null }; },
    // The batch endpoint (GET /artists?ids=) was removed — one request each.
    async getArtist(id: string) {
      calls.push(`artist:${id}`);
      if (opts.failArtists) throw Object.assign(new Error('rate limited'), { status: 429 });
      return { id, genres: id === 'ar1' ? ['trip hop'] : ['pop'] };
    },
    // The shared rate-limit gate the pool stands down on.
    rateLimitedForMs: () => opts.limitedMs ?? 0,
    async *paginate<T>(page: (o: number) => Promise<any>) { const p = await page(0); for (const it of p.items ?? []) yield it as T; },
  };
  return { client, calls };
}

test('the pool dedupes, caps, stamps genres and marks compilations untrusted', async () => {
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ['PL1', 'EXT1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  const p = await pool.get();
  assert.equal(p.tracks.size, 3, 'two playlist tracks + one saved, the duplicate collapsed');
  assert.equal(p.playlists.length, 2, 'the owned playlist and the configured external one');
  assert.ok(calls.includes('playlist:EXT1'), 'an unowned configured playlist is fetched by id');
  assert.equal(p.playlists[0].songCount, 2, 'songCount reads the renamed items.total');
  assert.deepEqual(p.tracks.get('AAAAAAAAAAAAAAAAAAAAAA')!.genres, ['trip hop'], 'an `item`-wrapped playlist row maps');
  assert.ok(p.tracks.has('CCCCCCCCCCCCCCCCCCCCCC'), 'a `track`-wrapped saved row maps too');
  assert.equal(p.genres.get('trip hop'), 2);
  const c = p.tracks.get('CCCCCCCCCCCCCCCCCCCCCC')!;
  assert.equal(c.albumIsCompilation, true);
  assert.equal(c.albumEraUntrusted, true, 'the era pipeline reads this exactly as it does for Navidrome');
  assert.deepEqual(calls.filter((x) => x.startsWith('artist:')).sort(), ['artist:ar1', 'artist:ar2'], 'one request per distinct artist, no repeats');
  assert.equal(p.partial, false);
  // memoised
  await pool.get();
  assert.equal(calls.filter((x) => x === 'playlists').length, 1);
});

test('the artist-genre cache outlives a rebuild — a removed batch endpoint must not become N calls every 30 minutes', async () => {
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ['PL1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  await pool.get();
  const first = calls.filter((x) => x.startsWith('artist:')).length;
  assert.ok(first > 0, 'the first build asks');
  pool.invalidate();
  const p = await pool.get();
  assert.equal(calls.filter((x) => x.startsWith('artist:')).length, first, 'the rebuild re-walks the playlists but asks for no artist twice');
  assert.deepEqual(p.tracks.get('AAAAAAAAAAAAAAAAAAAAAA')!.genres, ['trip hop'], 'and the genres are still stamped from the cache');
});

// The cache the in-memory version could only promise: a restart used to re-ask
// Spotify for every artist one at a time, which is the rate-limit incident.
test('the genre cache is on DISK, so a fresh cache over the same file asks for nothing', async () => {
  const shared = freshCachePath();
  const cfg = () => ({ playlistIds: ['PL1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 });
  const first = fakeClient();
  await new SpotifyPoolCache(() => first.client, cfg, () => {}, Date.now, shared).get();
  assert.ok(first.calls.filter((x) => x.startsWith('artist:')).length > 0, 'the cold station asks');

  // A whole new process, same state dir.
  const second = fakeClient();
  const p = await new SpotifyPoolCache(() => second.client, cfg, () => {}, Date.now, shared).get();
  assert.deepEqual(second.calls.filter((x) => x.startsWith('artist:')), [], 'the warm station asks for nothing');
  assert.deepEqual(p.tracks.get('AAAAAAAAAAAAAAAAAAAAAA')!.genres, ['trip hop'], 'and still knows the genres');
  assert.equal(p.genresPending, 0);
});

test('the genre fill is BUDGETED — a build is never a burst, and the rest carries to the next one', async () => {
  const { ARTIST_GENRE_BUDGET } = await import('../src/music/sources/spotify/pool.js');
  // More distinct artists than one build may spend.
  const many = ARTIST_GENRE_BUDGET + 40;
  const items = Array.from({ length: many }, (_, i) => ({
    item: track(`T${String(i).padStart(21, '0')}`, `Song ${i}`, { artists: [artist(`ar${i}`, `Artist ${i}`)] }),
  }));
  const calls: string[] = [];
  const client: any = {
    async getMyPlaylists() { return { items: [{ id: 'PL1', name: 'Big', items: { total: many } }], next: null }; },
    async getPlaylistItems() { return { items, next: null }; },
    async getSavedTracks() { return { items: [], next: null }; },
    async getSavedAlbums() { return { items: [], next: null }; },
    async getArtist(id: string) { calls.push(id); return { id, genres: ['pop'] }; },
    rateLimitedForMs: () => 0,
    async *paginate<T>(page: (o: number) => Promise<any>) { const p = await page(0); for (const it of p.items ?? []) yield it as T; },
  };
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: false, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());

  const p1 = await pool.get();
  assert.equal(calls.length, ARTIST_GENRE_BUDGET, 'exactly the budget, not the whole queue');
  assert.equal(p1.genresPending, many - ARTIST_GENRE_BUDGET, 'the remainder is pending, not lost');
  assert.equal(p1.partial, false, 'unfilled genres are enrichment in flight, NOT a broken pool');

  // rebuild(), not invalidate()+get(): invalidate() deliberately keeps serving
  // the pool it has while the replacement is fetched, so the station never
  // waits on Spotify to answer a pick. Only an operator asking for a rebuild
  // blocks on the result.
  const p2 = await pool.rebuild();
  assert.equal(calls.length, Math.min(many, ARTIST_GENRE_BUDGET * 2), 'the next build spends another budget');
  assert.ok(p2.genresPending < p1.genresPending, 'and converges');
});

test('the fill ranks by track count, so a budget buys the most coverage', async () => {
  // ar1 owns two tracks, ar2 one. With a budget of one, ar1 must win.
  const { client, calls } = fakeClient();
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ['PL1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  await pool.get();
  const asked = calls.filter((x) => x.startsWith('artist:'));
  assert.equal(asked[0], 'artist:ar1', 'the artist with the most pool tracks goes first');
});

test('a rate limit stops the fill dead and is not cached as a miss', async () => {
  const { client, calls } = fakeClient({ failArtists: true });
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ['PL1'], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  const p = await pool.get();
  assert.ok(p.tracks.size > 0, 'the pool still plays music');
  assert.equal(p.partial, false, 'a rate-limited fill is not a broken pool');
  assert.ok(p.genresPending > 0);
  // One worker's 429 ends the pass rather than every remaining artist asking.
  assert.ok(calls.filter((x) => x.startsWith('artist:')).length <= 2, `stood down early: ${calls.filter((x) => x.startsWith('artist:')).length}`);

  // A 429 must NOT be remembered as "this artist has no genres" — that would
  // write an artist off permanently over a moment.
  const healthy = fakeClient();
  client.getArtist = healthy.client.getArtist;
  const p2 = await pool.rebuild();
  assert.deepEqual(p2.tracks.get('AAAAAAAAAAAAAAAAAAAAAA')!.genres, ['trip hop'], 'retried once the limit cleared');
});

test('a closed rate-limit gate suppresses the rebuild — the short empty retry must not become a hammer loop', async () => {
  const { POOL_EMPTY_RETRY_MS } = await import('../src/music/sources/spotify/pool.js');
  const { client, calls } = fakeClient({ failSaved: true });
  client.getMyPlaylists = async () => { throw new Error('429 rate limited'); };
  let limited = 0;
  client.rateLimitedForMs = () => limited;
  let now = 1_000_000;
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, () => now, freshCachePath(), freshSnapshotPath());
  await pool.get();
  const after = calls.filter((x) => x === 'saved').length;

  // The window closes; the retry deadline passes. Without the gate check this
  // is a rebuild every two minutes into a live rate limit.
  limited = 10 * 60_000;
  now += POOL_EMPTY_RETRY_MS + 1_000;
  await pool.get();
  assert.equal(calls.filter((x) => x === 'saved').length, after, 'held off while Spotify is holding us off');

  limited = 0;
  await pool.get();
  assert.ok(calls.filter((x) => x === 'saved').length > after, 'and resumes once the window clears');
});

// The two builds that logged "0 tracks, 0 albums, 0 playlists … in 0s" and said
// nothing else: an empty /me/playlists is a SUCCESSFUL walk, so it set no error
// and no `partial`, and the operator was left with an unexplained empty pool
// held for the full 30 minutes.
test('an empty playlist listing explains itself, is not called a failure, and is not held for 30 minutes', async () => {
  const { POOL_TTL_MS, POOL_EMPTY_RETRY_MS } = await import('../src/music/sources/spotify/pool.js');
  const { client, calls } = fakeClient();
  // Keep the call markers the fixture records — overriding them away would make
  // the rebuild counter below silently always zero.
  client.getMyPlaylists = async () => { calls.push('playlists'); return { items: [], next: null }; };
  client.getSavedTracks = async () => { calls.push('saved'); return { items: [], next: null }; };
  let now = 1_000_000;
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, () => now, freshCachePath(), freshSnapshotPath());

  const p = await pool.get();
  assert.equal(p.tracks.size, 0);
  assert.equal(p.partial, false, 'an account with no playlists is a configuration, not a fault');
  assert.ok(p.notes.some((n) => /no playlists/.test(n)), `the reason is recorded: ${JSON.stringify(p.notes)}`);

  // …and it is retried soon, because an empty pool is dead air either way.
  const builds = () => calls.filter((x) => x === 'saved').length;
  const after = builds();
  now += POOL_EMPTY_RETRY_MS + 1_000;
  await pool.get();
  assert.ok(builds() > after, 'a non-partial empty pool retries on the short window, not the full TTL');
  assert.ok(POOL_EMPTY_RETRY_MS < POOL_TTL_MS);
});

test('an empty, failed build is held only briefly — a 30-minute memo of nothing is 30 minutes of dead air', async () => {
  const { POOL_TTL_MS, POOL_EMPTY_RETRY_MS } = await import('../src/music/sources/spotify/pool.js');
  const { client, calls } = fakeClient({ failSaved: true });
  // Every source fails: the playlist listing throws and saved tracks throw.
  client.getMyPlaylists = async () => { throw new Error('403 Forbidden'); };
  let now = 1_000_000;
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, () => now, freshCachePath(), freshSnapshotPath());
  const empty = await pool.get();
  assert.equal(empty.tracks.size, 0);
  assert.equal(empty.partial, true);
  assert.ok(empty.notes.length > 0, 'the reason travels with the pool, not only to the log');

  const builds = () => calls.filter((x) => x === 'saved').length;
  const after = builds();
  now += POOL_EMPTY_RETRY_MS - 1_000;
  await pool.get();
  assert.equal(builds(), after, 'still inside the short retry window');
  now += 2_000;
  await pool.get();
  assert.ok(builds() > after, 'retried well before the full TTL');
  assert.ok(POOL_EMPTY_RETRY_MS < POOL_TTL_MS);
});

test('a failed source page leaves the pool usable and marked partial; a cap stops the walk', async () => {
  const { client } = fakeClient({ failSaved: true });
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  const p = await pool.get();
  assert.equal(p.partial, true);
  assert.equal(p.tracks.size, 2);

  const capped = new SpotifyPoolCache(() => fakeClient().client, () => ({ playlistIds: [], includeSaved: true, includeSavedAlbums: false, maxTracks: 1 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  const cappedPool = await capped.get();
  assert.equal(cappedPool.tracks.size, 1);
  assert.equal(cappedPool.truncated, true, 'a capped walk is a PREFIX of the library — the reconcile must not delete against it');
  assert.equal(p.truncated, false, 'and an uncapped one is not');
});

test('a pool-definition change rebuilds on the next get() without an explicit invalidate', async () => {
  const { client, calls } = fakeClient();
  let ids = ['PL1'];
  const pool = new SpotifyPoolCache(() => client, () => ({ playlistIds: ids, includeSaved: false, includeSavedAlbums: false, maxTracks: 5000 }), () => {}, Date.now, freshCachePath(), freshSnapshotPath());
  await pool.get();
  const walks = () => calls.filter((x) => x.startsWith('items:')).length;
  const before = walks();
  ids = ['PL1', 'EXT1'];
  const p = await pool.get();
  assert.equal(p.playlists.length, 2);
  assert.ok(walks() > before, 'the definition changed, so the playlists are walked again');
  assert.ok(calls.includes('playlist:EXT1'), 'and the newly configured external playlist is resolved');
  // The ACCOUNT LISTING is not re-walked, and that is the point of sharing it
  // (reads.ts): which playlists the operator owns did not change just because
  // the pool now selects two of them. Only an event that changes the account —
  // a connect, a token paste, a disconnect, or the operator pressing "Rebuild
  // pool now" — goes through invalidate() and drops it.
  assert.equal(calls.filter((x) => x === 'playlists').length, 1, 'the account listing is shared, not re-walked per rebuild');
});

// ── through the facade ─────────────────────────────────────────────────────

test('with music.source = spotify the facade routes to the Spotify source and degrades honestly', async () => {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ music: { source: 'spotify' } }));
  setCache(null);
  await settings.load();
  assert.equal(facade.activeSourceId(), 'spotify');
  const caps = capabilitiesFor('spotify');
  assert.equal(caps.hasLiveTransport, true);
  assert.equal(caps.hasAudio, false);
  // Neutral empties for what Spotify lacks — no request is attempted.
  assert.deepEqual(await facade.getSimilarSongs('x'), []);
  assert.equal(await facade.getLyrics('x'), '');
  assert.equal(await facade.supportsSonicSimilarity(), false);
  assert.equal(await facade.scrobble('x', { submission: true }), undefined);
  assert.equal(await facade.getAnalyzableRef('x'), null, 'no audio bytes → analyzer skips cleanly');
  // A request-URI builder must THROW, never hand Liquidsoap a URI that plays nothing.
  assert.throws(() => facade.getAnnotatedUri({ id: 'x', title: 't', artist: 'a', album: 'b' }), /live transport/);
  assert.equal(facade.getLocalPath({ id: 'x' }), null);
  // Without credentials ping says so, in the operator's words.
  const p = await facade.ping();
  assert.equal(p.ok, false);
  assert.match(p.reason ?? '', /not connected/);
  // The picker never offers the server-only tools.
  const ctx = buildPickerContext(pickerScope());
  const names = PICKER_TOOLS.filter((m) => !m.available || m.available(ctx)).map((m) => m.name);
  // topSongsByArtist is off since February 2026 removed /artists/{id}/top-tracks
  // with no replacement — offering it would spend a discovery call on nothing.
  for (const n of ['similarSongs', 'topSongsByArtist']) assert.ok(!names.includes(n), `${n} off on spotify`);
  for (const n of ['starredSongs', 'recentlyAdded', 'searchLibrary', 'randomSongs']) assert.ok(names.includes(n), `${n} on for spotify`);
  assert.deepEqual(await facade.getTopSongs('Portishead'), [], 'the facade answers the neutral empty rather than calling a dead endpoint');
  // A Spotify station that has not built a pool yet must NOT be read as an
  // authoritative catalogue — the reconcile would delete every tagged track.
  const health = await facade.catalogHealth();
  assert.equal(health.complete, false);
  assert.match(health.reason ?? '', /not been built/);
  // and back to the default
  writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
  setCache(null);
  await settings.load();
  assert.equal(facade.activeSourceId(), 'subsonic');
  // THE regression guard for the default direction: Subsonic implements no
  // health probe, and the facade must answer "complete" so its reconcile keeps
  // working exactly as it always has. Flip this and every Navidrome station
  // silently stops pruning.
  assert.deepEqual(await facade.catalogHealth(), { complete: true });
});

// The divergence that made blocking a track destroy its tags: iterateAllSongs is
// the LIBRARY walk, and the orphan reconcile deletes everything it does not
// yield. Filtering the blocklist there (which Navidrome's walk does not do) made
// a blocked track read as deleted. Driven through the real singleton source with
// a stubbed global fetch, because that filtering lives in the singleton's
// iterateAllSongs and nowhere a fake client can reach.
test('the library walk yields a blocklisted track; the pick paths still refuse it', async () => {
  const { spotifyPool, spotifyClient } = await import('../src/music/sources/spotify/source.js');
  const blocklist = await import('../src/music/blocklist.js');

  const BLOCKED = 'DDDDDDDDDDDDDDDDDDDDDD';
  const OK = 'EEEEEEEEEEEEEEEEEEEEEE';
  const page = (items: any[]) => ({ items, next: null });
  stubRoutes = [
    [/accounts\.spotify\.com\/api\/token/, { access_token: 'T', expires_in: 3600 }],
    [/\/me\/playlists/, page([{ id: 'PL1', name: 'Night', items: { total: 2 } }])],
    [/\/playlists\/PL1\/items/, page([{ item: track(BLOCKED, 'Nope') }, { item: track(OK, 'Fine') }])],
    [/\/me\/tracks/, page([])],
    [/\/me\/albums/, page([])],
    [/\/artists\//, { id: 'ar1', genres: ['trip hop'] }],
  ];
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  process.env.SPOTIFY_REFRESH_TOKEN = 'refresh';

  try {
    writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ music: { source: 'spotify' } }));
    setCache(null);
    await settings.load();
    spotifyClient().resetToken();
    spotifyPool().invalidate();

    await blocklist.load();
    await blocklist.add({ type: 'track', id: BLOCKED, name: 'Nope', artist: 'Portishead', album: 'Dummy' });

    const walked: string[] = [];
    for await (const s of facade.iterateAllSongs()) walked.push(s.id);
    assert.equal(walked.length, 2, `the stubbed pool built (got ${JSON.stringify(walked)})`);
    assert.ok(walked.includes(BLOCKED), 'the blocked track is still IN the library — deleting its tags would be the bug');
    assert.ok(walked.includes(OK));

    // …but it must never be handed to a pick path.
    const picks = await facade.getRandomSongs({ size: 50 });
    assert.ok(!picks.some((s: any) => s.id === BLOCKED), 'the blocklist is still absolute at the pick paths');
    assert.ok(picks.some((s: any) => s.id === OK));

    // A healthy, uncapped, un-rate-limited pool is safe to delete against.
    assert.deepEqual(await facade.catalogHealth(), { complete: true });
  } finally {
    await blocklist.remove('track', BLOCKED).catch(() => {});
    stubRoutes = [];
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_REFRESH_TOKEN;
    writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
    setCache(null);
    await settings.load();
  }
});

// A track Spotify REFUSED TO PLAY is the mirror image of a blocked one, and the
// difference is the point. A blocklisted track stays in the library (deleting
// its tags would be the bug); a refused track is not in the operator's library
// in any useful sense — nothing can play it — so it leaves the published pool
// entirely, walk included. The snapshot on disk keeps it, which is what makes
// clearing the list, or the 30-day expiry, cost no catalogue requests.
test('a refused track leaves the published pool AND the walk, while the snapshot keeps it', async () => {
  const { spotifyPool, spotifyClient } = await import('../src/music/sources/spotify/source.js');
  const unplayable = await import('../src/music/sources/spotify/unplayable-file.js');

  const DEAD = 'FFFFFFFFFFFFFFFFFFFFFF';
  const OK = 'GGGGGGGGGGGGGGGGGGGGGG';
  const page = (items: any[]) => ({ items, next: null });
  stubRoutes = [
    [/accounts\.spotify\.com\/api\/token/, { access_token: 'T', expires_in: 3600 }],
    [/\/me\/playlists/, page([{ id: 'PL9', name: 'Night', items: { total: 2 } }])],
    [/\/playlists\/PL9\/items/, page([{ item: track(DEAD, 'Hurricane') }, { item: track(OK, 'Fine') }])],
    [/\/me\/tracks/, page([])],
    [/\/me\/albums/, page([])],
    [/\/artists\//, { id: 'ar1', genres: ['trip hop'] }],
  ];
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  process.env.SPOTIFY_REFRESH_TOKEN = 'refresh';
  unplayable.resetUnplayableCache(path.join(stateRoot, `unplayable-src-${Date.now()}.json`));

  try {
    writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ music: { source: 'spotify' } }));
    setCache(null);
    await settings.load();
    spotifyClient().resetToken();
    // invalidate() only marks a refresh owed — get() deliberately serves the
    // stale pool while it rebuilds behind, so the walk has to be awaited or an
    // earlier test's pool answers this one.
    spotifyPool().invalidate();
    await facade.getRandomSongs({ size: 1 });
    await spotifyPool().settled();

    // Built clean: both tracks present everywhere.
    assert.deepEqual((await facade.getRandomSongs({ size: 50 })).map((s: any) => s.id).sort(), [DEAD, OK].sort());

    // Now Spotify refuses one on air.
    unplayable.markUnplayable(DEAD, { title: 'Hurricane', artist: 'Portishead', reason: 'unavailable' });
    spotifyPool().dropTrack(DEAD);

    const picks = await facade.getRandomSongs({ size: 50 });
    assert.deepEqual(picks.map((s: any) => s.id), [OK], 'every pick path filters it through keep()');

    const walked: string[] = [];
    for await (const s of facade.iterateAllSongs()) walked.push(s.id);
    assert.deepEqual(walked, [OK], 'the tagger, coverage and the orphan reconcile see the same library');

    // Forgetting it costs nothing: the walked set is still in memory, so the
    // row comes back without a single catalogue request.
    unplayable.clearUnplayable();
    assert.equal(spotifyPool().republish(), 1);
    assert.equal((await facade.getRandomSongs({ size: 50 })).length, 2);
  } finally {
    unplayable.clearUnplayable();
    stubRoutes = [];
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_REFRESH_TOKEN;
    writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
    setCache(null);
    await settings.load();
  }
});

// The alternative-release lookup is the ONLY new request this feature makes, so
// its budget is pinned here rather than left to review. /search caps `limit` at
// 10, and asking for more makes searchPaged issue three HTTP requests for one
// logical search — on a metered quota Development Mode cannot buy its way out of.
test('the alternative lookup is ONE search page, and free on a repeat', async () => {
  const { spotifyClient, findAlternativeTrack } = await import('../src/music/sources/spotify/source.js');
  const unplayable = await import('../src/music/sources/spotify/unplayable-file.js');

  const ALT = 'HHHHHHHHHHHHHHHHHHHHHH';
  let searches: string[] = [];
  let gateOn429 = false;
  const hit = { tracks: { items: [track(ALT, 'Hurricane - 2018 Remaster', { album: album('al2', 'Desire (Remastered)') })], next: null } };
  stubRoutes = [
    [/accounts\.spotify\.com\/api\/token/, { access_token: 'T', expires_in: 3600 }],
    [/\/search/, (url: string) => {
      searches.push(url);
      return gateOn429 ? { status: 429, retryAfter: '60' } : { body: hit };
    }],
  ];
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  process.env.SPOTIFY_REFRESH_TOKEN = 'refresh';
  unplayable.resetUnplayableCache(path.join(stateRoot, `unplayable-alt-${Date.now()}.json`));

  try {
    spotifyClient().resetToken();
    invalidateSpotifyReads();
    const want = { id: 'IIIIIIIIIIIIIIIIIIIIII', title: 'Hurricane', artist: 'Portishead', duration: 245, albumId: 'al1' } as any;

    const alt = await findAlternativeTrack(want);
    assert.equal(alt?.id, ALT, 'a remaster on another release is the same recording');
    assert.equal(searches.length, 1, 'one page, not the three a >10 ask would cost');
    assert.match(searches[0], /limit=10/, '/search caps limit at 10; asking for more is three requests');

    // The reads.ts memo covers the repeat — a track refused twice inside the TTL
    // must not pay twice.
    searches = [];
    await findAlternativeTrack(want);
    assert.equal(searches.length, 0);

    // And once Spotify closes the gate, the lookup stops happening at all.
    // Letting the foreground lane wait a window out would put that delay
    // straight into the seam, for a lookup the station can do without.
    gateOn429 = true;
    invalidateSpotifyReads();
    searches = [];
    assert.equal(await findAlternativeTrack(want), null, 'a refused search is not a substitute');
    assert.ok(spotifyClient().rateLimitedForMs() > 0, 'the 429 armed the shared gate');

    invalidateSpotifyReads();   // so it is the GATE stopping it, not the failure memo
    searches = [];
    assert.equal(await findAlternativeTrack(want), null);
    assert.equal(searches.length, 0, 'not one request spent while Spotify is holding the station off');
  } finally {
    spotifyClient().clearHold();
    unplayable.clearUnplayable();
    stubRoutes = [];
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_REFRESH_TOKEN;
  }
});

// GET /dj/recent asked for newest ALBUMS and then fetched every album's tracks
// — one request per album, ~51 for one admin panel at limit=50, and the most
// expensive call in the codebase with no cache anywhere on the path. The pool
// already stamps each track's `added_at` as `created`, so the answer was in
// memory the whole time. Driven through the real singleton source, because the
// route reaches it through the facade.
test('the newest tracks come out of the pool, newest first, costing nothing', async () => {
  const { spotifySource, spotifyPool, spotifyClient } = await import('../src/music/sources/spotify/source.js');
  const page = (items: any[]) => ({ items, next: null });
  stubRoutes = [
    [/accounts\.spotify\.com\/api\/token/, { access_token: 'T', expires_in: 3600 }],
    [/\/me\/playlists/, page([{ id: 'PL1', name: 'Night', items: { total: 2 } }])],
    [/\/playlists\/PL1\/items/, page([
      { item: track('AAAAAAAAAAAAAAAAAAAAAA', 'Older'), added_at: '2024-01-01T00:00:00Z' },
      { item: track('BBBBBBBBBBBBBBBBBBBBBB', 'Newer'), added_at: '2025-06-01T00:00:00Z' },
    ])],
    [/\/me\/tracks/, page([])],
    [/\/me\/albums/, page([])],
    [/\/artists\//, { id: 'ar1', genres: [] }],
  ];
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  process.env.SPOTIFY_REFRESH_TOKEN = 'refresh';
  try {
    writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ music: { source: 'spotify' } }));
    setCache(null);
    await settings.load();
    spotifyClient().resetToken();
    await spotifyPool().rebuild();

    const recent = await spotifySource.getRecentSongs!({ size: 10 });
    assert.deepEqual(recent.map((s: any) => s.title), ['Newer', 'Older'], 'newest first, by the added_at the pool already holds');

    // Through the facade, which is what routes/dj.ts calls. The capability is
    // what keeps that route ONE code path instead of a source-id branch.
    assert.equal(capabilitiesFor('spotify').hasRecentSongs, true);
    assert.equal(capabilitiesFor('subsonic').hasRecentSongs, false, 'Navidrome keeps composing it from albums — that fan-out is cheap there');
    assert.equal((await facade.getRecentSongs({ size: 1 })).length, 1);

    // THE LANDMINE TEST. A rebuild that cannot read anything — every request
    // refused, which is what a rate-limit hold looks like — must leave the
    // working library exactly where it was. It used to discard the pool BEFORE
    // attempting, publish an empty one, and mark the disk snapshot as already
    // read, so pressing "Rebuild pool now" during a hold took the station to
    // dead air until it was restarted.
    stubRoutes = [[/accounts\.spotify\.com\/api\/token/, { access_token: 'T', expires_in: 3600 }]];
    const survived = await spotifyPool().rebuild();
    assert.equal(survived.tracks.size, 2, 'the library survives a rebuild that could not read anything');
    assert.equal(survived.partial, true, 'and says it is incomplete, which stands the reconcile down');
    assert.deepEqual(
      (await spotifySource.getRecentSongs!({ size: 10 })).map((s: any) => s.title),
      ['Newer', 'Older'],
      'so the station keeps answering picks from what it already had',
    );
  } finally {
    stubRoutes = [];
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_REFRESH_TOKEN;
    writeFileSync(path.join(stateRoot, 'settings.json'), '{}');
    setCache(null);
    await settings.load();
  }
});
