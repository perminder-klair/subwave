// SpotifyMusicSource — "what music exists" on Spotify, in the MusicSource
// contract. Catalog only: playback is the SpotifyPlaybackController's job and
// audio transport is librespot's (see docs/spotify-source.md).
//
// The Spotify catalog is unbounded, so the station's LIBRARY on Spotify is the
// operator's pool (sources/spotify/pool.ts): their playlists, optionally saved
// tracks/albums. Random, genre, browse and the tagger walk draw from the pool;
// search, lookups and artist queries go to the Web API directly.
//
// Every song list passes through blocklist.rejectBlocked — the same chokepoint
// the Subsonic client uses — so the never-play list is enforced identically.
//
// What February 2026's Web API restrictions cost this source (client.ts has the
// full list): no top-songs at all (hasTopSongs:false), search answers ten at a
// time so anything wanting more pages, and /me no longer reports the account
// tier so ping() can require Premium but not verify it.

import * as settings from '../../../settings.js';
import * as blocklist from '../../blocklist.js';
import { saveSecrets } from '../../../setup/secrets.js';
import type { MusicSource, Song, Album, Artist, CoverArt, AnalyzableRef } from '../types.js';
import { SpotifyClient, SPOTIFY_PAGE_MAX, SPOTIFY_SEARCH_MAX, type SpotifyCredentials } from './client.js';
import { SpotifyPoolCache, sample, type PoolConfig } from './pool.js';
import { mapTrack, mapAlbum, mapArtist, mapPlaylist, unwrapItem, trackIdFromUri } from './map.js';
import { listMyPlaylists, listSavedAlbums, listSavedTracks, getAlbumRaw, searchRaw } from './reads.js';
import { readReceiverDeviceName } from './token-file.js';
import { readHold, writeHold, clearHold } from './hold-file.js';
import { unplayableIds } from './unplayable-file.js';
import { rankAlternatives } from './alternative-pure.js';
import { strace, traceWanted } from './trace.js';
import { SPOTIFY_DEFAULT_DEVICE_NAME } from '../../../settings/liquidsoap.js';

export const SPOTIFY_SOURCE_ID = 'spotify';

const log = (line: string) => console.log(line);

// Credentials are read LAZILY from process.env: state/secrets.env is loaded
// into the environment at boot (setup/secrets.ts), after module evaluation.
export function spotifyCredentials(): SpotifyCredentials {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
  };
}

let client: SpotifyClient | null = null;
export function spotifyClient(): SpotifyClient {
  if (!client) {
    client = new SpotifyClient({
      credentials: spotifyCredentials,
      log,
      // The pacer's ceiling, read fresh per request so an operator's edit lands
      // without a restart. It is a STARTING point — the client halves it on a
      // 429 and eases back, because Spotify publishes no Development Mode
      // number and the budget is shared across the whole developer account.
      // NaN when unset — configuredCeiling() falls back to its own default
      // rather than letting a missing setting become a zero ceiling.
      requestsPer30s: () => Number(spotifySettings().quota?.requestsPer30s),
      // A hold outlives the process. Injected rather than imported inside the
      // client so that module keeps no filesystem edge.
      loadHold: () => readHold(),
      saveHold: (hold) => writeHold(hold),
      clearHold: () => clearHold(),
      // A rotated refresh token must land in secrets.env or the next boot logs
      // in with a dead one. saveSecrets also updates process.env.
      onRefreshToken: async (token) => {
        try { await saveSecrets({ SPOTIFY_REFRESH_TOKEN: token }); }
        catch (err: any) { log(`[spotify] could not persist rotated refresh token: ${err?.message ?? err}`); }
      },
      // No onAccessToken: this app's tokens are NOT what the receiver logs in
      // with (see receiver-auth.ts) — writing them to the token file is what
      // produced INVALID_CREDENTIALS at the Connect handshake.
    });
  }
  return client;
}

export function spotifySettings(): any {
  return (settings.get() as any)?.spotify ?? {};
}

// The Connect name to resolve the receiver by. The name the RUNNING receiver
// registered with (written by its wrapper at launch) beats the settings, which
// describe the NEXT boot — a station rename with the old station-name default
// orphaned a live receiver once already. One copy, shared by the transport's
// playback controller and the doctor: a second composition of this would drift
// and each would report a different device as missing.
export function receiverDeviceName(): string {
  return readReceiverDeviceName() || spotifySettings().deviceName || SPOTIFY_DEFAULT_DEVICE_NAME;
}

function poolConfig(): PoolConfig {
  const s = spotifySettings();
  const pool = s.pool ?? {};
  return {
    playlistIds: Array.isArray(pool.playlistIds) ? pool.playlistIds.map(String) : [],
    includeSaved: pool.includeSaved !== false,
    includeSavedAlbums: pool.includeSavedAlbums === true,
    maxTracks: Number.isFinite(Number(pool.maxTracks)) && Number(pool.maxTracks) > 0 ? Number(pool.maxTracks) : 5000,
    // Pacing, not curation — poolConfigSignature() deliberately ignores both,
    // so changing one never throws the pool away and re-walks the catalogue.
    fullWalkHours: Number.isFinite(Number(pool.fullWalkHours)) && Number(pool.fullWalkHours) > 0 ? Number(pool.fullWalkHours) : 24,
    genresPerHour: Number.isFinite(Number(s.quota?.genresPerHour)) ? Number(s.quota.genresPerHour) : 750,
  };
}

let pool: SpotifyPoolCache | null = null;
export function spotifyPool(): SpotifyPoolCache {
  if (!pool) pool = new SpotifyPoolCache(spotifyClient, poolConfig, log);
  return pool;
}

// ── helpers ─────────────────────────────────────────────────────────────────

// The one filter every song list this source hands back passes through — which
// is why the refused-track memory is applied HERE and nowhere else on the pick
// side. The pool picker, every agent discovery tool and the transport's own
// pool fallback all read through one of the functions below, so they inherit it
// with no new enforcement site, exactly as they inherit the blocklist.
//
// `isPlayable` is kept but is inert in practice: Spotify only populates
// `is_playable` when a `market` is supplied, and since February 2026 nothing can
// derive one (client.ts). unplayableIds() is what actually knows.
const keep = (songs: Array<Song | null>, includeBlocked = false): Song[] => {
  const refused = unplayableIds();
  const list = songs.filter((s): s is Song =>
    !!s && s.isPlayable !== false && !refused.has(s.id));
  return includeBlocked ? list : blocklist.rejectBlocked(list);
};

// Stamp artist genres from the pool's cache onto API-fetched tracks (search,
// lookups) when we happen to have them — no extra request either way.
function withPoolGenres(songs: Song[]): Song[] {
  const p = spotifyPool().peek();
  if (!p) return songs;
  for (const s of songs) {
    if (s.genres?.length) continue;
    const g = s.artistId ? p.artistGenres.get(s.artistId) : undefined;
    if (g?.length) { s.genres = g; s.genre = g[0]; }
  }
  return songs;
}

const normGenre = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normName = (s: unknown) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// /search caps `limit` at 10 since February 2026, but the picker asks for 25–40
// in one call, so ONE logical search is three HTTP requests. The paging and the
// memo both live in reads.ts now: the picker's tools retry a search at a
// different offset and then re-search under a resolved artist name, and the
// listener-request matcher issues up to four searches for a single request, so
// the same query recurs constantly both within a pick and across consecutive
// ones. The callers here are unchanged — they still ask for a count and get one.
async function searchPaged(q: string, type: 'track' | 'artist', want: number, offset = 0): Promise<any[]> {
  return searchRaw(spotifyClient(), q, type, Math.max(1, want), offset);
}

function yearOk(s: Song, fromYear?: number, toYear?: number): boolean {
  if (fromYear == null && toYear == null) return true;
  if (s.year == null) return false;
  if (fromYear != null && s.year < fromYear) return false;
  if (toYear != null && s.year > toYear) return false;
  return true;
}

// ── core ────────────────────────────────────────────────────────────────────

async function ping(): Promise<{ ok: boolean; reason?: string }> {
  const c = spotifyClient();
  if (!c.hasCredentials()) {
    return { ok: false, reason: 'Spotify is not connected — add the client id/secret and press Connect in Settings → Music source' };
  }
  try {
    const me: any = await c.getMe();
    // February 2026 removed `product` (and `country`) from /me, so Premium can
    // no longer be PROBED — only required. Report what the account is, and say
    // plainly that the tier is unknown rather than asserting "· premium" off a
    // check that now always passes because the field is simply absent.
    const product = String(me?.product ?? '');
    if (product && product !== 'premium') {
      return { ok: false, reason: `Spotify account "${me?.display_name ?? me?.id}" is ${product}; Spotify Connect playback needs Premium` };
    }
    const who = me?.display_name ?? me?.id ?? 'account';
    return { ok: true, reason: product ? `${who} · ${product}` : `${who} · connected (Spotify no longer reports the account tier; Connect playback needs Premium)` };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'unreachable' };
  }
}

async function search(query: any, { songCount = 20, songOffset = 0, includeBlocked = false } = {}): Promise<Song[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // A pasted Spotify link/URI is a lookup, not a search.
  const direct = trackIdFromUri(q);
  if (direct) {
    const one = await getSong(direct);
    return one ? keep([one], includeBlocked) : [];
  }
  const items = await searchPaged(q, 'track', songCount, songOffset);
  return withPoolGenres(keep(items.map((t: any) => mapTrack(t)), includeBlocked));
}

async function getSong(id: any): Promise<Song | null> {
  const key = trackIdFromUri(String(id ?? '')) ?? String(id ?? '');
  const cached = spotifyPool().peek()?.tracks.get(key);
  if (cached) return cached;
  const t: any = await spotifyClient().getTrack(key);
  const song = mapTrack(t);
  return song ? withPoolGenres([song])[0] : null;
}

// Memoised in reads.ts, because this was the single most-repeated uncached call
// the station made: the picker's recently-added tool fans out over five albums
// per invocation and the pool picker over as many as fourteen, per pick, and
// nothing anywhere remembered one. The rows come back RAW and are mapped here
// on every call — callers mutate the Songs they get (the queue stamps transient
// fields on them, withPoolGenres writes genres in), so sharing mapped objects
// would alias one pick's bookkeeping into another's.
async function getAlbum(id: any): Promise<Song[]> {
  const raw = await getAlbumRaw(spotifyClient(), String(id));
  if (!raw) return [];
  return withPoolGenres(keep(raw.items.map((t) => mapTrack(t, { album: raw.album }))));
}

async function getArtist(id: any): Promise<Artist | null> {
  const c = spotifyClient();
  const a: any = await c.getArtist(String(id));
  const artist = mapArtist(a);
  if (!artist) return null;
  let album: Album[] = [];
  try {
    const r: any = await c.getArtistAlbums(artist.id, { limit: SPOTIFY_PAGE_MAX });
    album = (r?.items ?? []).map(mapAlbum).filter(Boolean) as Album[];
  } catch { /* an artist with no readable albums is still an artist */ }
  return { ...artist, album };
}

async function searchArtists(query: any, { artistCount = 5 } = {}): Promise<Artist[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const items = await searchPaged(q, 'artist', artistCount);
  return items.map(mapArtist).filter(Boolean) as Artist[];
}

// Start the background artist-genre drip. Called from the transport's start,
// which is already the "Spotify is the active source" gate — the drip is
// pointless on a station that is not playing from Spotify, and it must not run
// on one that merely has credentials configured.
export function startSpotifyGenreDrip(): void {
  spotifyPool().startGenreDrip();
}

async function getGenres() {
  const p = await spotifyPool().get();
  return [...p.genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, songCount]) => ({ value, songCount }));
}

async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}): Promise<Song[]> {
  const p = await spotifyPool().get();
  const g = genre ? normGenre(genre) : null;
  const candidates = [...p.tracks.values()].filter((s) =>
    (!g || (s.genres ?? []).some((x: string) => normGenre(x) === g)) && yearOk(s, fromYear, toYear));
  return keep(sample(candidates, size));
}

async function getSongsByGenre(genre: any, { count = 20 } = {}): Promise<Song[]> {
  const fromPool = await getRandomSongs({ size: count, genre: String(genre) });
  if (fromPool.length) return fromPool;
  // Off-pool fallback: Spotify's own genre filter, at a random page so repeat
  // calls do not return the same handful.
  try {
    const offset = Math.floor(Math.random() * 5) * SPOTIFY_SEARCH_MAX;
    const items = await searchPaged(`genre:"${String(genre)}"`, 'track', count, offset);
    return keep(sample(items.map((t: any) => mapTrack(t)), count));
  } catch {
    return [];
  }
}

async function getSongsByGenreSampled(genre: any, { count = 20 } = {}): Promise<Song[]> {
  return getSongsByGenre(genre, { count });
}

async function getAlbumList(offset = 0, size = 500): Promise<Album[]> {
  const p = await spotifyPool().get();
  return [...p.albums.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(offset, offset + size);
}

// The full catalogue walk. Deliberately UNFILTERED — `keep()` is not applied.
//
// This is the library, not the playable set, and its only consumers are the
// tagger, the analyzer and coverage. Filtering the blocklist here (which is
// what it used to do, diverging from Navidrome's walk in music/subsonic.ts)
// made a blocked track look DELETED to the orphan reconcile, so blocking a
// track silently threw away its tags, moods and embedding on the next tagging
// run. Nothing plays as a result of being yielded here: the blocklist is
// enforced at every pick path and again at queue.push() as the last line.
// `isPlayable` is likewise a live-market judgement about right now, not a
// statement about whether the track is in the operator's playlists.
async function* iterateAllSongs(): AsyncGenerator<Song> {
  const p = await spotifyPool().get();
  for (const s of p.tracks.values()) yield s;
}

// Whether that walk can be trusted as the complete live library — asked only by
// the orphan reconcile, which DELETES everything it did not see. Spotify's pool
// has three ways to come back short while still looking healthy, and all three
// are indistinguishable from the operator deleting tracks:
//   • `partial` — a playlist 403'd, or a page walk failed mid-way;
//   • a closed rate-limit gate — the walk may have been cut short, and a
//     rebuild is being suppressed anyway, so this pool is not fresh;
//   • `truncated` — the walk stopped at maxTracks, so it is a prefix by design.
// Subsonic implements none of this and prunes as it always has.
async function catalogHealth(): Promise<{ complete: boolean; reason?: string }> {
  const hold = spotifyClient().rateLimitHold();
  if (hold.msLeft > 0) {
    return {
      complete: false,
      reason: hold.kind === 'quota'
        ? `Spotify's developer-account quota is exhausted (${Math.ceil(hold.msLeft / 1000)}s left), so the catalogue walk may be short`
        : `Spotify is rate-limiting the station (${Math.ceil(hold.msLeft / 1000)}s left), so the catalogue walk may be short`,
    };
  }
  const p = spotifyPool().peek();
  if (!p) return { complete: false, reason: 'the Spotify pool has not been built yet' };
  // A snapshot restored from disk was walked by some EARLIER process. It is
  // perfectly good to play from — that is the whole point of persisting it —
  // but the reconcile deletes the tags, moods and vectors of every track the
  // walk did not yield, and "did not yield" against a file written days ago on
  // a different set of playlists is not a statement about the live library.
  // Fails closed until this process has confirmed the pool itself.
  if (p.fromDisk) {
    return { complete: false, reason: 'the Spotify pool was restored from its saved snapshot and has not been re-checked against Spotify since this controller started' };
  }
  if (p.partial) {
    return { complete: false, reason: `the last Spotify pool build was incomplete — ${p.notes[0] ?? 'a source page failed'}` };
  }
  if (p.truncated) {
    return { complete: false, reason: `the pool stopped at its ${p.tracks.size}-track cap (spotify.pool.maxTracks), so the walk is a prefix of the library` };
  }
  return { complete: true };
}

async function getCoverArt(id: string): Promise<CoverArt | null> {
  const p = spotifyPool().peek();
  const fromPool = p?.tracks.get(id)?._imageUrl ?? p?.albums.get(id)?._imageUrl;
  if (fromPool) return { url: fromPool };
  const c = spotifyClient();
  const t: any = await c.getTrack(id);
  const song = mapTrack(t);
  if (song?._imageUrl) return { url: song._imageUrl };
  const a: any = await c.getAlbum(id).catch(() => null);
  const album = mapAlbum(a);
  return album?._imageUrl ? { url: album._imageUrl } : null;
}

// Spotify exposes no audio bytes — every analyzer-derived column stays NULL.
async function getAnalyzableRef(): Promise<AnalyzableRef | null> {
  return null;
}

async function resolveGenreName(name: any): Promise<string | null> {
  const target = normGenre(name);
  if (!target) return null;
  const genres = await getGenres();
  const exact = genres.find((g) => normGenre(g.value) === target);
  if (exact) return exact.value;
  const loose = genres.find((g) => {
    const gv = normGenre(g.value);
    return gv && (gv.includes(target) || target.includes(gv));
  });
  return loose?.value ?? null;
}

async function resolveArtist(name: any, { artistCount = 10 } = {}): Promise<Artist | null> {
  const query = normName(name);
  if (!query) return null;
  const found = await searchArtists(String(name), { artistCount });
  const exact = found.find((a) => normName(a.name) === query);
  if (exact) return exact;
  // Spotify's search already ranks fuzzily; accept the top hit only when it
  // shares a token with the query, so "Drake" cannot resolve to "Blake".
  const tokens = new Set(query.split(' ').filter((t) => t.length >= 2));
  const top = found[0];
  if (top && normName(top.name).split(' ').some((t) => tokens.has(t))) return top;
  return null;
}

async function getRecentSongsByArtist(artistName: any, { albums = 3, count = 20 } = {}): Promise<Song[]> {
  const artist = await resolveArtist(artistName);
  if (!artist?.id) return [];
  const c = spotifyClient();
  const r: any = await c.getArtistAlbums(artist.id, { limit: SPOTIFY_PAGE_MAX });
  const list = ((r?.items ?? []) as any[])
    .sort((x, y) => String(y.release_date ?? '').localeCompare(String(x.release_date ?? '')))
    .slice(0, albums);
  const songs: Song[] = [];
  for (const a of list) {
    try { songs.push(...(await getAlbum(a.id))); } catch { /* skip an unreadable album */ }
    if (songs.length >= count) break;
  }
  return songs.slice(0, count);
}

// ── optional (capabilities: starred, playlists, recently added) ─────────────
//
// No getTopSongs: February 2026 removed GET /artists/{id}/top-tracks with no
// replacement, and `popularity` went with it, so there is nothing left to rank
// by. capabilities.ts declares hasTopSongs:false for spotify rather than having
// this return [] — a picker tool offered without a backing index spends the
// model's discovery call on a guaranteed-empty answer.

async function getStarred(): Promise<Song[]> {
  // Two requests, and it is asked for by the auto-playlist refresh, the pool
  // picker's thin-pool rescue, the starred-songs picker tool and every
  // unmatched listener request — so it is memoised in reads.ts rather than here.
  const items = await listSavedTracks(spotifyClient());
  const out: Song[] = [];
  for (const item of items) {
    const t = unwrapItem(item);
    const s = t ? mapTrack(t, { addedAt: item?.added_at }) : null;
    if (s) out.push(s);
  }
  return withPoolGenres(keep(out));
}

// The admin's shows/blocklist tabs ask /dj/playlists on every render and each
// answer used to be a fresh paginated walk — 429s within a minute on the first
// real run. The memo now lives in reads.ts, SHARED with the pool build, which
// was walking the same listing separately; it also finally has an invalidation
// hook, so "Rebuild pool now" no longer leaves the show editor five minutes
// behind the account.
async function getPlaylists() {
  const raw = await listMyPlaylists(spotifyClient());
  return raw.map(mapPlaylist).filter(Boolean);
}

async function getPlaylist(id: any): Promise<Song[]> {
  const c = spotifyClient();
  const out: Song[] = [];
  for await (const item of c.paginate<any>((o) => c.getPlaylistItems(String(id), { offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
    const t = unwrapItem(item);
    const s = t ? mapTrack(t, { addedAt: item?.added_at }) : null;
    if (s) out.push(s);
  }
  return withPoolGenres(keep(out));
}

async function getRecentlyAddedAlbums({ size = 20 } = {}): Promise<Album[]> {
  // One page is fetched and shared; callers ask for 8, 12, 20 and 50, so the
  // memo deliberately ignores `size` and each caller slices (reads.ts).
  const items = await listSavedAlbums(spotifyClient());
  return items
    .slice(0, Math.min(SPOTIFY_PAGE_MAX, Math.max(1, size)))
    .map((it) => {
      const a = mapAlbum(it?.album);
      if (a) a.created = it?.added_at;
      return a;
    })
    .filter(Boolean) as Album[];
}

// The newest TRACKS, straight out of the pool.
//
// This is what `GET /dj/recent` actually wants, and answering it the generic
// way — newest albums, then every album's tracks — cost ONE REQUEST PER ALBUM.
// At the admin Library tab's `limit=50` that was ~51 metered requests for one
// panel, the most expensive call in the codebase, with no cache anywhere on the
// path. The pool already stamps each track's `added_at` as `created` when it
// walks playlists and saved tracks/albums (map.ts), so the answer is a sort
// over memory and costs nothing.
//
// An empty array means "I cannot answer" and the route falls back to the album
// fan-out — which is the right behaviour on a cold pool, and the reason this
// must not return a short list rather than none. `get()` rather than `peek()`:
// a pool build is bounded, single-flight and cached for half an hour, so it is
// strictly cheaper than the fan-out it replaces, and every other pick path
// would have built it moments later anyway.
async function getRecentSongs({ size = 20 } = {}): Promise<Song[]> {
  const p = await spotifyPool().get();
  const dated = [...p.tracks.values()].filter((s) => s.created);
  if (!dated.length) return [];
  dated.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return keep(dated).slice(0, Math.max(1, size));
}

// "That release is refused — is the same recording on another one?"
//
// ONE request, and only when it can be afforded. Three rules, all of them about
// the metered quota rather than about matching:
//
//  • FOREGROUND lane. Deliberately not `critical` — that is the /me/player/*
//    block and nothing else, and an exempt lane may not arm the gate. A
//    substitute is a nice-to-have; the station keeps making sound without one.
//  • Skipped outright while the gate is shut. Left to the foreground lane's own
//    behaviour this would WAIT OUT a short window, and that delay lands directly
//    in the seam. A rate-limit episode must not become a search storm either.
//  • Exactly ten results, so it is ONE page. /search caps `limit` at 10, and
//    asking for more makes searchPaged issue three HTTP requests for one
//    logical search. Never raise it "to find more versions": the ranking refuses
//    almost everything anyway.
//
// The `searchRaw` memo covers the repeats — the same track refused twice inside
// the TTL costs one request, not two, and a search that 429s is not re-issued.
export const ALTERNATIVE_SEARCH_LIMIT = 10;

export async function findAlternativeTrack(want: Song): Promise<Song | null> {
  const title = String(want?.title ?? '').trim();
  const artist = String(want?.artist ?? '').trim();
  if (!title || !artist) return null;

  const hold = spotifyClient().rateLimitHold();
  if (hold.msLeft > 0) {
    strace('alternative', `skipping the alternative search for "${title}" — Spotify is holding us off for ${Math.ceil(hold.msLeft / 1000)}s`);
    return null;
  }

  let rows: any[];
  try {
    rows = await searchPaged(`track:"${title}" artist:"${artist}"`, 'track', ALTERNATIVE_SEARCH_LIMIT);
  } catch (err: any) {
    strace('alternative', `alternative search for "${title}" failed: ${err?.message ?? err}`);
    return null;
  }

  // The candidate list is filtered by keep() first, so anything already refused
  // (or blocked) is gone before ranking; `unplayableIds()` is passed as well so
  // the notes can say WHY a row was skipped rather than it silently vanishing.
  const candidates = withPoolGenres(keep(rows.map((t: any) => mapTrack(t))));
  const { ranked, notes } = rankAlternatives(want, candidates, unplayableIds());
  if (traceWanted()) {
    strace('alternative', `alternative search for "${title}": ${rows.length} rows, ${ranked.length} usable`, {
      wantId: want.id,
      candidates: notes.map((n) => ({ id: n.id, title: n.title, rejected: n.rejected })),
    });
  }
  return ranked[0] ?? null;
}

export const spotifySource: MusicSource = {
  id: SPOTIFY_SOURCE_ID,
  ping,
  search,
  getSong,
  getAlbum,
  getArtist,
  searchArtists,
  getGenres,
  getRandomSongs,
  getSongsByGenre,
  getSongsByGenreSampled,
  getAlbumList,
  iterateAllSongs,
  catalogHealth,
  getCoverArt,
  getAnalyzableRef,
  resolveGenreName,
  resolveArtist,
  getRecentSongsByArtist,
  // No playback URI builders: Spotify plays through the live transport
  // (capabilities.hasLiveTransport) — the queue never asks for one.
  getStarred,
  getPlaylists,
  getPlaylist,
  getRecentlyAddedAlbums,
  getRecentSongs,
};
