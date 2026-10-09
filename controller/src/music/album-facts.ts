// Resolve missing compilation flags from the library before applying recency album keys. All
// picker consumers inject this resolver. #1485 FR 3.

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
