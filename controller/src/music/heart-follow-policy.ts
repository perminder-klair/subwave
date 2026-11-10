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
// the server. `oldIdVerdict` says what Navidrome's answer for the old id allows:
// only its definite "not found" (Subsonic error 70, the check id-rotation
// recovery already reads) lets the heart move. A song that comes back, an empty
// answer, an error or a timeout is not proof, and the heart stays.

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

export type OldIdVerdict = 'gone' | 'present' | 'unknown';

/** What Navidrome's getSong answer for a heart's old id allows: only `gone` lets it move. */
export function oldIdVerdict(answer: { song?: unknown; error?: unknown }): OldIdVerdict {
  if ('error' in answer) return isMissingSongError(answer.error) ? 'gone' : 'unknown';
  return answer.song ? 'present' : 'unknown';
}
