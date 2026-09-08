// Minimum-track-length policy (#1573): the one answer to "is this track too
// short to pick?". The floor itself is resolved by
// settings.effectiveMinTrackSec (show override → station default); this module
// only applies it.
//
// Not part of show-filter.ts's strict locks: it applies whether or not a show
// is strict, like the track-length CAP. It is the mirror image of that cap —
// an over-long track is cut on air (liq_cue_out) and stays eligible, whereas a
// 40-second skit cannot be lengthened and has to leave the pool.
//
// Pure and import-free, so it unit-tests without a library, settings cache or
// mixer (scripts/track-floor.test.ts).

// Subsonic children carry `duration`, library rows `durationSec`; neither means
// unknown length. Structurally satisfied by both, so callers pass their own
// element type through unchanged.
export interface LengthTrack {
  duration?: number | null;
  durationSec?: number | null;
}

// Track length in seconds, or null when unknown. Zero, negative and non-finite
// all read as unknown. music/recency.durationSeconds delegates here so the cap
// and the floor cannot answer differently.
export function trackLengthSeconds(t: LengthTrack | null | undefined): number | null {
  // First USABLE value, not first present one: `??` would let a `duration: 0`
  // beside a real `durationSec` read as unmeasured and slip past the floor.
  const usable = (d: unknown): number | null =>
    Number.isFinite(d) && (d as number) > 0 ? Number(d) : null;
  return usable(t?.duration) ?? usable(t?.durationSec);
}

// Unknown length passes: a partly-walked library has rows with no duration, and
// dropping those turns a 60s floor into "play only what we measured". `min` of
// 0/null/undefined means no floor.
export function belowTrackFloor(t: LengthTrack | null | undefined, min: number | null | undefined): boolean {
  if (!min || min <= 0) return false;
  const len = trackLengthSeconds(t);
  return len != null && len < min;
}

// Drop everything below the floor. `starve` follows show-filter.applyStrictLocks'
// convention: true = hard, even to empty (the agent's discovery tools, which
// have wider dead-air scopes behind them); false = never-starve, a floor that
// would empty the pool is skipped (pool picker, auto.m3u coast).
export function applyTrackFloor<T extends LengthTrack>(
  tracks: T[],
  min: number | null | undefined,
  { starve }: { starve: boolean },
): T[] {
  // Never hand the input array back: a caller that rebuilds its pool in place
  // (`pool.length = 0; pool.push(...kept)`, as the auto.m3u coast does) would
  // clear the array it is about to spread back in.
  if (!min || min <= 0) return tracks.slice();
  const kept = tracks.filter((t) => !belowTrackFloor(t, min));
  if (!starve && kept.length === 0) return tracks.slice();
  return kept;
}
