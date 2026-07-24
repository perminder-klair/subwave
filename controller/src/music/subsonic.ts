// Subsonic API client for Navidrome.
// Uses the proper salt+token auth (not plaintext password).

import crypto from 'node:crypto';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as subLog from './subsonic-log.js';
import * as blocklist from './blocklist.js';

function buildAuth() {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto
    .createHash('md5')
    .update(config.navidrome.password + salt)
    .digest('hex');
  return { u: config.navidrome.user, t: token, s: salt };
}

function buildUrl(endpoint, params = {}) {
  const url = new URL(`${config.navidrome.url}/rest/${endpoint}`);
  const auth = buildAuth();
  url.searchParams.set('u', auth.u);
  url.searchParams.set('t', auth.t);
  url.searchParams.set('s', auth.s);
  url.searchParams.set('v', config.navidrome.apiVersion);
  url.searchParams.set('c', config.navidrome.clientName);
  url.searchParams.set('f', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // Subsonic repeats some params (songId, songIdToAdd, songIndexToRemove) —
    // arrays append one query param per element.
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Song-carrying response paths — hand-curated. Add an entry when a NEW
// endpoint returns SONGS that should count toward the song-coverage map in
// subsonic-log.js ("is the picker drawing from the whole library or a narrow
// pool?"). Not auto-derived from response shape: only endpoints whose array
// elements are individual tracks belong here.
const SONG_PATHS = [
  ['searchResult3', 'song'], ['randomSongs', 'song'], ['songsByGenre', 'song'],
  ['similarSongs2', 'song'], ['starred2', 'song'], ['topSongs', 'song'],
  ['album', 'song'], ['playlist', 'entry'],
];

// Non-song response paths — albums, artists, genres, playlists. Used only to
// populate the log's `count` field so /debug reflects how many items every
// endpoint actually returned (a getGenres call that returns 40 genres used to
// log as count:0). These shapes do NOT feed song-coverage analytics.
const OTHER_PATHS = [
  ['albumList2', 'album'], ['searchResult3', 'album'],
  ['searchResult3', 'artist'], ['genres', 'genre'],
  ['playlists', 'playlist'], ['artist', 'album'],
];

// The OpenSubsonic `sonicSimilarity` extension returns a different shape from
// every other song endpoint: a `sonicMatch` array whose elements wrap the song
// in `entry` alongside a `similarity` score, rather than a flat song array.
// Some servers nest it under `sonicSimilarTracks`; tolerate both, and fall back
// to the element itself for servers that inline the Child. Shared by the public
// getter and the coverage-logging extractor so /debug analytics stay accurate.
function sonicSimilarSongs(sub: any): any[] {
  const matches = sub?.sonicMatch ?? sub?.sonicSimilarTracks?.sonicMatch ?? [];
  if (!Array.isArray(matches)) return [];
  return matches.map((m: any) => m?.entry ?? m?.song ?? m).filter(Boolean);
}

function extractSongs(sub) {
  for (const [a, b] of SONG_PATHS) {
    const v = sub[a]?.[b];
    if (Array.isArray(v)) return v;
  }
  // sonicSimilarity uses the `sonicMatch` wrapper shape, not a SONG_PATHS entry.
  const sonic = sonicSimilarSongs(sub);
  if (sonic.length) return sonic;
  return [];
}

// Total items in the response: songs if any, else the first non-song shape
// that matches. Both paths are checked because search3 returns songs AND
// artists in the same response — songs win when present.
function extractCount(sub, songs) {
  if (songs.length > 0) return songs.length;
  for (const [a, b] of OTHER_PATHS) {
    const v = sub[a]?.[b];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

async function call(endpoint, params = {}) {
  const started = Date.now();
  try {
    const url = buildUrl(endpoint, params);
    // Bounded fetch: a hung Navidrome must fail fast, not pin the request
    // (and every admin route queued behind it) forever (#786). The abort
    // rejects with a TimeoutError, translated into a readable message.
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(config.navidrome.timeoutMs) });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(
          `Subsonic ${endpoint} timed out after ${config.navidrome.timeoutMs}ms — is Navidrome responding?`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      // Capture the first 200 chars of the body so outage triage gets the
      // actual server message (Cloudflare 522, Navidrome 5xx detail, etc.)
      // instead of just a bare status code.
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`Subsonic ${endpoint} failed: ${res.status}${body ? ` — ${body}` : ''}`);
    }
    const data = await res.json() as any;
    const sub = data['subsonic-response'];
    if (sub.status !== 'ok') throw new Error(`Subsonic error: ${sub.error?.message || 'unknown'}`);
    const songs = extractSongs(sub);
    subLog.record({
      t: new Date().toISOString(), endpoint, params, ms: Date.now() - started,
      ok: true, count: extractCount(sub, songs),
      // Songs carry both id and title; non-song shapes (albums, artists,
      // genres, playlists) are reflected in `count` above but not here.
      songIds: songs
        .filter((i: any) => i?.id && i?.title)
        .map((i: any) => ({ id: i.id, title: i.title, artist: i.artist })),
    });
    return sub;
  } catch (err) {
    subLog.record({
      t: new Date().toISOString(), endpoint, params, ms: Date.now() - started,
      ok: false, count: 0, songIds: [], error: err.message,
    });
    throw err;
  }
}

// Lightweight connectivity + auth check for the admin Doctor. Hits the cheapest
// Subsonic endpoint (`ping`) with the controller's own salt+token creds — mirrors
// the CLI wizard's probeSubsonic but against config.navidrome. Never throws.
//
// A failure that lands instantly gets ONE retry: Node's pooled fetch sockets go
// stale between the controller's bursty Subsonic calls, so a one-off
// ECONNRESET / "fetch failed" on connection reuse is routine, not an outage —
// and since the admin NavidromeBanner alarms on a single failed ping (cached
// 20s), an un-retried blip reads as "Navidrome is down" to the operator. Slow
// failures (the 30s timeout) don't retry: a second wait wouldn't change the
// answer, just pin the caller for another timeoutMs.
const PING_RETRY_IF_FASTER_THAN_MS = 2_000;

export async function ping(): Promise<{ ok: boolean; reason?: string }> {
  if (!config.navidrome.url || !config.navidrome.user || !config.navidrome.password) {
    return { ok: false, reason: 'Navidrome URL / username / password not configured' };
  }
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      await call('ping');
      return { ok: true };
    } catch (err: any) {
      const failedFast = Date.now() - started < PING_RETRY_IF_FASTER_THAN_MS;
      if (attempt === 0 && failedFast) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      return { ok: false, reason: err?.message || 'unreachable' };
    }
  }
}

// One-off connectivity + auth probe with ARBITRARY creds — the shared engine
// behind the onboarding wizard's "Test connection" and the admin Settings
// Music-source test/save flow. Unlike ping() it never touches config.navidrome
// and never mutates anything; callers pass exactly what to try. Never throws.
//
// One retry on ANY first failure — broader than ping()'s fast-fail-only rule,
// deliberately. ping()'s 30s timeout makes a slow retry expensive; this probe
// is 5s-bounded, so the retry costs at most ~5.5s against a truly-dead server.
// It covers both failure shapes of a warm-but-stale connection pool: the
// instant reset on reusing a stale socket, AND the full-timeout stall seen
// when the Navidrome process restarts under pooled connections (the aborted
// attempt's teardown is what un-wedges the pool, so the second try connects
// fresh). A Test button reporting either blip as "unreachable" sends the
// operator chasing a config that actually works.
export async function pingWith(target: {
  url: string;
  user: string;
  pass: string;
  client?: string;
}): Promise<{ ok: boolean; serverVersion?: string; serverType?: string; error?: string }> {
  const first = await pingWithOnce(target);
  if (first.ok) return first;
  await new Promise(resolve => setTimeout(resolve, 500));
  return pingWithOnce(target);
}

async function pingWithOnce({
  url,
  user,
  pass,
  client = 'sub-wave-admin',
}: {
  url: string;
  user: string;
  pass: string;
  client?: string;
}): Promise<{ ok: boolean; serverVersion?: string; serverType?: string; error?: string }> {
  try {
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(pass + salt).digest('hex');
    const probeUrl = new URL(`${url.replace(/\/$/, '')}/rest/ping`);
    probeUrl.searchParams.set('u', user);
    probeUrl.searchParams.set('t', token);
    probeUrl.searchParams.set('s', salt);
    probeUrl.searchParams.set('v', '1.16.1');
    probeUrl.searchParams.set('c', client);
    probeUrl.searchParams.set('f', 'json');

    const res = await fetch(probeUrl.toString(), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `Subsonic ping returned HTTP ${res.status}` };

    const body: any = await res.json();
    const sub = body?.['subsonic-response'];
    if (sub?.status !== 'ok') {
      return { ok: false, error: sub?.error?.message || 'Subsonic responded but auth failed' };
    }
    return { ok: true, serverVersion: sub.version, serverType: sub.type || 'unknown' };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, error: 'Navidrome did not respond within 5s' };
    }
    return { ok: false, error: err?.message || 'Navidrome unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Station-archive guard
// ---------------------------------------------------------------------------
// SUB/WAVE's own hourly mixdowns are written by radio.liq to
// `/var/sub-wave/archive/YYYY-MM-DD/HH-00.mp3`. If the operator's Navidrome music
// folder overlaps that directory, Navidrome scans those MP3s and indexes them as
// untagged songs whose filename ("02-00.mp3") becomes the title — they then leak
// into the picker (DJ reads "02:00" as the time), the tagger, and the library UI
// (issue #273). Every selection/enumeration path funnels through the song-returning
// functions below, so filtering here keeps station recordings out of all of them.
// `call()` logging is untouched, so /debug still shows the raw Subsonic responses.
export function isStationArchive(song: any): boolean {
  if (!song) return false;
  const path = String(song.path ?? '');
  // Primary, tight signal: the archive path pattern radio.liq writes.
  if (/(^|\/)archive\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.mp3$/i.test(path)) return true;
  // Fallback when Navidrome omits `path`: an HH-00 title with no real artist/album.
  const title = String(song.title ?? '').trim();
  const blank = (s: any) => {
    const v = String(s ?? '').trim().toLowerCase();
    return v === '' || v.startsWith('[unknown') || v === 'unknown artist' || v === 'unknown album';
  };
  return /^\d{2}-00$/.test(title) && blank(song.artist) && blank(song.album);
}

// The global never-play blocklist rides the same chokepoint: every
// song-returning function below already filters through rejectArchive, so
// blocked tracks/albums/artists drop out of search, random, genre, similar,
// starred, top-songs, album and playlist results — i.e. every picker source,
// agent tool, and request-resolution path — in one place.
const rejectArchive = (arr: any[]) =>
  blocklist.rejectBlocked((arr || []).filter((s) => !isStationArchive(s)));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// `includeBlocked` is for the ADMIN search surface only (/dj/search — the
// library Search tab + studio queue picker): the operator must still be able
// to find a blocked track to review it, and a manual queue attempt is refused
// at the queue.push gate anyway. Every airing path (picker tools, request
// resolution) uses the default and never sees blocked songs.
export async function search(query, { songCount = 20, songOffset = 0, includeBlocked = false } = {}) {
  const r = await call('search3', { query, songCount, songOffset, artistCount: 5, albumCount: 5 });
  const songs = (r.searchResult3?.song || []).filter((s) => !isStationArchive(s));
  return includeBlocked ? songs : blocklist.rejectBlocked(songs);
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}) {
  const r = await call('getRandomSongs', { size, genre, fromYear, toYear });
  return rejectArchive(r.randomSongs?.song || []);
}

export async function getSongsByGenre(genre, { count = 20 } = {}) {
  const r = await call('getSongsByGenre', { genre, count });
  return rejectArchive(r.songsByGenre?.song || []);
}

// Every genre tag on a song, deduped. OpenSubsonic servers (Navidrome ≥0.54)
// send the multi-value `genres: [{name}]` array alongside the legacy scalar
// `genre`; older Subsonic servers send only the scalar. The array is
// authoritative (its first entry is normally the scalar); the scalar is the
// fallback so a plain-Subsonic backend still yields a one-element array.
// The single normaliser for per-track genre ingest — everything downstream
// (library-db genres column, picker/show filters, annotate) goes through it.
export function songGenres(song: { genres?: unknown; genre?: unknown } | null | undefined): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? '').trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  if (Array.isArray(song?.genres)) {
    for (const g of song.genres) push(typeof g === 'string' ? g : (g as { name?: unknown })?.name);
  }
  push(song?.genre);
  return out;
}

// All genre tags present in the library, each with { value, songCount,
// albumCount }. Used to resolve a listener's free-text genre ("hip hop") to
// the exact tag the library actually carries ("Hip-Hop").
export async function getGenres() {
  const r = await call('getGenres');
  return r.genres?.genre || [];
}

// Fuzzy-match free text ("hip hop", "turkish") against the library's real
// genre tags ("Hip-Hop", "Turkish Pop"). Exact normalised match wins, then
// substring either way. Returns the exact tag value or null. getGenres
// failures propagate — callers decide whether to log or fall through.
export async function resolveGenreName(name) {
  if (!name) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  const genres = await getGenres();
  let hit = genres.find(g => norm(g.value) === target);
  if (!hit) {
    hit = genres.find(g => {
      const gv = norm(g.value);
      return gv && (gv.includes(target) || target.includes(gv));
    });
  }
  return hit?.value || null;
}

// ---------------------------------------------------------------------------
// Fuzzy artist resolution
// ---------------------------------------------------------------------------
// Navidrome's search3 does exact token/substring matching only, so a one-letter
// transliteration variance ("Sikandar" vs the library's "Sikander") or a
// dropped accent ("Beyonce" vs "Beyoncé") returns zero artists, and a bare
// "play <artist>" request silently falls through to mood filler. resolveArtist
// is to artists what resolveGenreName is to genres: normalise the free text,
// try an exact index hit, then relax to per-token index searches and
// fuzzy-rank the candidates against the whole request. Returns the best
// matching artist object ({ id, name, ... }) or null. Library-relative — it
// ranks against whatever artists THIS operator actually has, so it needs no
// per-library data and works on every install.

function normArtist(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')                       // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic Levenshtein edit distance. Inputs are short artist names, so the
// O(m·n) two-row implementation is plenty.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// 0..1 similarity (1 = identical), normalised by the longer string's length.
function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - editDistance(a, b) / longer;
}

// Tuned so "Sikandar Kahlon" (0.93) clears it but "Drake"/"Blake" (0.60) does
// not. Paired with a shared-token guard on multi-word names so an unrelated
// surname collision can't sneak through on edit-distance alone.
const ARTIST_MATCH_THRESHOLD = 0.82;

export async function resolveArtist(name, { artistCount = 10 } = {}) {
  const query = normArtist(name);
  if (!query) return null;

  // 1. Exact index search — fast path, the common correctly-spelled case.
  const exact = await searchArtists(name, { artistCount });
  const direct = exact.find((a: any) => normArtist(a.name) === query);
  if (direct) return direct;

  // 2. Relax — search the artist index by each token. A surname or rarest
  //    token usually returns the right artist even when the full string did
  //    not ("Kahlon" finds "Sikander Kahlon"). Union with the exact hits.
  const tokens = query.split(' ').filter(t => t.length >= 2);
  const candidates = new Map<string, any>();
  for (const a of exact) candidates.set(a.id, a);
  for (const token of tokens) {
    try {
      for (const a of await searchArtists(token, { artistCount })) {
        candidates.set(a.id, a);
      }
    } catch {}
  }
  if (candidates.size === 0) return null;

  // 3. Fuzzy-rank against the full request. For multi-word names require at
  //    least one shared token so a close-but-unrelated single name can't win;
  //    single-token queries lean on the similarity threshold alone.
  const queryTokens = new Set(tokens);
  const requireShared = queryTokens.size >= 2;
  let best: any = null;
  let bestScore = 0;
  for (const a of candidates.values()) {
    const cand = normArtist(a.name);
    if (requireShared && !cand.split(' ').some(t => queryTokens.has(t))) continue;
    const score = similarity(query, cand);
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return bestScore >= ARTIST_MATCH_THRESHOLD ? best : null;
}

export async function getSimilarSongs(id, { count = 20 } = {}) {
  const r = await call('getSimilarSongs2', { id, count });
  return rejectArchive(r.similarSongs2?.song || []);
}

// ---------------------------------------------------------------------------
// OpenSubsonic `sonicSimilarity` extension (Navidrome ≥0.62 + plugin enabled)
// ---------------------------------------------------------------------------
// Audio-based neighbours computed from the actual audio by Navidrome's plugin
// system — a third similarity signal alongside the Last.fm graph
// (getSimilarSongs) and the controller's own embedding-KNN (library.tracksLikeThis).
// Gated behind a capability probe because the extension is optional: when the
// operator hasn't installed/enabled the plugin the endpoint 404s, so the picker
// must check support first rather than eat a failing call every pick.

let sonicExtCache: { ok: boolean; at: number } | null = null;
const EXT_PROBE_TTL_MS = 30 * 60 * 1000;

// True if the server advertises the `sonicSimilarity` extension. Result cached
// 30 min: a missing extension won't appear mid-session and a present one won't
// vanish, but the TTL means a just-upgraded Navidrome is picked up without a
// controller restart. Failures (old Navidrome, network) resolve to false and
// are cached the same way — the probe is best-effort, never throws.
export async function supportsSonicSimilarity(): Promise<boolean> {
  if (sonicExtCache && Date.now() - sonicExtCache.at < EXT_PROBE_TTL_MS) return sonicExtCache.ok;
  let ok = false;
  try {
    const r = await call('getOpenSubsonicExtensions');
    const exts = r.openSubsonicExtensions || [];
    ok = exts.some((e: any) => (typeof e === 'string' ? e : e?.name) === 'sonicSimilarity');
  } catch {
    ok = false;
  }
  sonicExtCache = { ok, at: Date.now() };
  return ok;
}

export async function getSonicSimilarTracks(id, { count = 20 } = {}) {
  const r = await call('getSonicSimilarTracks', { id, count });
  return rejectArchive(sonicSimilarSongs(r));
}

export async function getStarred() {
  const r = await call('getStarred2');
  return rejectArchive(r.starred2?.song || []);
}

// Star write-back for the listener like feature (#991): mirrors the player
// heart into Navidrome so any Subsonic client (Feishin, Symfonium, DSub, …)
// sees the track under Starred immediately. Both are idempotent server-side.
export async function star(id) {
  await call('star', { id });
}

export async function unstar(id) {
  await call('unstar', { id });
}

export async function getAlbumList(offset = 0, size = 500) {
  const r = await call('getAlbumList2', { type: 'alphabeticalByName', size, offset });
  return r.albumList2?.album || [];
}

// Most-recently imported albums. Drives the "new in the crates" picker source.
export async function getRecentlyAddedAlbums({ size = 20 } = {}) {
  const r = await call('getAlbumList2', { type: 'newest', size });
  return r.albumList2?.album || [];
}

// Albums sorted by play count — Navidrome's scrobble-backed "favourites".
export async function getFrequentAlbums({ size = 20 } = {}) {
  const r = await call('getAlbumList2', { type: 'frequent', size });
  return r.albumList2?.album || [];
}

// Last.fm-backed artist info: bio, images, and (most usefully) similar artists.
export async function getArtistInfo(id, { count = 10 } = {}) {
  const r = await call('getArtistInfo2', { id, count });
  return r.artistInfo2 || null;
}

// Last.fm "top songs" for an artist, intersected with what's in the library.
// Note: keyed by artist NAME, not id.
export async function getTopSongs(artistName, { count = 10 } = {}) {
  const r = await call('getTopSongs', { artist: artistName, count });
  return rejectArchive(r.topSongs?.song || []);
}

// Sortable release timestamp for an album object, preferring the most precise
// signal Navidrome offers: OpenSubsonic `originalReleaseDate` {year,month,day}
// → `releaseDate` string → bare `year` → `created` (library-import time) as a
// last resort. Returns a comparable number (higher = newer); 0 when undated.
function albumReleaseRank(a: any): number {
  const ord = a?.originalReleaseDate;
  if (ord?.year) {
    return ord.year * 10000 + (ord.month || 0) * 100 + (ord.day || 0);
  }
  const rd = Date.parse(a?.releaseDate || '');
  if (!Number.isNaN(rd)) return Math.floor(rd / 86400000) + 30000000; // keep above year*10000
  if (a?.year) return a.year * 10000;
  const cr = Date.parse(a?.created || '');
  if (!Number.isNaN(cr)) return Math.floor(cr / 86400000);
  return 0;
}

// An artist's most recent releases, newest first — for "play their latest /
// newest" asks that getTopSongs (popularity-ranked) can't answer. Resolves the
// name to an artist id, pulls their albums, sorts by release date, and returns
// the songs from the newest `albums` releases (singles are single-track albums,
// so a brand-new single surfaces too). Empty when the artist isn't in the library.
export async function getRecentSongsByArtist(
  artistName: string,
  { albums = 3, count = 20 }: { albums?: number; count?: number } = {},
) {
  const artist = await resolveArtist(artistName);
  if (!artist?.id) return [];
  const full = await getArtist(artist.id);
  const albumList = (full?.album || [])
    .map((a: any) => ({ ...a, _rank: albumReleaseRank(a) }))
    .sort((x: any, y: any) => y._rank - x._rank)
    .slice(0, albums);
  const songs: any[] = [];
  for (const a of albumList) {
    try { songs.push(...(await getAlbum(a.id))); } catch {}
    if (songs.length >= count) break;
  }
  return songs.slice(0, count);
}

export async function getAlbum(id) {
  const r = await call('getAlbum', { id });
  return rejectArchive(r.album?.song || []);
}

// Single song lookup — the Child carries albumId, which is how manual album
// tagging resolves a whole album from one track id (the UI never sees albumIds).
export async function getSong(id) {
  const r = await call('getSong', { id });
  return r.song || null;
}

// Returns { id, name, albumCount, album: [{ id, name, year, ... }] }
export async function getArtist(id) {
  const r = await call('getArtist', { id });
  return r.artist || null;
}

// Search just the artist index and return matching artist objects.
export async function searchArtists(query, { artistCount = 5 } = {}) {
  const r = await call('search3', { query, artistCount, albumCount: 0, songCount: 0 });
  return r.searchResult3?.artist || [];
}

// Last.fm-backed crowd tags for an artist, normalised to lowercase trimmed
// strings. Used by the embedding-propagated tagger to enrich the embedding
// text — see music/embeddings.ts formatTrackText. Returns [] if the artist
// has no Last.fm coverage (common for very obscure releases).
export async function getArtistLastfmTags(id, { count = 20 } = {}) {
  try {
    const info = await getArtistInfo(id, { count: 0 });
    const tags = info?.tag || info?.tags?.tag || [];
    const arr = Array.isArray(tags) ? tags : [tags];
    return arr
      .map((t) => (typeof t === 'string' ? t : t?.name))
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.toLowerCase().trim())
      .slice(0, count);
  } catch {
    return [];
  }
}

// Track lyrics via Subsonic's getLyricsBySongId. Returns the plain-text
// lyrics, or '' if no lyrics are indexed for this track. Navidrome v0.49+
// supports this; older Navidromes return a `lyricsList` shape without a
// match — both paths normalise to a string.
export async function getLyrics(songId) {
  try {
    const r = await call('getLyricsBySongId', { id: songId });
    // Modern Navidrome: { lyricsList: { structuredLyrics: [{ line: [{ value: '...' }] }] } }
    const structured = r.lyricsList?.structuredLyrics;
    if (Array.isArray(structured) && structured.length) {
      const lines: string[] = [];
      for (const sl of structured) {
        const lineArr = Array.isArray(sl.line) ? sl.line : [];
        for (const l of lineArr) {
          if (typeof l?.value === 'string' && l.value.trim()) lines.push(l.value.trim());
        }
      }
      return lines.join(' ');
    }
    // Legacy getLyrics shape: { lyrics: { value: '...' } }
    if (typeof r.lyrics?.value === 'string') return r.lyrics.value;
    return '';
  } catch {
    return '';
  }
}

// Timed lyrics via the same getLyricsBySongId call, but PRESERVING the per-line
// start offsets getLyrics() throws away (#1125). Returns { synced, lines } — the
// raw material for lyric-derived vocal ranges (music/lyric-vocal.ts) — or null
// when no lyrics are indexed. Line `start` is milliseconds from track start; the
// entry-level `offset` (a global shift) is folded in — per OpenSubsonic
// "positive means lyrics appear sooner", i.e. effective start = start − offset —
// and negatives clamped to 0.
// synced=false marks unsynced/plain-text lyrics whose line timings are absent.
export async function getStructuredLyrics(
  songId,
): Promise<{ synced: boolean; lines: Array<{ startMs: number; text: string }> } | null> {
  try {
    const r = await call('getLyricsBySongId', { id: songId });
    const structured = r.lyricsList?.structuredLyrics;
    if (!Array.isArray(structured) || structured.length === 0) return null;
    // A track may carry several versions (languages, synced + unsynced) — prefer
    // a synced one, since only that has the timings we're after.
    const chosen = structured.find((s) => s?.synced === true) ?? structured[0];
    const synced = chosen?.synced === true;
    const offset = Number.isFinite(chosen?.offset) ? Number(chosen.offset) : 0;
    const lineArr = Array.isArray(chosen?.line) ? chosen.line : [];
    const lines = lineArr.map((l) => {
      const text = typeof l?.value === 'string' ? l.value : '';
      const rawStart = Number(l?.start);
      const startMs = Number.isFinite(rawStart) ? Math.max(0, rawStart - offset) : NaN;
      return { startMs, text };
    });
    return { synced, lines };
  } catch {
    return null;
  }
}

// Async iterator over every song in the library. Walks albums in batches.
// Each yielded song is annotated with the album-level era signals Navidrome
// only exposes on the album record (issue #842): `albumIsCompilation`
// (OpenSubsonic isCompilation) and `albumOriginalYear` (originalReleaseDate
// .year — the album's TRUE first-release year on reissues, absent on most
// rips). The walk (tag-library.walkNavidrome) turns these into per-track
// original-year/compilation columns; the raw fields ride here so policy stays
// out of the client.
export async function* iterateAllSongs() {
  let offset = 0;
  const BATCH = 500;
  while (true) {
    const albums = await getAlbumList(offset, BATCH);
    if (albums.length === 0) break;
    for (const album of albums) {
      try {
        const r = await call('getAlbum', { id: album.id });
        const isCompilation = typeof r.album?.isCompilation === 'boolean' ? r.album.isCompilation : null;
        const ord = r.album?.originalReleaseDate?.year;
        const originalYear = Number.isFinite(ord) && ord > 0 ? ord : null;
        // Same station-archive drop as getAlbum() (issue #273).
        for (const s of rejectArchive(r.album?.song || [])) {
          yield { ...s, albumIsCompilation: isCompilation, albumOriginalYear: originalYear };
        }
      } catch (err) {
        console.error(`[subsonic] getAlbum(${album.id}) failed: ${err.message}`);
      }
    }
    if (albums.length < BATCH) break;
    offset += albums.length;
  }
}

export async function getPlaylists() {
  const r = await call('getPlaylists');
  return r.playlists?.playlist || [];
}

export async function getPlaylist(id) {
  const r = await call('getPlaylist', { id });
  return rejectArchive(r.playlist?.entry || []);
}

// ---------------------------------------------------------------------------
// Playlist mutations (admin library UI). Song-id lists ride the query string,
// so they are chunked to keep URLs well under length limits.
// ---------------------------------------------------------------------------
const PLAYLIST_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Creates a playlist and returns it. Extra ids beyond the first chunk are
// appended via updatePlaylist; playlists are made public so the operator's
// own Navidrome login sees them, not just the SUB/WAVE service account.
//
// Pass `opts.playlistId` to OVERWRITE an existing playlist's song list wholesale
// (Subsonic `createPlaylist` with a playlistId replaces the songs) — this is how
// the builder's "save over" does a clean full-replace instead of index-based
// remove churn. When overwriting, the first chunk replaces; the rest append.
export async function createPlaylist(
  name: string,
  songIds: string[] = [],
  opts: { playlistId?: string } = {},
) {
  const [first = [], ...rest] = chunk(songIds, PLAYLIST_CHUNK);
  const base = opts.playlistId
    ? { playlistId: opts.playlistId, name, songId: first }
    : { name, songId: first };
  const r = await call('createPlaylist', base);
  // On overwrite Navidrome may not echo the playlist body — fall back to the id.
  const playlist = r.playlist || (opts.playlistId ? { id: opts.playlistId, name } : null);
  if (playlist?.id) {
    for (const ids of rest) {
      await call('updatePlaylist', { playlistId: playlist.id, songIdToAdd: ids });
    }
    await call('updatePlaylist', { playlistId: playlist.id, public: true });
  }
  return playlist;
}

// Appends songs to an existing playlist. Returns how many ids were sent.
export async function addToPlaylist(playlistId: string, songIds: string[]) {
  for (const ids of chunk(songIds, PLAYLIST_CHUNK)) {
    await call('updatePlaylist', { playlistId, songIdToAdd: ids });
  }
  return songIds.length;
}

// Removes entries by position (Subsonic removes by index, not song id).
export async function removeFromPlaylist(playlistId: string, indexes: number[]) {
  await call('updatePlaylist', { playlistId, songIndexToRemove: indexes });
}

// Rename / visibility. Undefined fields are dropped by buildUrl, so callers
// can patch a single attribute without touching the rest.
export async function updatePlaylistMeta(
  playlistId: string,
  meta: { name?: string; comment?: string; public?: boolean },
) {
  await call('updatePlaylist', {
    playlistId, name: meta.name, comment: meta.comment, public: meta.public,
  });
}

export async function deletePlaylist(id: string) {
  await call('deletePlaylist', { id });
}

// Authenticated cover-art URL for a given Subsonic song id. Returns the
// `getCoverArt` REST endpoint with auth params baked in; bytes are JPEG (or
// PNG/WebP depending on what Subsonic resampled). The controller proxies
// this through /cover/:id so listener browsers never see Subsonic creds.
export function getCoverArtUrl(id, size = 512) {
  return buildUrl('getCoverArt', { id, size });
}

// Returns a streamable URL for Liquidsoap to read. Wrapped in the `subhttp:`
// protocol scheme so Liquidsoap's radio.liq routes the fetch through curl
// instead of its built-in http.get.stream (which returns spurious 522s
// against the Cloudflare-fronted Navidrome origin).
//
// format=raw asks Navidrome to stream the original file bytes (no transcode).
// Library is AAC 256 kbps m4a from gamdl; without `raw`, Navidrome would
// transcode to ~192 kbps MP3 on the way out, adding a lossy generation before
// Liquidsoap's own MP3 re-encode. Liquidsoap decodes m4a/AAC via ffmpeg.
export function getStreamUrl(songId) {
  return `subhttp:${buildUrl('stream', { id: songId, format: 'raw' })}`;
}

// Plain HTTP stream URL (no `subhttp:` prefix) with auth baked into the query
// string — for the analysis worker, which fetches the original bytes with
// urllib and decodes the first chunk. `format=raw` avoids a transcode hop.
export function getRawStreamUrl(songId: string): string {
  return buildUrl('stream', { id: songId, format: 'raw' });
}

// Returns the local file path if Navidrome and the controller share the music
// volume — much more efficient than streaming over HTTP for the radio.
// Set MUSIC_LIBRARY_PATH to mount your library inside the controller container.
export function getLocalPath(song) {
  const libRoot = process.env.MUSIC_LIBRARY_PATH;
  if (!libRoot || !song.path) return null;
  return `${libRoot}/${song.path}`;
}

// Best URI for Liquidsoap — local file if available, otherwise stream URL
export function getPlayableUri(song) {
  return getLocalPath(song) || getStreamUrl(song.id);
}

// Liquidsoap `annotate:` URI — embeds metadata up front so on_track_change
// reports real artist/title/album rather than waiting on stream-level ID3.
// Exported for broadcast/beds.ts, which builds its own annotate: URI for a bed
// (a bed is a local file, not a Subsonic song, so it can't go through
// getAnnotatedUri — but it must escape identically).
export function escAnnotate(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function getAnnotatedUri(song, opts: { maxDurationSec?: number | null; cueOutSec?: number | null; cueInSec?: number | null } = {}) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  const genres = songGenres(song);
  if (genres.length) fields.push(`genre="${escAnnotate(genres.join(', '))}"`);
  // DJ-mode adaptive blend: the queue stashes a per-transition crossfade length
  // (seconds) on the track when the persona is in DJ mode and both tracks are
  // analysed. Liquidsoap's `cross` honours `liq_cross_duration` to size the
  // blend for this transition (radio.liq dj_transition reads the same key for
  // its fades, keeping fade == buffer). Liquidsoap 2.4 runs cross with
  // persist_override=true (the only mode where a stamp sizes its own
  // transition — see radio.liq), which makes a stamp LINGER until the next
  // one arrives; every annotated track therefore carries an explicit value,
  // falling back to the operator's configured crossfade, so a washout's 12s
  // canvas can never outlive its own transition.
  const crossSec = song.crossSec ?? settings.get()?.crossfadeDuration ?? null;
  if (crossSec != null) fields.push(`liq_cross_duration="${escAnnotate(crossSec)}"`);
  // Loudness normalisation: the queue stashes a per-track gain offset (dB,
  // clamped) toward the loudness target when the track has a measured LUFS.
  // Emitted in the "<n> dB" form Liquidsoap's amplify override parses natively
  // (the same shape as replaygain_track_gain). radio.liq applies it via
  // amplify(override="liq_amplify") before the ducking layers so quiet and loud
  // tracks play at even perceived volume — masters untouched, no bus
  // normaliser. Absent → no gain applied, i.e. unity / today's behaviour.
  if (song.gainDb != null) fields.push(`liq_amplify="${escAnnotate(song.gainDb)} dB"`);
  // DJ filter sweep: the DJ agent may flag a pick (transition:'sweep') for a
  // gear-change; the queue validates and stamps `sweep` on the track.
  // radio.liq's dj_transition reads `liq_sweep` on the INCOMING track and
  // closes a lowpass over the OUTGOING branch across the blend — the track
  // being left sinks away while this pick rises clean. Absent → normal cross.
  if (song.sweep) fields.push('liq_sweep="true"');
  // DJ dissolve (reverb wash): like the sweep it rides the INCOMING pick —
  // radio.liq reads `liq_dissolve` off `b` and washes the OUTGOING branch
  // into diffuse ambience under it.
  if (song.dissolve) fields.push('liq_dissolve="true"');
  // DJ washout: the DJ agent may flag a pick (transition:'washout') to dissolve
  // into an echo tail as that track ENDS; the queue validates and stamps
  // `washout` (+ the tempo-synced comb tap below, and a long bar-snapped
  // liq_cross_duration — this track's own stamp governs its own end, see
  // mix.washoutCrossSecondsFor). radio.liq's dj_transition reads both off the
  // OUTGOING track's metadata. Absent → normal cross.
  if (song.washout) fields.push('liq_washout="true"');
  if (song.washoutDelay != null) fields.push(`liq_washout_delay="${escAnnotate(song.washoutDelay)}"`);
  // DJ exit loop: rides the ENDING track like the washout — its last bar is
  // caught in a comb-cascade loop as the dry is hard-cut, repeating in
  // tempo under whatever follows. liq_loop_bar is one bar of THIS track's
  // own tempo (mix.loopBarFor); the canvas rides liq_cross_duration exactly
  // like the washout's. radio.liq reads both off the OUTGOING track.
  if (song.loop) fields.push('liq_loop="true"');
  if (song.loopBar != null) fields.push(`liq_loop_bar="${escAnnotate(song.loopBar)}"`);
  // DJ blend (spectral handover): validated same-lane picks trade the spectrum
  // with their predecessor across the cross — dj_transition reads liq_blend on
  // the INCOMING track, like the sweep.
  if (song.blend) fields.push('liq_blend="true"');
  // DJ chop (crossfader cut): rides the INCOMING pick like the sweep —
  // radio.liq reads `liq_chop` off `b` and gates the OUTGOING branch on the
  // beat. The gate period is one beat of the OUTGOING track (the queue stamps
  // it here because the predecessor's own annotation is already sent).
  if (song.chop) fields.push('liq_chop="true"');
  if (song.chopPeriod != null) fields.push(`liq_chop_period="${escAnnotate(song.chopPeriod)}"`);
  // Hard track-length cap (issue #447 / max-track-length). When the caller passes
  // a positive cap, stamp `liq_cue_out` so radio.liq's `cue_cut` stops the track
  // at that second offset — a real ceiling that fires no matter how the track
  // reached the stream, not just a selection bias. Only the capped paths set it
  // (autonomous picks in queue.drainToLiquidsoap + the auto.m3u fallback);
  // explicit listener requests pass null and play in full. A cue_out past a
  // shorter track's end is a Liquidsoap no-op, so sub-cap tracks play untouched.
  // Stem-blend cue points (feature: stem-blend transitions): an explicit
  // cueOutSec (the blend start in the OUTGOING track) folds with the length
  // cap — whichever cuts earlier wins, so a blend can never resurrect audio
  // past the operator's cap. cueInSec skips the INCOMING track past the head
  // its rendered clip already played. Liquidsoap 2.4 honours both labels
  // natively at request resolution; no radio.liq change.
  const cueOut = [opts.maxDurationSec, opts.cueOutSec]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (cueOut.length) {
    fields.push(`liq_cue_out="${escAnnotate(Math.min(...cueOut))}"`);
  }
  if (opts.cueInSec != null && opts.cueInSec > 0) {
    fields.push(`liq_cue_in="${escAnnotate(opts.cueInSec)}"`);
  }
  return `annotate:${fields.join(',')}:${getPlayableUri(song)}`;
}

// Annotate URI for a pre-rendered transition CLIP (stem-blend transitions).
// The clip carries the INCOMING track's identity so now-playing flips to it
// the moment the blend begins — a real DJ mix announces the next record as
// it comes in — and the controller's lastSeenKey dedup swallows the second,
// identical metadata fire when the real track takes over at its cue-in.
// `subwave_clip="1"` marks the dj_queue entry so the telnet rid helpers
// (liquidsoap-control.ts) never mistake the clip for the track itself.
export function getClipUri(song, clipPath: string, crossSec: number) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
    'subwave_clip="1"',
    `liq_cross_duration="${escAnnotate(crossSec)}"`,
  ];
  // No liq_amplify: the render already gain-matched both sources toward the
  // station target — an amplify stamp here would double-apply.
  return `annotate:${fields.join(',')}:${clipPath}`;
}
