// The music-source facade. Every name call sites used to import from
// music/subsonic.js lives here, delegating to whichever source the registry
// resolves from settings.music.source. Call sites import ONLY this module — no
// `provider ===`/`source ===` branches anywhere else.
//
// Three layers:
//   1. CORE delegators — pass straight through to the active source.
//   2. OPTIONAL delegators — capability-gated; a source that can't serve one
//      returns a neutral empty ([]/null/''/false) so discovery paths (the pool
//      picker, request matching) degrade with zero call-site changes.
//   3. DERIVED helpers — resolveGenreName / resolveArtist / getRecentSongsByArtist
//      and getAnnotatedUri, moved here verbatim from the old subsonic client.
//      They're pure compositions over CORE methods, so every source gets fuzzy
//      genre/artist resolution and the Liquidsoap annotate: URI for free.
//
// Nothing under sources/ imports this file — the dependency edge is one-way
// (facade → registry → source impls), so there is no cycle.

import * as settings from '../settings.js';
import { activeSource, activeSourceId } from './sources/registry.js';
import { capabilitiesFor } from './sources/capabilities.js';
import type { Song, Artist, Album, Genre, Playlist } from './sources/types.js';

export { isStationArchive } from './sources/station-archive.js';
export { activeSourceId } from './sources/registry.js';
export const activeCapabilities = () => capabilitiesFor(activeSourceId());

// ── CORE delegators ────────────────────────────────────────────────────────

export function ping(): Promise<{ ok: boolean; reason?: string }> {
  return activeSource().ping();
}
export function search(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<Song[]> {
  return activeSource().search(query, opts);
}
export function getSong(id: string): Promise<Song | null> {
  return activeSource().getSong(id);
}
export function getAlbum(id: string): Promise<Song[]> {
  return activeSource().getAlbum(id);
}
export function getArtist(id: string): Promise<Artist | null> {
  return activeSource().getArtist(id);
}
export function searchArtists(query: string, opts?: { artistCount?: number }): Promise<Artist[]> {
  return activeSource().searchArtists(query, opts);
}
export function getGenres(): Promise<Genre[]> {
  return activeSource().getGenres();
}
export function getRandomSongs(opts?: { size?: number; genre?: string; fromYear?: number; toYear?: number }): Promise<Song[]> {
  return activeSource().getRandomSongs(opts);
}
export function getSongsByGenre(genre: string, opts?: { count?: number }): Promise<Song[]> {
  return activeSource().getSongsByGenre(genre, opts);
}
export function getAlbumList(offset?: number, size?: number): Promise<Album[]> {
  return activeSource().getAlbumList(offset, size);
}
export function iterateAllSongs(): AsyncGenerator<Song> {
  return activeSource().iterateAllSongs();
}
export function getCoverArt(id: string, size?: number) {
  return activeSource().getCoverArt(id, size);
}
export function getAnalyzableRef(songId: string) {
  return activeSource().getAnalyzableRef(songId);
}

// ── OPTIONAL delegators — capability-gated neutral empties ───────────────────
// The capability flag is the single source of truth; the `?.` on the method is
// belt-and-braces so a table/impl mismatch degrades instead of crashing.

export async function getSimilarSongs(id: string, opts?: { count?: number }): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSimilar) return [];
  return (await src.getSimilarSongs?.(id, opts)) ?? [];
}
export async function supportsSonicSimilarity(): Promise<boolean> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSonicSimilarity) return false;
  return (await src.supportsSonicSimilarity?.()) ?? false;
}
export async function getSonicSimilarTracks(id: string, opts?: { count?: number }): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSonicSimilarity) return [];
  return (await src.getSonicSimilarTracks?.(id, opts)) ?? [];
}
export async function getStarred(): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasStarred) return [];
  return (await src.getStarred?.()) ?? [];
}
export async function getTopSongs(artistName: string, opts?: { count?: number }): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasTopSongs) return [];
  return (await src.getTopSongs?.(artistName, opts)) ?? [];
}
export async function getArtistInfo(id: string, opts?: { count?: number }): Promise<any | null> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasArtistInfo) return null;
  return (await src.getArtistInfo?.(id, opts)) ?? null;
}
export async function getArtistLastfmTags(id: string, opts?: { count?: number }): Promise<string[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasLastfmTags) return [];
  return (await src.getArtistLastfmTags?.(id, opts)) ?? [];
}
export async function getLyrics(songId: string): Promise<string> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasLyrics) return '';
  return (await src.getLyrics?.(songId)) ?? '';
}
export async function getPlaylists(): Promise<Playlist[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasPlaylists) return [];
  return (await src.getPlaylists?.()) ?? [];
}
export async function getPlaylist(id: string): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasPlaylists) return [];
  return (await src.getPlaylist?.(id)) ?? [];
}
export async function getRecentlyAddedAlbums(opts?: { size?: number }): Promise<Album[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasRecentlyAdded) return [];
  return (await src.getRecentlyAddedAlbums?.(opts)) ?? [];
}
export async function getFrequentAlbums(opts?: { size?: number }): Promise<Album[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasFrequent) return [];
  return (await src.getFrequentAlbums?.(opts)) ?? [];
}

// ── DERIVED helpers (source-generic; moved verbatim from the old client) ─────

// Fuzzy-match free text ("hip hop", "turkish") against the library's real
// genre tags ("Hip-Hop", "Turkish Pop"). Exact normalised match wins, then
// substring either way. Returns the exact tag value or null.
export async function resolveGenreName(name: string): Promise<string | null> {
  if (!name) return null;
  const norm = (s: any) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
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

// Fuzzy artist resolution — normalise the free text, try an exact index hit,
// then relax to per-token index searches and fuzzy-rank the candidates against
// the whole request. Returns the best matching artist object or null.
// Library-relative: it ranks against whatever artists THIS source actually has.
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

export async function resolveArtist(name: string, { artistCount = 10 }: { artistCount?: number } = {}): Promise<Artist | null> {
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

// Sortable release timestamp for an album object, preferring the most precise
// signal available: OpenSubsonic `originalReleaseDate` {year,month,day} →
// `releaseDate` string → bare `year` → `created` (import time) as a last resort.
// Returns a comparable number (higher = newer); 0 when undated.
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
): Promise<Song[]> {
  const artist = await resolveArtist(artistName);
  if (!artist?.id) return [];
  const full = await getArtist(artist.id);
  const albumList = ((full as any)?.album || [])
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

// Liquidsoap `annotate:` URI — embeds metadata up front so on_track_change
// reports real artist/title/album rather than waiting on stream-level ID3.
// The `subsonic_id` field is a frozen wire name (radio.liq now-playing writer,
// liquidsoap-control.ts regex, now-playing.json, web + native players all parse
// it) — it means "track id" regardless of source; do not rename it.
function escAnnotate(s: any): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function getAnnotatedUri(song: Song, opts: { maxDurationSec?: number | null } = {}): string {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
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
  if (opts.maxDurationSec != null && opts.maxDurationSec > 0) {
    fields.push(`liq_cue_out="${escAnnotate(opts.maxDurationSec)}"`);
  }
  return `annotate:${fields.join(',')}:${activeSource().getPlayableUri(song)}`;
}
