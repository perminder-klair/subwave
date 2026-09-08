// Subsonic API client for Navidrome. Salt+token auth, never plaintext.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as subLog from './subsonic-log.js';
import * as blocklist from './blocklist.js';
import * as sceneVocab from './scene-vocab.js';
import { trackEraYear } from './show-filter.js';
import { albumEraSuspect } from './era-suspect.js';

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
    // Subsonic repeats some params (songId, songIdToAdd, songIndexToRemove).
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Response paths whose elements are individual tracks — these feed
// subsonic-log's song-coverage map. Add an entry for a new song endpoint.
const SONG_PATHS = [
  ['searchResult3', 'song'], ['randomSongs', 'song'], ['songsByGenre', 'song'],
  ['similarSongs2', 'song'], ['starred2', 'song'], ['topSongs', 'song'],
  ['album', 'song'], ['playlist', 'entry'],
];

// Non-song paths — the log's `count` field only, never song coverage.
const OTHER_PATHS = [
  ['albumList2', 'album'], ['searchResult3', 'album'],
  ['searchResult3', 'artist'], ['genres', 'genre'],
  ['playlists', 'playlist'], ['artist', 'album'],
];

// `sonicSimilarity` wraps each song in a `sonicMatch` entry, sometimes nested
// under `sonicSimilarTracks`. Tolerate both, and an inlined Child.
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
  const sonic = sonicSimilarSongs(sub);
  if (sonic.length) return sonic;
  return [];
}

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
    // Bounded fetch: a hung Navidrome must not pin the admin routes behind it (#786).
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
      // First 200 chars of the body, so triage sees the real server message.
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

// Connectivity + auth check against config.navidrome. Never throws.
// A failure that lands instantly gets ONE retry (stale pooled fetch socket);
// a slow failure does not, since a second wait can't change the answer.
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

// Probe with ARBITRARY creds — onboarding "Test connection" and the admin
// Music-source save. Never touches config.navidrome, never throws.
// Retries once on ANY first failure (broader than ping()): 5s-bounded, and the
// aborted teardown of a stalled attempt is what un-wedges a stale socket pool.
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

// Station-archive guard: the station's own hourly mixdowns
// (`archive/YYYY-MM-DD/HH-00.mp3`) index as untagged songs when the Navidrome
// folder overlaps that directory (#273). Every song-returning function below
// filters through this; `call()` logging stays raw for /debug.
export function isStationArchive(song: any): boolean {
  if (!song) return false;
  const path = String(song.path ?? '');
  if (/(^|\/)archive\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.mp3$/i.test(path)) return true;
  // Fallback when Navidrome omits `path`: an HH-00 title with no real artist/album.
  const title = String(song.title ?? '').trim();
  const blank = (s: any) => {
    const v = String(s ?? '').trim().toLowerCase();
    return v === '' || v.startsWith('[unknown') || v === 'unknown artist' || v === 'unknown album';
  };
  return /^\d{2}-00$/.test(title) && blank(song.artist) && blank(song.album);
}

// The blocklist rides the same chokepoint, so blocked tracks drop out of every
// picker source, agent tool and request path at once.
const rejectArchive = (arr: any[]) =>
  blocklist.rejectBlocked((arr || []).filter((s) => !isStationArchive(s)));

// `includeBlocked` is for the admin search surface only (/dj/search), so the
// operator can review a blocked track; queue.push still refuses it. Every
// airing path takes the default and never sees blocked songs.
export async function search(query, { songCount = 20, songOffset = 0, includeBlocked = false } = {}) {
  const r = await call('search3', { query, songCount, songOffset, artistCount: 5, albumCount: 5 });
  const songs = (r.searchResult3?.song || []).filter((s) => !isStationArchive(s));
  return includeBlocked ? songs : blocklist.rejectBlocked(songs);
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}) {
  const r = await call('getRandomSongs', { size, genre, fromYear, toYear });
  return rejectArchive(r.randomSongs?.song || []);
}

export async function getSongsByGenre(genre, { count = 20, offset = 0 } = {}) {
  const r = await call('getSongsByGenre', { genre, count, offset });
  return rejectArchive(r.songsByGenre?.song || []);
}

// A random page of a genre — offset-less getSongsByGenre returns the same head
// every call. Offset is sized from the genre's songCount; an empty deep page
// falls back to page 0, so this can only widen the reach, never starve it.
export async function getSongsByGenreSampled(genre, { count = 20 } = {}) {
  let offset = 0;
  try {
    const genres = await getGenres();
    const norm = (s) => String(s ?? '').toLowerCase();
    const total = Number(genres.find((g) => norm(g.value) === norm(genre))?.songCount) || 0;
    const maxOffset = Math.max(0, total - count);
    if (maxOffset > 0) offset = Math.floor(Math.random() * (maxOffset + 1));
  } catch {}
  const page = await getSongsByGenre(genre, { count, offset });
  if (page.length || offset === 0) return page;
  return getSongsByGenre(genre, { count });
}

// Every genre tag on a song, deduped. OpenSubsonic `genres: [{name}]` is
// authoritative, the legacy scalar `genre` the fallback. The single normaliser
// for per-track genre ingest — everything downstream goes through it.
export function songGenres(song: { genres?: unknown; genre?: unknown } | null | undefined): string[] {
  const raw: string[] = [];
  if (Array.isArray(song?.genres)) {
    for (const g of song.genres) {
      raw.push(String((typeof g === 'string' ? g : (g as { name?: unknown })?.name) ?? ''));
    }
  }
  raw.push(String(song?.genre ?? ''));
  // Scene-consolidation applies here, at the one normaliser, so a merge
  // survives the next Navidrome walk rewriting `tracks.genres` (#1577).
  return sceneVocab.applyAliases(raw, sceneVocab.activeMap());
}

let genresCache: { genres: any[]; at: number } | null = null;
const GENRES_TTL_MS = 5 * 60 * 1000;

// All genre tags in the library, each { value, songCount, albumCount }. Cached
// 5 min (resolveGenreName is called once per value, per pool builder); the set
// only moves on a Navidrome rescan. Failures are NOT cached — they propagate.
export async function getGenres() {
  if (genresCache && Date.now() - genresCache.at < GENRES_TTL_MS) return genresCache.genres;
  const r = await call('getGenres');
  const genres = r.genres?.genre || [];
  genresCache = { genres, at: Date.now() };
  return genres;
}

// Fuzzy-match free text ("hip hop") against a real genre tag ("Hip-Hop"):
// exact normalised match wins, then substring either way. null when no hit.
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

// Fuzzy artist resolution: search3 matches exact tokens/substrings only, so a
// transliteration variance ("Sikandar"/"Sikander") returns zero artists.

function normArtist(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')                       // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein, two-row. Inputs are short artist names.
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
// not. Paired with the shared-token guard on multi-word names below.
const ARTIST_MATCH_THRESHOLD = 0.82;

export async function resolveArtist(name, { artistCount = 10 } = {}) {
  const query = normArtist(name);
  if (!query) return null;

  // 1. Exact index search.
  const exact = await searchArtists(name, { artistCount });
  const direct = exact.find((a: any) => normArtist(a.name) === query);
  if (direct) return direct;

  // 2. Relax — search per token ("Kahlon" finds "Sikander Kahlon"), unioned
  //    with the exact hits.
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

  // 3. Fuzzy-rank against the full request. Multi-word names must share at
  //    least one token; single-token queries lean on the threshold alone.
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

// OpenSubsonic `sonicSimilarity` (Navidrome >=0.62 + plugin): audio-based
// neighbours, a third similarity signal beside getSimilarSongs and the
// embedding KNN. Optional, so the picker must probe support first — the
// endpoint 404s when the plugin isn't installed.

let sonicExtCache: { ok: boolean; at: number } | null = null;
const EXT_PROBE_TTL_MS = 30 * 60 * 1000;

// True if the server advertises the `sonicSimilarity` extension. Cached 30 min
// so a just-upgraded Navidrome is picked up without a controller restart.
// Failures resolve to false and are cached the same way; never throws.
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

// Star write-back for the listener like feature (#991) — mirrors the player
// heart into Navidrome. Idempotent server-side.
export async function star(id) {
  await call('star', { id });
}

export async function unstar(id) {
  await call('unstar', { id });
}

// Play reporting for Navidrome (#1298). submission=false is the "now playing"
// ping (leaves playCount/lastPlayed alone); submission=true is the real
// scrobble that bumps them. `time` is MILLISECONDS since epoch (Subsonic's unit
// here, unlike Last.fm/ListenBrainz) and names when the play STARTED; omitted
// when unknown so the server stamps its own clock. Throws like every call();
// broadcast/scrobble.ts is the only caller and swallows it.
export async function scrobble(
  id: string,
  { submission = true, timeMs = null }: { submission?: boolean; timeMs?: number | null } = {},
) {
  await call('scrobble', {
    id,
    submission,
    time: Number.isFinite(timeMs as number) ? Math.floor(timeMs as number) : null,
  });
}

export async function getAlbumList(offset = 0, size = 500) {
  const r = await call('getAlbumList2', { type: 'alphabeticalByName', size, offset });
  return r.albumList2?.album || [];
}

export async function getRecentlyAddedAlbums({ size = 20 } = {}) {
  const r = await call('getAlbumList2', { type: 'newest', size });
  return r.albumList2?.album || [];
}

// Albums by play count. `offset` rotates the window — the top-N list barely
// moves, so an offset-less read pins the same albums forever.
export async function getFrequentAlbums({ size = 20, offset = 0 } = {}) {
  const r = await call('getAlbumList2', { type: 'frequent', size, offset });
  return r.albumList2?.album || [];
}

export async function getArtistInfo(id, { count = 10 } = {}) {
  const r = await call('getArtistInfo2', { id, count });
  return r.artistInfo2 || null;
}

// Last.fm "top songs" for an artist, intersected with the library. Keyed by
// artist NAME, not id.
export async function getTopSongs(artistName, { count = 10 } = {}) {
  const r = await call('getTopSongs', { artist: artistName, count });
  return rejectArchive(r.topSongs?.song || []);
}

// Sortable release timestamp, most precise signal first: `originalReleaseDate`
// → `releaseDate` → `year` → `created` (import time). Higher = newer, 0 when
// undated.
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

// Songs from an artist's newest `albums` releases — the "play their latest"
// ask that popularity-ranked getTopSongs can't answer. Empty when the artist
// isn't in the library.
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

// Single song lookup. The Child carries albumId, which is how manual album
// tagging resolves a whole album from one track id.
export async function getSong(id) {
  const r = await call('getSong', { id });
  return r.song || null;
}

export async function getArtist(id) {
  const r = await call('getArtist', { id });
  return r.artist || null;
}

export async function searchArtists(query, { artistCount = 5 } = {}) {
  const r = await call('search3', { query, artistCount, albumCount: 0, songCount: 0 });
  return r.searchResult3?.artist || [];
}

// Last.fm crowd tags for an artist, lowercased and trimmed — enrichment for
// the embedding text (music/embeddings.ts). [] when the artist has no coverage.
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

// Plain-text lyrics, or '' when none are indexed. Both the modern and legacy
// response shapes normalise to a string.
export async function getLyrics(songId) {
  try {
    const r = await call('getLyricsBySongId', { id: songId });
    // Modern: { lyricsList: { structuredLyrics: [{ line: [{ value }] }] } }
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
    // Legacy: { lyrics: { value } }
    if (typeof r.lyrics?.value === 'string') return r.lyrics.value;
    return '';
  } catch {
    return '';
  }
}

// Timed lyrics, preserving the per-line offsets getLyrics() drops (#1125) —
// raw material for lyric-derived vocal ranges. null when none are indexed.
// `startMs` is milliseconds from track start with the entry-level `offset`
// folded in (positive offset means lyrics appear sooner: start − offset,
// clamped at 0). synced=false means the line timings are absent.
export async function getStructuredLyrics(
  songId,
): Promise<{ synced: boolean; lines: Array<{ startMs: number; text: string }> } | null> {
  try {
    const r = await call('getLyricsBySongId', { id: songId });
    const structured = r.lyricsList?.structuredLyrics;
    if (!Array.isArray(structured) || structured.length === 0) return null;
    // Several versions may exist (languages, synced + unsynced); only a synced
    // one carries timings.
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

// Async iterator over every song in the library, album batch by album batch.
// Each song carries the album-level era signals Navidrome only exposes on the
// album record (#842): `albumIsCompilation` and `albumOriginalYear` (the true
// first-release year on reissues). Raw fields only — tag-library.walkNavidrome
// turns them into per-track columns, so policy stays out of the client.
//
// `albumEraUntrusted` (#1418) is the one judgement made here, because deciding
// whether an album is a reissue anthology needs the album record AND its full
// track list together, which exists only in this loop. era-suspect.ts still
// owns the judgement; this only feeds it.
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
        const songs = rejectArchive(r.album?.song || []);
        const suspicion = albumEraSuspect({
          isCompilation,
          albumArtist: r.album?.artist ?? album.artist ?? null,
          title: r.album?.name ?? album.name ?? null,
          year: Number.isFinite(r.album?.year) ? r.album.year : null,
          // Raw strings, one per KEPT song: era-suspect owns the lead-artist
          // normalisation, and counting the kept set stops a dropped
          // station-archive entry inflating the album into a false anthology.
          trackArtists: songs.map((s) => s.artist),
        });
        for (const s of songs) {
          yield {
            ...s,
            // A Child's albumId is optional in the spec; the album being
            // iterated is the authoritative fallback.
            albumId: s.albumId ?? r.album?.id ?? album.id ?? null,
            albumIsCompilation: isCompilation,
            albumOriginalYear: originalYear,
            albumEraUntrusted: suspicion.suspect,
            albumEraReason: suspicion.reason,
          };
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

// Playlist mutations: song-id lists ride the query string, so they are chunked
// to keep URLs under length limits.
const PLAYLIST_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Creates a playlist and returns it. Ids past the first chunk are appended;
// playlists are made public so the operator's own Navidrome login sees them.
// `opts.playlistId` OVERWRITES an existing playlist's songs wholesale (Subsonic
// createPlaylist with a playlistId replaces): first chunk replaces, rest append.
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

// Rename / visibility. buildUrl drops undefined fields, so a caller can patch
// one attribute without touching the rest.
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

// Authenticated `getCoverArt` URL. The controller proxies it through
// /cover/:id so listener browsers never see Subsonic creds.
export function getCoverArtUrl(id, size = 512) {
  return buildUrl('getCoverArt', { id, size });
}

// Streamable URL for Liquidsoap. The `subhttp:` scheme routes the fetch
// through curl instead of Liquidsoap's http.get.stream, which returns spurious
// 522s against a Cloudflare-fronted Navidrome. format=raw streams the original
// bytes, avoiding a lossy transcode before Liquidsoap's own re-encode.
export function getStreamUrl(songId, resolveProbeId: string | null = null) {
  const url = buildUrl('stream', { id: songId, format: 'raw' });
  // The fragment reaches proto_subhttp but curl never sends it on; it
  // identifies this exact handoff, so a stale song-id outcome can't be read.
  const probe = resolveProbeId ? `#subwave_probe=${encodeURIComponent(resolveProbeId)}` : '';
  return `subhttp:${url}${probe}`;
}

// Plain HTTP stream URL (no `subhttp:` prefix), auth baked into the query
// string — for the analysis worker. `format=raw` avoids a transcode hop.
export function getRawStreamUrl(songId: string): string {
  return buildUrl('stream', { id: songId, format: 'raw' });
}

// Local file path when MUSIC_LIBRARY_PATH mounts the library in the controller
// container, else null. Navidrome's `path` is synthetic (built from tags, not
// read off disk), so it routinely disagrees with the real layout; an unchecked
// guess resolves to nothing in Liquidsoap and kills the pick (#1405). Existence
// is checked here and a miss falls back to the stream URL.
export function getLocalPath(song) {
  const libRoot = process.env.MUSIC_LIBRARY_PATH;
  if (!libRoot || !song.path) return null;
  const local = `${libRoot}/${song.path}`;
  return fs.existsSync(local) ? local : null;
}

// Best URI for Liquidsoap — local file if available, otherwise stream URL
export function getPlayableUri(song, resolveProbeId: string | null = null) {
  return getLocalPath(song) || getStreamUrl(song.id, resolveProbeId);
}

// Liquidsoap `annotate:` URI — metadata up front, so on_track_change reports
// real artist/title/album without waiting on stream-level ID3. escAnnotate is
// exported for broadcast/beds.ts, which builds its own URI and must escape
// identically.
export function escAnnotate(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function getAnnotatedUri(song, opts: { maxDurationSec?: number | null; cueOutSec?: number | null; cueInSec?: number | null; resolveProbeId?: string | null } = {}) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  // Era year, never the raw `year` (#1418) — a reissue anthology carries the
  // reissue's date and every downstream surface inherits it. Unknown emits NO
  // year field rather than a wrong one.
  const eraYear = trackEraYear(song);
  if (eraYear) fields.push(`year="${escAnnotate(eraYear)}"`);
  const genres = songGenres(song);
  if (genres.length) fields.push(`genre="${escAnnotate(genres.join(', '))}"`);
  // Per-transition crossfade length (seconds). radio.liq runs cross with
  // persist_override=true, so a stamp LINGERS until the next one arrives —
  // every annotated track must carry an explicit value (falling back to the
  // configured crossfade) or a washout's 12s canvas outlives its transition.
  const crossSec = song.crossSec ?? settings.get()?.crossfadeDuration ?? null;
  if (crossSec != null) fields.push(`liq_cross_duration="${escAnnotate(crossSec)}"`);
  // Per-track loudness gain offset, in the "<n> dB" form Liquidsoap's amplify
  // override parses. Applied before the ducking layers. Absent = unity.
  if (song.gainDb != null) fields.push(`liq_amplify="${escAnnotate(song.gainDb)} dB"`);
  // Transition gestures. sweep/dissolve/blend/chop ride the INCOMING pick and
  // act on the outgoing branch across the cross; washout/loop ride the ENDING
  // track and govern its own end. Absent = normal cross.
  if (song.sweep) fields.push('liq_sweep="true"');
  if (song.dissolve) fields.push('liq_dissolve="true"');
  if (song.washout) fields.push('liq_washout="true"');
  if (song.washoutDelay != null) fields.push(`liq_washout_delay="${escAnnotate(song.washoutDelay)}"`);
  // liq_loop_bar is one bar of THIS track's tempo (mix.loopBarFor).
  if (song.loop) fields.push('liq_loop="true"');
  if (song.loopBar != null) fields.push(`liq_loop_bar="${escAnnotate(song.loopBar)}"`);
  // Show-boundary fade (#1574): the track is cued out at a show change, so
  // radio.liq suppresses the exit gestures stamped for an ending that will not
  // happen (washout, loop) and leaves a plain full-buffer fade.
  if (song.showFade) fields.push('liq_show_fade="true"');
  if (song.blend) fields.push('liq_blend="true"');
  // The chop gate period is one beat of the OUTGOING track, stamped here
  // because the predecessor's own annotation has already been sent.
  if (song.chop) fields.push('liq_chop="true"');
  if (song.chopPeriod != null) fields.push(`liq_chop_period="${escAnnotate(song.chopPeriod)}"`);
  // Hard track-length cap (#447): a positive cap stamps `liq_cue_out` and
  // radio.liq's `cue_cut` stops the track there. Only the capped paths set it
  // (autonomous picks + auto.m3u); listener requests pass null and play in
  // full. A cue_out past the track's end is a no-op. An explicit cueOutSec (a
  // stem blend's start in the OUTGOING track) competes with the cap and the
  // earlier cut wins, so a blend can't resurrect audio past the cap. cueInSec
  // skips the INCOMING track past the head its rendered clip already played.
  const cueOut = [opts.maxDurationSec, opts.cueOutSec]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (cueOut.length) {
    fields.push(`liq_cue_out="${escAnnotate(Math.min(...cueOut))}"`);
  }
  if (opts.cueInSec != null && opts.cueInSec > 0) {
    fields.push(`liq_cue_in="${escAnnotate(opts.cueInSec)}"`);
  }
  return `annotate:${fields.join(',')}:${getPlayableUri(song, opts.resolveProbeId ?? null)}`;
}

// Annotate URI for a pre-rendered stem-blend transition CLIP. It carries the
// INCOMING track's identity, so now-playing flips the moment the blend begins
// and the controller's lastSeenKey dedup swallows the identical second fire at
// cue-in. `subwave_clip="1"` stops the telnet rid helpers
// (liquidsoap-control.ts) mistaking the clip for the track itself.
export function getClipUri(song, clipPath: string, crossSec: number) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
    'subwave_clip="1"',
    `liq_cross_duration="${escAnnotate(crossSec)}"`,
  ];
  // No liq_amplify: the render already gain-matched both sources, so a stamp
  // here would double-apply.
  return `annotate:${fields.join(',')}:${clipPath}`;
}
