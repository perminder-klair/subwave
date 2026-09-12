// The Spotify pool, on disk.
//
// The pool IS the station's library on Spotify, and it lived only in memory: a
// controller restart re-walked every playlist, every saved track and every saved
// album — roughly one request per fifty tracks, so ~100 back-to-back for a
// 5000-track pool, against a rolling 30-second quota that Development Mode
// cannot buy its way out of. Docker restart policies and `up -d --build` made
// that a loop. A snapshot on disk turns a restart into zero catalogue requests,
// and lets the station be playing before it has spoken to Spotify at all.
//
// WHAT IS PERSISTED IS DELIBERATELY NOT THE WHOLE POOL. Everything map.ts
// DERIVES is dropped and rebuilt on load — `coverArt` is the track id,
// `spotifyUri` is the track uri, `genre` is `genres[0]`, and `genres` itself
// comes from the artist-genre cache, which is persisted separately and keeps
// filling in the background. Storing them would fork those conventions: map.ts
// would define them for a fresh walk and this file for a restored one, and the
// two would drift. It also roughly halves the file.
//
// TWO THINGS EARN THEIR PLACE that a walk does not need:
//   • `srcPlaylistId` on each row — which source the track came from. That is
//     what makes a snapshot_id revalidate possible at all: "this playlist is
//     unchanged, keep its rows" has to know which rows are its.
//   • the per-playlist snapshot id and the saved-tracks/albums fingerprints —
//     the evidence a revalidate compares against.
//
// The posture is the house one for a persisted cache (music/blocklist.ts's
// load(), and pool.ts's own genre cache): load once, repair rows rather than
// reject the file, ENOENT is the normal first run, anything else logs and
// starts empty, writes are atomic, and a write that fails makes the next boot
// slower rather than breaking this one.
//
// Deliberately NOT in routes/backup.ts. It is a cache: restoring one onto
// another machine would hand a station a stale library it never walked.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Song, Album } from '../types.js';
import { writeFileAtomic } from '../../../util/atomic-file.js';
import { SPOTIFY_STATE_DIR } from './token-file.js';

export const SPOTIFY_POOL_PATH = path.join(SPOTIFY_STATE_DIR, 'pool.json');

// Bumped when the row shape changes in a way an older file cannot satisfy. A
// mismatch is not an error — the snapshot is ignored and the next build writes
// a current one, which is exactly what a cache should do.
export const POOL_SNAPSHOT_VERSION = 1;

// The two non-playlist sources, as `srcPlaylistId` values. Prefixed so they can
// never collide with a Spotify playlist id (22 chars of base62).
export const SRC_SAVED_TRACKS = '#saved-tracks';
export const SRC_SAVED_ALBUMS = '#saved-albums';

export interface SnapshotPlaylist {
  id: string;
  name: string;
  songCount?: number;
  // Spotify's own version marker for the playlist's contents. It rides on every
  // row of GET /me/playlists, which the pool already walks — so it costs nothing
  // and is what turns a rebuild into a revalidate.
  snapshotId?: string;
}

// What a saved-tracks / saved-albums listing looked like last time, in the two
// facts one `limit=1` request can establish. Not a hash of the contents: a count
// plus the newest id catches an add, a remove and a reorder-by-recency, which is
// every way a saved list normally changes. It cannot catch a swap that keeps
// both — which is what `spotify.pool.fullWalkHours` is for.
export interface SavedFingerprint {
  total: number;
  newestId: string;
}

export interface PoolSnapshot {
  version: number;
  cfgSig: string;
  builtAt: number;
  partial: boolean;
  notes: string[];
  truncated: boolean;
  playlists: SnapshotPlaylist[];
  savedTracks: SavedFingerprint | null;
  savedAlbums: SavedFingerprint | null;
  tracks: any[];
  albums: any[];
}

// Fields map.ts derives: stripped on the way out, rebuilt on the way in.
const DERIVED_TRACK_FIELDS: readonly string[] = ['coverArt', 'spotifyUri', 'genre', 'genres'];

export function compactTrack(s: Song): any {
  const row: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (DERIVED_TRACK_FIELDS.includes(k)) continue;
    if (v === undefined || v === null) continue;
    row[k] = v;
  }
  return row;
}

export function expandTrack(row: any, genresFor: (artistId?: string) => string[]): Song | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  const genres = genresFor(row.artistId);
  return {
    ...row,
    // The same conventions map.ts states, applied in one place rather than two.
    coverArt: row.id,
    spotifyUri: 'spotify:track:' + row.id,
    genres,
    genre: genres[0],
  } as Song;
}

export function compactAlbum(a: Album): any {
  const row: any = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === 'coverArt') continue; // = the album id
    if (v === undefined || v === null) continue;
    row[k] = v;
  }
  return row;
}

export function expandAlbum(row: any): Album | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  return { ...row, coverArt: row.id } as Album;
}

// Read a snapshot, repairing what it can. Returns null for "nothing usable",
// which is the normal first run and also what a corrupt or superseded file
// becomes — never a throw, and never a boot that stops for a cache.
export async function readSnapshot(
  file = SPOTIFY_POOL_PATH,
  log: (line: string) => void = () => {},
): Promise<PoolSnapshot | null> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') log('[spotify] pool snapshot unreadable, starting empty: ' + (err?.message ?? err));
    return null;
  }
  if (Number(raw?.version) !== POOL_SNAPSHOT_VERSION) {
    if (raw?.version != null) log(`[spotify] pool snapshot is version ${raw.version}, this build writes ${POOL_SNAPSHOT_VERSION} — rebuilding`);
    return null;
  }
  const all: any[] = Array.isArray(raw.tracks) ? raw.tracks : [];
  const tracks = all.filter((t: any) => t && typeof t.id === 'string' && t.id);
  if (!tracks.length) return null; // a snapshot of nothing is not worth serving
  if (tracks.length < all.length) log(`[spotify] pool snapshot: dropped ${all.length - tracks.length} unreadable track row(s)`);

  const fingerprint = (f: any): SavedFingerprint | null =>
    f && Number.isFinite(Number(f.total)) && typeof f.newestId === 'string'
      ? { total: Number(f.total), newestId: f.newestId }
      : null;

  return {
    version: POOL_SNAPSHOT_VERSION,
    cfgSig: String(raw.cfgSig ?? ''),
    builtAt: Number.isFinite(Number(raw.builtAt)) ? Number(raw.builtAt) : 0,
    partial: raw.partial === true,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String).slice(0, 10) : [],
    truncated: raw.truncated === true,
    playlists: Array.isArray(raw.playlists)
      ? raw.playlists
        .filter((p: any) => p && typeof p.id === 'string')
        .map((p: any) => ({
          id: p.id,
          name: String(p.name ?? ''),
          songCount: Number.isFinite(Number(p.songCount)) ? Number(p.songCount) : undefined,
          snapshotId: typeof p.snapshotId === 'string' ? p.snapshotId : undefined,
        }))
      : [],
    savedTracks: fingerprint(raw.savedTracks),
    savedAlbums: fingerprint(raw.savedAlbums),
    tracks,
    albums: Array.isArray(raw.albums) ? raw.albums.filter((a: any) => a && typeof a.id === 'string') : [],
  };
}

export async function writeSnapshot(
  snap: PoolSnapshot,
  file = SPOTIFY_POOL_PATH,
  log: (line: string) => void = () => {},
): Promise<void> {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(snap));
  } catch (err: any) {
    // A snapshot that cannot be written costs the NEXT restart a catalogue
    // walk. Slower, not broken, and it must never fail a build.
    log('[spotify] pool snapshot could not be saved: ' + (err?.message ?? err));
  }
}
