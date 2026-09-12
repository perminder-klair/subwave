// May the orphan reconcile DELETE? One answer, three callers.
//
// `db.pruneMissingTracks(liveIds)` drops the track row, its text vector and its
// audio vector for every id a full walk did not yield — tags, moods, embeddings
// and analysis, gone. That is correct when the track really left the library,
// and it is the whole point: an operator who removes a track from a playlist
// wants it gone, and a Navidrome rescan that re-mints ids would otherwise leave
// the DB carrying orphans forever.
//
// It is wrong when the walk merely FAILED TO READ something. The old guard was
// `walked > 0`, inline at each call site, and it only catches an ENTIRELY empty
// walk — which is the only shape Subsonic can fail in (the API answers or it
// does not). Spotify degrades PARTIALLY: a playlist that 403s, a page walk cut
// short by a rate-limit window, or a `pool.maxTracks` truncation all come back
// non-empty and short, and every missing track then reads as deleted. One
// degraded rebuild plus one tagging run is enough to lose a whole playlist's
// tags.
//
// So the decision lives here rather than being restated at three call sites —
// the repo's "policy lives in its own module" rule, and a second copy of this
// check is the bug. Pure and side-effect free: no DB, no source, no logging.
// The caller does the reporting in its own voice, and MUST report a skip —
// silence reads as "nothing was orphaned", which is the opposite of the truth.

import type { CatalogHealth } from './sources/types.js';

export interface PruneInput {
  // Tracks the walk actually yielded.
  walked: number;
  // The source's own verdict on that walk. `{ complete: true }` for any source
  // that does not implement the probe — see MusicSource.catalogHealth for why
  // silence means safe there while this gate fails closed.
  health: CatalogHealth;
}

export type PruneDecision =
  | { ok: true }
  | { ok: false; reason: string };

export function prunePermitted({ walked, health }: PruneInput): PruneDecision {
  // An empty walk is the classic transient failure — a source that answered
  // with nothing would otherwise delete the entire library.
  if (!Number.isFinite(walked) || walked <= 0) {
    return { ok: false, reason: 'the catalogue walk returned no tracks' };
  }
  if (!health?.complete) {
    return { ok: false, reason: health?.reason || 'the catalogue walk was incomplete' };
  }
  return { ok: true };
}

// The one wording for a skip, so the three callers cannot drift. They differ in
// CHANNEL (console, event log, progress) but not in what they say.
export function pruneSkippedLine(reason: string): string {
  return `skipping the orphan prune — ${reason}. Nothing was deleted; tracks missing from this walk keep their tags until a complete one confirms they are gone.`;
}
