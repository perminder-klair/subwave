// Dead-air trim — the single answer to "where does this track actually start
// and stop making sound".
//
// Two consumers, and they must agree: the queue drain stamps the answer as
// liq_cue_in / liq_cue_out on the annotated URI, and the auto.m3u rewrite
// stamps the same thing on the fallback pool. A second copy of this decision
// at either call site is the bug — the fallback playlist is exactly where a
// silently-different rule goes unnoticed for weeks, because nobody is watching
// when it plays.
//
// What this is NOT
// ----------------
// It is not `introMs`, and it is not `outro.startMs`. Both of those are
// RELATIVE gates: the analyzer asks where the energy rises past a fraction of
// the track's OWN loud level, which is the right question for "when may the DJ
// still be talking" and the wrong one here. A quiet piano intro clears neither
// gate and is unambiguously music; cutting to it would be vandalism. Dead air
// is an absolute property of the file — near-digital silence — and the
// analyzer measures it against an absolute dBFS floor as lead_silence_ms /
// tail_silence_ms (+ tail_start_ms, the same tail measurement expressed as an
// absolute offset). Those fields are the only input this module trusts.
//
// Three guards, each for a different way this feature goes wrong
// -------------------------------------------------------------
//  - MIN GAP (operator dial). A track legitimately opens a beat after zero and
//    a segued album leaves deliberate space between its tracks. Only a gap the
//    listener would call dead air earns a cue point.
//  - MARGIN. The measurement finds the first frame that clears the floor, so
//    cutting exactly there lands the cut ON the attack. Leave a sliver of the
//    silence in place; a cut transient is more audible than the gap was.
//  - CEILING. A cue point derived from a wrong measurement is unbounded damage
//    — a mis-measured tail could cut a song in half. Nothing here may remove
//    more than MAX_TRIM_SEC from an edge, whatever the analyzer said.
//
// Absent or unmeasured input yields null on both sides, which is exactly
// today's behaviour: no cue stamps, the track plays whole.

import * as settings from '../settings.js';
import * as library from './library.js';

// Left in place at each edge so the cut never lands on the attack or the last
// ring of the decay. Small enough to be inaudible as silence, large enough to
// clear the analyzer's own frame quantisation (2048 samples at 22.05 kHz is
// ~93ms, and the reported edge is the START of the first loud frame).
const MARGIN_MS = 250;

// Hard ceiling on what a single edge may lose, whatever the measurement says.
// A real leading blank is seconds; anything past this is a broken file or a
// broken measurement, and neither is something to act on silently.
const MAX_TRIM_SEC = 30;

export interface SilenceTrimTrack {
  id?: string | null;
  // Subsonic songs spell it `duration`, library rows `durationSec`. Both are
  // seconds and both reach this module (the drain passes the former, the
  // /now-playing lean read the latter), so accept either rather than making
  // every caller reshape.
  duration?: number | string | null;
  durationSec?: number | string | null;
  leadSilenceMs?: number | null;
  tailSilenceMs?: number | null;
  tailStartMs?: number | null;
}

export interface SilenceTrimResult {
  // Seconds into the file where playback should begin, or null for "start at
  // zero" — the caller omits liq_cue_in entirely on null.
  cueInSec: number | null;
  // Seconds into the file where playback should stop, or null for "play to the
  // end". Absolute, not a duration — it is stamped as liq_cue_out, and
  // getAnnotatedUri takes the MINIMUM of this and the #447 length cap.
  cueOutSec: number | null;
}

const NONE: SilenceTrimResult = { cueInSec: null, cueOutSec: null };

// Trim one edge's measured gap into a usable offset, or null.
// Returns seconds of silence to skip past, after the margin, the min-gap dial
// and the ceiling have all had their say.
function usableTrimSec(gapMs: number | null | undefined, minGapMs: number): number | null {
  if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs <= 0) return null;
  if (gapMs < minGapMs) return null;
  const kept = gapMs - MARGIN_MS;
  if (kept <= 0) return null;
  return Math.min(MAX_TRIM_SEC, kept / 1000);
}

// Resolve the cue points for a track. Track object first, else the library
// record — the same precedence queue.mixAnalysisFor uses, so a track carrying
// fresh analysis doesn't get a stale answer from the DB.
//
// The end reference is what makes the tail side safe: a cue_out is an ABSOLUTE
// offset, so it can only be computed against a known end. `tailStartMs` is that
// end measured off the analyzed decode itself; the tagged duration is the
// fallback. Neither known → no cue_out rather than a guess.
export function resolveSilenceTrim(
  track: SilenceTrimTrack | null | undefined,
): SilenceTrimResult {
  if (!track) return NONE;
  const cfg = settings.get()?.silenceTrim;
  if (cfg?.enabled !== true) return NONE;
  const minGapMs = Number.isFinite(cfg.minGapMs as number) ? (cfg.minGapMs as number) : Infinity;

  let leadMs = track.leadSilenceMs;
  let tailMs = track.tailSilenceMs;
  let tailStartMs = track.tailStartMs;
  let durSec = Number(track.duration ?? track.durationSec) || 0;
  if ((leadMs == null || tailMs == null || tailStartMs == null || durSec <= 0) && track.id) {
    const rec = library.get(track.id);
    if (leadMs == null) leadMs = rec?.leadSilenceMs ?? null;
    if (tailMs == null) tailMs = rec?.tailSilenceMs ?? null;
    if (tailStartMs == null) tailStartMs = rec?.tailStartMs ?? null;
    if (durSec <= 0) durSec = rec?.durationSec ?? 0;
  }

  const leadSec = usableTrimSec(leadMs, minGapMs);
  const tailSec = usableTrimSec(tailMs, minGapMs);

  // Where the analyzer's own decode ENDED, in file-absolute seconds.
  //
  // Preferred over the tagged duration, and not as a nicety: a cue_out is an
  // absolute offset, so deriving it as (duration - gap) silently inherits every
  // disagreement between the container tag and the decoded file. `tailStartMs`
  // and `tailMs` come off the SAME buffer, so their sum is the end the
  // measurement actually saw. The tagged duration stays the fallback for rows
  // analysed before the column existed.
  const measuredEndSec = tailStartMs != null && tailMs != null
    ? (tailStartMs + tailMs) / 1000
    : null;
  const endRefSec = measuredEndSec ?? (durSec > 0 ? durSec : null);

  // A cue_out needs an end to subtract from, and the result must still leave
  // audible track behind it — a degenerate pair (a mis-measured tail longer
  // than the song) yields no stamp rather than a cue_out at or before the
  // cue_in, which Liquidsoap would resolve as an empty request.
  let cueOutSec: number | null = null;
  if (tailSec != null && endRefSec != null && endRefSec > 0) {
    const end = endRefSec - tailSec;
    if (end > (leadSec ?? 0) + 1) cueOutSec = Math.round(end * 1000) / 1000;
  }

  return {
    cueInSec: leadSec != null ? Math.round(leadSec * 1000) / 1000 : null,
    cueOutSec,
  };
}

// Shift a file-relative onset (intro runway, first vocal entry) onto the
// TRIMMED timeline.
//
// Every onset the analyzer reports is measured from byte zero of the file, but
// a trimmed track starts playing at cueInSec — so an 8s intro on a track with
// a 6s leading blank is a 2s runway on air, not 8s. Un-shifted, the DJ writes
// a line for runway that was silence and talks straight over the vocal, which
// is precisely the rule the intro budget exists to keep.
//
// Trim off / no leading trim → returns the value untouched.
export function shiftOnsetMs(
  track: SilenceTrimTrack | null | undefined,
  onsetMs: number | null | undefined,
): number | null {
  if (onsetMs == null || !Number.isFinite(onsetMs)) return null;
  const { cueInSec } = resolveSilenceTrim(track);
  if (cueInSec == null) return onsetMs;
  return Math.max(0, Math.round(onsetMs - cueInSec * 1000));
}
