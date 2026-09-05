// The album cooldown's key, resolved against the library (#1485 FR 3).
//
// `music/recency.ts` owns the KEY and the exemption RULE and stays pure — no
// imports at all, because it is the module `filterPickerCandidates`, the queue
// and the agent guard all sit on. But the rule reads facts most candidates do
// not carry:
//
//   * a library-sourced row (slimTrack) carries `isCompilation`/`yearUntrusted`;
//   * a raw Subsonic child does NOT — the OpenSubsonic compilation flag lives on
//     the ALBUM, not the song, and most of the pool picker's sources are raw
//     children;
//   * the agent path's `seen` map does not either, and must not: those values
//     are serialised verbatim into a re-pick prompt (dj-agent.repickFromSeen),
//     so a field added there is a field the model reads;
//   * a play row in the recent-plays sidecar carries only title/artist/album.
//
// So the exemption would be dead on almost every candidate that matters. This
// module is the one place the missing facts are fetched, and every consumer
// injects THIS function rather than `albumKey` directly — which is what keeps
// the pool path and the agent path keying the same catalogue the same way.
//
// The read is two INTEGER columns off the primary key (`getAlbumFacts`), not
// `getTrackLite`, because this runs per candidate and per play in the window
// and has no use for the columns that one parses.

import * as library from './library.js';
import { albumKey, type CandidateLike } from './recency.js';

// `albumKey` with the compilation flags filled in from the library when the
// candidate itself is silent about them.
//
// Skips the lookup in the two cases where it could not change the answer: a
// candidate that already states a flag (a library row — its own value wins,
// and it came from these same columns), and one that cannot key at all anyway
// (no album, or no id to look up). A miss — a Subsonic-only track with no row —
// leaves the flags absent, which reads as "no evidence" and keys normally.
export function albumKeyFor(song: CandidateLike | null | undefined): string {
  if (!song) return '';
  if (song.isCompilation != null || song.yearUntrusted != null) return albumKey(song);
  if (!song.album || !song.id) return albumKey(song);

  const facts = library.getAlbumFacts(song.id);
  return facts ? albumKey({ ...song, ...facts }) : albumKey(song);
}
