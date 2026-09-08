// The album cooldown's key, resolved against the library (#1485 FR 3).
//
// `music/recency.ts` owns the key and the exemption rule and stays pure, but
// most candidates (raw Subsonic children, the agent's `seen` projection, play
// rows) carry no compilation flags. This is the one place they are fetched, and
// every consumer injects THIS function rather than `albumKey` directly so both
// pick paths key one catalogue one way.

import * as library from './library.js';
import { albumKey, type CandidateLike } from './recency.js';

// `albumKey` with the compilation flags filled in from the library when the
// candidate itself is silent about them. Skips the lookup where it could not
// change the answer (flag already stated, or no album/id to key on); a miss
// leaves the flags absent, which reads as "no evidence" and keys normally.
export function albumKeyFor(song: CandidateLike | null | undefined): string {
  if (!song) return '';
  if (song.isCompilation != null || song.yearUntrusted != null) return albumKey(song);
  if (!song.album || !song.id) return albumKey(song);

  const facts = library.getAlbumFacts(song.id);
  return facts ? albumKey({ ...song, ...facts }) : albumKey(song);
}
