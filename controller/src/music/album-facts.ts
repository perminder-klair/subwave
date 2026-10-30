// Resolve missing compilation flags from the library before applying recency album keys. All
// picker consumers inject this resolver. #1485 FR 3. The DJ's spoken album
// asks the same question through `albumIsCompilation` (#2117).

import * as library from './library.js';
import { albumCooldownExempt, albumKey, type CandidateLike } from './recency.js';

// The compilation flags filled in from the library when the candidate itself
// is silent about them. A candidate that states either flag is trusted without
// a lookup; a miss leaves the flags absent, which reads as "no evidence".
function withAlbumFacts<T extends CandidateLike>(song: T): T {
  if (song.isCompilation != null || song.yearUntrusted != null || !song.id) return song;
  const facts = library.getAlbumFacts(song.id);
  return facts ? { ...song, ...facts } : song;
}

// `albumKey` with the flags filled in. Skips the lookup where it could not
// change the answer (flag already stated, or no album/id to key on).
export function albumKeyFor(song: CandidateLike | null | undefined): string {
  if (!song) return '';
  if (!song.album) return albumKey(song);
  return albumKey(withAlbumFacts(song));
}

// Is this track's album a compilation, by the same rule the cooldown exempts
// one? The DJ never names it: a sampler's or box set's title read out as "from
// <album>" tells the listener the song came from a record it never did, and
// the grounding rules leave the model nothing to name in its place (#2117).
export function albumIsCompilation(song: CandidateLike | null | undefined): boolean {
  if (!song) return false;
  return albumCooldownExempt(withAlbumFacts(song));
}
