// A heart follows its file: re-point hearts whose track id has left the library
// at the track that now holds the same song (the rule is heart-follow-policy.ts).
//
// Runs where the id-rotation replay runs: at boot and after every tagger run, in
// the controller, the one writer of likes.json. Cheap when nothing is owed: one
// indexed lookup per liked song, and the library scan only when one of them is
// gone. The move goes through likes.remapTrackIds, the path an id rotation
// already takes, so the Liked view, topLiked, the stem ranking, the favourites
// export and the DJ's favourites all follow. With `likes.starInNavidrome` on, the
// new id is starred too, as a like would have starred it: the old file's star
// went with its id.

import * as likes from '../broadcast/likes.js';
import * as settings from '../settings.js';
import * as db from './library-db.js';
import * as library from './library.js';
import * as subsonic from './subsonic.js';
import { planHeartMoves } from './heart-follow-policy.js';

export interface HeartFollowResult {
  stale: number;
  moved: number;
}

export async function followMovedHearts(): Promise<HeartFollowResult> {
  await likes.load();
  await library.load();
  const songs = likes.likedSongs();
  // An empty library is a first boot or a closed DB, never "every song left".
  if (!songs.length || db.trackCount() === 0) return { stale: 0, moved: 0 };
  const stale = songs.filter((s) => !db.trackExists(s.songId));
  if (!stale.length) return { stale: 0, moved: 0 };
  const moves = planHeartMoves(
    stale.map((s) => ({
      songId: s.songId, title: s.track.title, artist: s.track.artist, album: s.track.album, duration: s.track.duration,
    })),
    db.trackNameRows(),
  );
  if (moves.size) {
    await likes.remapTrackIds(moves);
    if (settings.get()?.likes?.starInNavidrome) {
      for (const id of new Set(moves.values())) {
        subsonic.star(id).catch((err: Error) =>
          console.error(`[likes] Navidrome star failed for ${id}:`, err.message));
      }
    }
  }
  console.log(
    `[likes] ${stale.length} liked song(s) no longer in the library: ` +
      `${moves.size} followed to the same song under its new id, ${stale.length - moves.size} left as they were`,
  );
  return { stale: stale.length, moved: moves.size };
}
