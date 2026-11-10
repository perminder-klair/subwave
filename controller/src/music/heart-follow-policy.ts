// Which library track a heart now belongs to, when the id it was given is gone.
//
// Music servers derive a track id from the file path, so a re-import, a moved
// folder or a re-encode brings a hearted song back under a new id. The old row
// is pruned and the heart (state/likes.json) keeps pointing at nothing: the
// Liked view falls back to the heart's own snapshot, and the stem ranking, the
// favourites export and the DJ's favourites lose the song. The heart stores a
// snapshot of what was liked (title, artist, album, length), so it can be
// matched back, the way a blocklist track entry follows its file
// (music/blocklist.ts trackKey).
//
// The rule, decided here only:
//   - candidates are the tracks with the same title and artist, through the
//     blocklist's name fold (recency.nameKey);
//   - a candidate whose length differs from the snapshot's by more than
//     DURATION_TOLERANCE_SEC is another recording (an edit, a live take) and
//     drops out; an unknown length on either side does not;
//   - one candidate left: the heart moves to it. Several: the one on the same
//     album, if exactly one is. Otherwise the heart stays where it is, since a
//     wrong move hearts a song nobody liked, while a missed one only leaves the
//     heart where it already was.
// A snapshot without a title or an artist never matches.
//
// A planned move is only a plan: library.db is as new as its last walk, so a
// heart on a song added since reads as gone from the table while it is still on
// the server. `oldIdVerdict` asks Navidrome whether the old id has left, and
// only `gone` lets the heart move. Navidrome (0.55+) keeps a deleted or
// re-imported file as a *missing* row until an admin purges missing files, and
// getSong still answers that row ok, with no missing flag. So:
//   - gone: getSong says not found (Subsonic error 70: a purged row), or it
//     answers a song whose album, asked with getAlbum, no longer lists the old
//     id (Navidrome drops missing rows from getAlbum, and leaves out `song`
//     altogether once every track of the album is missing), or that album is
//     itself not found;
//   - present: the album still lists the old id, or getSong answers under
//     another id (the server still holds the song: not proof it left);
//   - unknown: any other error, a timeout, or an answer that cannot be read (no
//     song, no albumId, an album that is not the one asked for). The caller
//     holds the move, and the rest of its pass, for the next one.
// Fail closed throughout: a wrong move hearts a song nobody liked, a missed one
// only waits. At most two calls per planned move.
//
// Only a settled catalogue answers that truly: while Navidrome scans a folder
// move, getSong answers a live song ok while getAlbum briefly leaves it out, so
// it would read `gone` (seen on stock 0.64.2, a few hundred ms mid-scan). So the
// pass asks getScanStatus before its lookups and again after them, and its
// moves stand only when `scanSettled` holds both times: a definite "not
// scanning". Scanning, or a status it could not read (null), holds every
// planned move for the next pass. prune-policy.ts holds prunes on the same
// signal.

import { nameKey } from './recency.js';
import { isMissingSongError } from './id-rotation-recovery.js';

// Seconds. A re-encode of the same master stays within a second or two; an
// edit or an extended mix of the same title is minutes away.
export const DURATION_TOLERANCE_SEC = 5;

export interface HeartSnapshot {
  songId: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  durationSec?: number | null;
}

export interface LibraryNameRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
}

const SEP = '\u0000';
const songKey = (title: unknown, artist: unknown): string | null => {
  const t = nameKey(title);
  const a = nameKey(artist);
  return t && a ? `${t}${SEP}${a}` : null;
};

const known = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The new id for each stale heart that matches exactly one library track (old id → new id). */
export function planHeartMoves(stale: readonly HeartSnapshot[], library: Iterable<LibraryNameRow>): Map<string, string> {
  const wanted = new Map<string, HeartSnapshot[]>();
  for (const h of stale) {
    const key = songKey(h.title, h.artist);
    if (!key) continue;
    const list = wanted.get(key);
    if (list) list.push(h);
    else wanted.set(key, [h]);
  }
  const moves = new Map<string, string>();
  if (!wanted.size) return moves;
  const byKey = new Map<string, LibraryNameRow[]>();
  for (const row of library) {
    const key = songKey(row.title, row.artist);
    if (!key || !wanted.has(key)) continue;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  for (const [key, hearts] of wanted) {
    const rows = byKey.get(key) ?? [];
    for (const h of hearts) {
      const target = pick(h, rows);
      if (target) moves.set(h.songId, target);
    }
  }
  return moves;
}

function pick(h: HeartSnapshot, rows: readonly LibraryNameRow[]): string | null {
  const sameLength = rows.filter((r) =>
    !known(h.durationSec) || !known(r.durationSec) || Math.abs(r.durationSec - h.durationSec) <= DURATION_TOLERANCE_SEC);
  if (sameLength.length === 1) return sameLength[0].id;
  if (sameLength.length === 0) return null;
  const album = nameKey(h.album);
  if (!album) return null;
  const sameAlbum = sameLength.filter((r) => nameKey(r.album) === album);
  return sameAlbum.length === 1 ? sameAlbum[0].id : null;
}

/** Whether a getScanStatus answer lets the pass's moves stand: only a definite "not scanning" does. */
export function scanSettled(scanning: boolean | null): boolean {
  return scanning === false;
}

export type OldIdVerdict = 'gone' | 'present' | 'unknown';

/** The two Navidrome reads the verdict needs: getSong, and the album exactly as answered (no filters). */
export interface OldIdLookups {
  getSong(id: string): Promise<unknown>;
  getAlbum(id: string): Promise<unknown>;
}

const isNotFound = (err: unknown) => Number((err as { subsonicCode?: unknown } | null)?.subsonicCode) === 70;

/** Whether a heart's old id has left Navidrome: only `gone` lets it move. */
export async function oldIdVerdict(oldId: string, lookups: OldIdLookups): Promise<OldIdVerdict> {
  let song: { id?: unknown; albumId?: unknown } | null;
  try {
    song = (await lookups.getSong(oldId)) as typeof song;
  } catch (err) {
    return isMissingSongError(err) ? 'gone' : 'unknown';
  }
  if (!song || typeof song !== 'object') return 'unknown';
  if (song.id != null && String(song.id) !== oldId) return 'present';
  const albumId = typeof song.albumId === 'string' ? song.albumId : '';
  if (!albumId) return 'unknown';

  let album: { id?: unknown; song?: unknown } | null;
  try {
    album = (await lookups.getAlbum(albumId)) as typeof album;
  } catch (err) {
    return isNotFound(err) ? 'gone' : 'unknown';
  }
  if (!album || typeof album !== 'object' || String(album.id ?? '') !== albumId) return 'unknown';
  // Every track of the album missing: Navidrome leaves `song` out.
  const listed = album.song === undefined ? [] : album.song;
  if (!Array.isArray(listed)) return 'unknown';
  return listed.some((s) => String((s as { id?: unknown } | null)?.id ?? '') === oldId) ? 'present' : 'gone';
}
