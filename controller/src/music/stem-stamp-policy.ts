// Whether a stem answer stamps stems_at (#2238). Pure; the analysis pass's
// flat and facet paths and pick-time stems all decide here.
//
// stems_at records an attempt, not disk presence (migration 17), so a stamped
// track leaves the stem backfill's scope for good. A head-only set is a fine
// answer when the file had no tail to cut (an unproven tail: a capped
// download, a silent end), and stamping it is right: asking again gives the
// same answer. But when the tail WAS proven and its stems still did not land
// (the separation threw, the write failed), the set is head-only by accident,
// and the stamp kept the backfill from ever finishing it: the render is
// cache-hit-only, so that track never blended out.
//
// So a proven tail that did not land leaves the track unstamped, and the
// backfill tries it again. Bounded: a tail that fails every time (a file
// Demucs cannot separate past some point) must not hold a backfill slot
// forever, so the TAIL_STEM_MISS_LIMIT-th miss in a row stamps it anyway.
// The count lives in tracks.stems_tail_misses, cleared by a landed tail and
// by every clear that resets stems_at.

export const TAIL_STEM_MISS_LIMIT = 3;

export interface StemStampInput {
  // The head's outcome as the worker reported it (stems_cached): true written,
  // false a write that failed, null no head attempt counted (nothing asked, a
  // share without its marker, a tail-only request).
  stemsCached: boolean | null;
  // The tail's (tail_stems_landed): true landed, false proven and asked for
  // but not landed, null no tail to cut, or an older analyzer that does not say.
  tailStems: boolean | null;
  // The track's misses so far (tracks.stems_tail_misses); null = none.
  priorTailMisses: number | null;
  // The facet protocol's stems facet answered ok: an attempt even without a
  // stems_cached (a tail-only request, pick-time stems with the head cached).
  okAnswer?: boolean;
}

export interface StemStampDecision {
  // Write stems_at (the backfill drops the track).
  stamp: boolean;
  // The new tracks.stems_tail_misses; undefined = leave it as it is.
  tailMisses?: number | null;
}

export function stemStampDecision(i: StemStampInput): StemStampDecision {
  const attempted = i.stemsCached !== null || i.okAnswer === true;
  if (!attempted) return { stamp: false };
  if (i.tailStems === false) {
    const misses = Math.max(0, Math.trunc(i.priorTailMisses ?? 0)) + 1;
    return { stamp: misses >= TAIL_STEM_MISS_LIMIT, tailMisses: misses };
  }
  return { stamp: true, tailMisses: null };
}
