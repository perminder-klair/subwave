// A heart follows its file: re-point hearts whose track id has left the music
// server at the track that now holds the same song (the rule is
// heart-follow-policy.ts).
//
// Runs where the id-rotation replay runs: at boot and after every tagger run, in
// the controller, the one writer of likes.json. Every gate is decided here, so
// both call sites make the same decision:
//   - only on a finished walk: a run stopped half-way leaves the table
//     part-walked, where "this id left" and "that row is the only copy" can both
//     be wrong, so it stands down until the last tag or reconcile run ended
//     cleanly (music/library-walk.ts);
//   - never while an id rotation is still pending (music/id-rotation.ts): the
//     journal's old→new map is the authority for those ids, and a name match
//     must not get ahead of it;
//   - once per walk: the pass bookmarks the walk it settled
//     (state/heart-follow.json), and skips until a new walk lands. Only a walk
//     prunes a row, so nothing can newly leave the table between two walks, and a
//     heart that can never move (its song left for good, or two copies are
//     equally likely) no longer costs a library scan on every boot and run.
// A heart missing from library.db has not necessarily left the server: the
// table is only as new as the last walk, and a song added since can be hearted
// (an admin row from Navidrome search, a coast track built from Navidrome
// albums). So a planned move goes ahead only when Navidrome itself says the old
// id has left (heart-follow-policy.ts oldIdVerdict: not found, or no longer
// listed on its album). A song still listed, an error or a timeout leaves the
// heart where it is, because a wrong move hearts a song nobody liked. At most two
// lookups per planned move, one move at a time, and the first failure stops the
// rest: those hearts, and the bookmark, wait for the next pass. The lookups are
// bracketed by two scan-state reads: unless both say "not scanning" with the
// same `lastScan` (no scan ran in between), every planned move is held and
// nothing is bookmarked, since a scan mid-move briefly drops live songs from
// their album (heart-follow-policy.ts scanSettled).
//
// The move goes through likes.remapTrackIds, the path an id rotation already
// takes, so the Liked view, topLiked, the stem ranking, the favourites export and
// the DJ's favourites all follow. With `likes.starInNavidrome` on, the new id is
// starred too, as a like would have starred it: the old file's star went with
// its id.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as likes from '../broadcast/likes.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';
import * as db from './library-db.js';
import * as library from './library.js';
import * as subsonic from './subsonic.js';
import { oldIdVerdict, planHeartMoves, scanSettled } from './heart-follow-policy.js';
import { rotationPending } from './id-rotation.js';
import { lastWalk, walkSettled } from './library-walk.js';

export interface HeartFollowResult {
  stale: number;
  moved: number;
  /** Set when the pass stood down without looking. */
  skipped?: 'walk-unsettled' | 'rotation-pending' | 'walk-seen';
  /** Planned moves held because Navidrome did not confirm the old id is gone. */
  held?: number;
}

const NAVIDROME = { getSong: (id: string) => subsonic.getSong(id), getAlbum: (id: string) => subsonic.getAlbumListing(id) };

const bookmarkFile = () => join(config.stateDir, 'heart-follow.json');

function bookmarkedWalk(): string | null {
  try {
    const raw = JSON.parse(readFileSync(bookmarkFile(), 'utf8'));
    return typeof raw?.walkAt === 'string' ? raw.walkAt : null;
  } catch {
    return null;
  }
}

function bookmarkWalk(walkAt: string): void {
  try {
    writeFileAtomicSync(bookmarkFile(), JSON.stringify({ walkAt }));
  } catch (err) {
    // A lost bookmark only costs one more pass.
    console.warn(`[likes] could not bookmark the heart pass: ${err instanceof Error ? err.message : err}`);
  }
}

// Boot and a tagger exit can overlap: one pass at a time, so the second reads
// the first one's bookmark and its moves.
let chain: Promise<unknown> = Promise.resolve();
export function followMovedHearts(): Promise<HeartFollowResult> {
  const next = chain.then(pass, pass);
  chain = next.catch(() => {});
  return next;
}

async function pass(): Promise<HeartFollowResult> {
  await likes.load();
  await library.load();
  const songs = likes.likedSongs();
  // An empty library is a first boot or a closed DB, never "every song left".
  if (!songs.length || db.trackCount() === 0) return { stale: 0, moved: 0 };
  const walk = lastWalk();
  if (!walk || !walkSettled(walk)) {
    console.log(walk
      ? '[likes] the last library walk did not finish cleanly: hearts stay where they are until one does'
      : '[likes] no completed library walk recorded yet: hearts start following after the first clean tag or reconcile run');
    return { stale: 0, moved: 0, skipped: 'walk-unsettled' };
  }
  if (rotationPending()) {
    console.log('[likes] an id rotation is still pending: hearts stay where they are until it is applied');
    return { stale: 0, moved: 0, skipped: 'rotation-pending' };
  }
  if (bookmarkedWalk() === walk.at) return { stale: 0, moved: 0, skipped: 'walk-seen' };

  const stale = songs.filter((s) => !db.trackExists(s.songId));
  if (!stale.length) {
    bookmarkWalk(walk.at);
    return { stale: 0, moved: 0 };
  }
  const planned = planHeartMoves(
    stale.map((s) => ({
      // The like snapshot keeps seconds as `duration` (likes.ts slimTrack); the
      // policy names both sides durationSec, as the library rows do.
      songId: s.songId, title: s.track.title, artist: s.track.artist, album: s.track.album, durationSec: s.track.duration,
    })),
    db.trackNameRows(),
  );

  const moves = new Map<string, string>();
  let held = 0;
  const scanBefore = planned.size ? await subsonic.getScanState() : null;
  let settledAll = planned.size === 0 || scanSettled(scanBefore);
  for (const [oldId, newId] of planned) {
    if (!settledAll) { held++; continue; }
    const verdict = await oldIdVerdict(oldId, NAVIDROME);
    if (verdict === 'gone') moves.set(oldId, newId);
    else held++;
    // A failed lookup says nothing about the rest: keep them, and the walk, for
    // the next pass rather than ask a server that is not answering again.
    if (verdict === 'unknown') settledAll = false;
  }
  // A scan that ran during the lookups may have answered any of them: the moves
  // they confirmed, and the bookmark, stand only if none did.
  if (planned.size && (moves.size || settledAll) && !scanSettled(scanBefore, await subsonic.getScanState())) {
    held += moves.size;
    moves.clear();
    settledAll = false;
  }

  if (moves.size) {
    await likes.remapTrackIds(moves);
    if (settings.get()?.likes?.starInNavidrome) {
      for (const id of new Set(moves.values())) {
        subsonic.star(id).catch((err: Error) =>
          console.error(`[likes] Navidrome star failed for ${id}:`, err.message));
      }
    }
  }
  if (settledAll) bookmarkWalk(walk.at);
  console.log(
    `[likes] ${stale.length} liked song(s) no longer in the library: ` +
      `${moves.size} followed to the same song under its new id, ${stale.length - moves.size} left as they were` +
      (held ? ` (${held} held: Navidrome did not confirm the old id is gone, or was scanning)` : ''),
  );
  return held ? { stale: stale.length, moved: moves.size, held } : { stale: stale.length, moved: moves.size };
}
