// Minimum-track-length policy (#1573) — the one place that answers "is this
// track too short to pick?".
//
// A policy module rather than a branch at each call site, for the reason
// CLAUDE.md gives: the same decision is reached from four places (the pool
// picker's final candidate filter, the agent path's discovery tools, the
// auto.m3u coast, and the show editor's candidate diagnostic) and a duplicated
// copy is what drifts. The floor itself is resolved once by
// settings.effectiveMinTrackSec (show override → station default); this module
// only applies it.
//
// It is deliberately NOT folded into show-filter.ts's strict locks. Those are
// the `filtersStrict` opt-in — mood, genre, era, energy, vocals — and this
// floor applies whether or not a show is strict, the way the track-length CAP
// does. It is also the mirror image of that cap: an over-long track can be cut
// on air (liq_cue_out), so it stays eligible, whereas a 40-second interlude
// cannot be lengthened and has to be kept out of the pool instead.
//
// Pure and import-free so it can be unit-tested without a library, a settings
// cache or a mixer (scripts/track-floor.test.ts).

// The narrow shape the floor reads. Subsonic children carry `duration`,
// library rows carry `durationSec`; a source that carries neither reads as
// unknown length. Structurally satisfied by both, so callers pass their own
// element type through unchanged.
export interface LengthTrack {
  duration?: number | null;
  durationSec?: number | null;
}

// Track length in seconds, or null when the source does not know. Zero,
// negative and non-finite all read as unknown — the same rule
// recency.durationSeconds applies to the cap, restated here rather than
// imported so this module stays free of every other pick-path concern.
export function trackLengthSeconds(t: LengthTrack | null | undefined): number | null {
  // First USABLE value, not first PRESENT one. `duration ?? durationSec` reads
  // the same until a source carries `duration: 0` (a Subsonic child whose server
  // never measured it) alongside a real `durationSec`: `??` only falls through
  // on null/undefined, so the row would read as unmeasured and slip past the
  // floor. music/recency.durationSeconds delegates here so the cap and the
  // floor cannot answer this differently.
  const usable = (d: unknown): number | null =>
    Number.isFinite(d) && (d as number) > 0 ? Number(d) : null;
  return usable(t?.duration) ?? usable(t?.durationSec);
}

/**
 * Does this track fall below the floor?
 *
 * **Unknown length passes.** A partly-walked library has rows with no duration
 * at all, and dropping those would turn a floor of 60s into "play only the
 * tracks we happen to have measured" — the same tolerance every other filter
 * here gives an unmeasured track. `min` of 0/null/undefined is "no floor" and
 * nothing is ever below it.
 */
export function belowTrackFloor(t: LengthTrack | null | undefined, min: number | null | undefined): boolean {
  if (!min || min <= 0) return false;
  const len = trackLengthSeconds(t);
  return len != null && len < min;
}

/**
 * Drop everything below the floor.
 *
 * `starve` follows show-filter.applyStrictLocks' convention exactly, and the
 * two postures are chosen at the call site for the same reasons:
 *
 *   starve: true  — hard, even to empty. The agent's discovery tools: a tool
 *     that returns nothing contributes nothing, the model is steered to
 *     another one, and dead air is guarded at a wider scope (a run with no
 *     candidates fails into the pool picker, and behind that the auto.m3u
 *     coast).
 *   starve: false — never-starve: a floor that would empty the pool is
 *     skipped. The pool picker's final selection and the coast, which are
 *     those wider scopes. "The station must keep making sound" outranks the
 *     floor: an operator asking not to hear 40-second skits is not asking for
 *     silence when skits are all that is left.
 */
export function applyTrackFloor<T extends LengthTrack>(
  tracks: T[],
  min: number | null | undefined,
  { starve }: { starve: boolean },
): T[] {
  // NEVER hand the input array back. A caller that rebuilds its pool in place
  // — `pool.length = 0; pool.push(...kept)`, the shape the auto.m3u coast uses
  // — would otherwise clear the very array it is about to spread back in, and
  // the never-starve branch (which returns everything) is exactly where that
  // fires. A guard that empties the pool it exists to protect is worse than no
  // guard, so the aliasing is closed here rather than at each call site.
  if (!min || min <= 0) return tracks.slice();
  const kept = tracks.filter((t) => !belowTrackFloor(t, min));
  if (!starve && kept.length === 0) return tracks.slice();
  return kept;
}
