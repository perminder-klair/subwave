// Use absolute-floor silence measurements for cues, never relative intro/outro estimates that
// can mistake quiet music for silence. The whole-file `edges` facet (both ends of the WHOLE
// decoded file, and its decoded length) outranks the head/tail window figures when measured. Bound trims with the minimum gap, edge margins, and
// per-edge ceilings (MAX_LEAD_TRIM_SEC, MAX_TAIL_TRIM_SEC); unknown measurements preserve the
// whole track.
//
// The one exception to "absolute floor only" is its own switch and its own
// measurement: the AUDIBLE end of a FADE (transitions.fadeAudibleEnd). On a
// fade the absolute floor lands seconds after the music stopped being
// audible, so the exit crossfade overlapped a near-silent tail. With the
// switch on, a fade whose tail carries a loudness curve (tail v3) is cut at
// the last curve point within fadeAudibleEndDb of the track's own loudness —
// a relative level, but read off a real R128 loudness measurement of the
// tail, never off the intro/outro gates. It only ever moves the end EARLIER
// than the trim would, never at/before cueIn + 1 s, applies with the silence
// trim on or off, and reaches every consumer through resolveSilenceTrim /
// playableSpanSec (one path, cutFrom). resolveAudibleEnd tells the queue the
// cut applied, so the exit canvas is sized on it without re-deriving it.

import * as settings from '../settings.js';
import * as library from './library.js';
import { audibleEndSec, parseLoudnessCurve, type LoudnessCurve } from './loudness-curve.js';

// Keeps the cut off the attack or the decay's last ring; must clear the
// analyzer's frame quantisation (~93ms at 22.05 kHz).
const MARGIN_MS = 250;

// Hard ceiling on what a single edge may lose, whatever the measurement says.
// The head keeps 30 s: music still follows a long lead-in, so a bad
// measurement there costs the start of the song.
const MAX_LEAD_TRIM_SEC = 30;
// The tail is measured back from the file's proven end to the last frame above
// the absolute floor, so all of it is trailing silence with nothing after it.
// Real files end in far more than 30 s of it (hidden-track gaps, DJ sets — 33
// of 50 such endings on one library ran 30-456 s, measured outside the
// analyzer, which cannot see past its window). 600 s bounds a wider tail
// search. With the default analyzer it never binds: the tail window is
// ANALYZE_OUTRO_SECONDS (20 s) and a gap that fills it is stored as no
// measurement. It acts only when that window is raised past ~30 s, or a
// header understates the decodable file by more than ~10 s.
const MAX_TAIL_TRIM_SEC = 600;

export interface SilenceTrimTrack {
  id?: string | null;
  // Subsonic songs spell it `duration`, library rows `durationSec`; both seconds.
  duration?: number | string | null;
  durationSec?: number | string | null;
  leadSilenceMs?: number | null;
  tailSilenceMs?: number | null;
  tailStartMs?: number | null;
  // Whole-file facet `edges`. When measured (decodedDurationMs set) they
  // replace the three window figures above as one set. A shape that carries
  // the `decodedDurationMs` key, null included, answers for the edges itself
  // (a library-row mapper writes it even when unmeasured); one without it
  // has the stored row looked up.
  edgeLeadMs?: number | null;
  edgeTailMs?: number | null;
  decodedDurationMs?: number | null;
  // The audible-end cut (transitions.fadeAudibleEnd) reads the measured ending
  // and the body loudness: track object first, else the library record.
  outro?: { ending?: string | null; loudnessCurve?: unknown; wholeLoudnessCurve?: LoudnessCurve } | null;
  loudnessLufs?: number | null;
}

export interface SilenceTrimResult {
  // Seconds into the file where playback begins; null omits liq_cue_in.
  cueInSec: number | null;
  // Seconds into the file where playback stops, absolute (not a duration); null
  // plays to the end. getAnnotatedUri takes the min of this and the #447 cap.
  cueOutSec: number | null;
}

const NONE: SilenceTrimResult = { cueInSec: null, cueOutSec: null };

// Silence to skip at one edge after the margin, min-gap dial and ceiling apply.
function usableTrimSec(gapMs: number | null | undefined, minGapMs: number, maxSec: number): number | null {
  if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs <= 0) return null;
  if (gapMs < minGapMs) return null;
  const kept = gapMs - MARGIN_MS;
  if (kept <= 0) return null;
  return Math.min(maxSec, kept / 1000);
}

// Resolved in at most one library read, and none for a track object that
// answers every field itself. Track object first, else the library record,
// the same precedence queue.mixAnalysisFor uses.
interface Measured {
  leadMs: number | null | undefined;
  tailMs: number | null | undefined;
  tailStartMs: number | null | undefined;
  durSec: number;
}

const msOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

// The edges facet as one set, or null: lead, tail and the decoded length are
// one measurement, never mixed with a window figure.
function edgesOf(t: SilenceTrimTrack | null | undefined): { lead: number; tail: number; dur: number } | null {
  const dur = msOrNull(t?.decodedDurationMs);
  const lead = msOrNull(t?.edgeLeadMs);
  const tail = msOrNull(t?.edgeTailMs);
  return dur != null && dur > 0 && lead != null && tail != null ? { lead, tail, dur } : null;
}

function measure(track: SilenceTrimTrack): Measured {
  let stored: SilenceTrimTrack | null | undefined;
  const rec = (): SilenceTrimTrack | null => {
    if (stored === undefined) stored = track.id ? (library.get(track.id) ?? null) : null;
    return stored ?? null;
  };
  let durSec = Number(track.duration ?? track.durationSec) || 0;
  // Edges on the track itself, else the stored ones: they outrank any window
  // figure, which only ever saw the first ANALYZE_SECONDS and the last
  // ANALYZE_OUTRO_SECONDS against a tagged duration. A shape carrying the key
  // (null included) has already said whether there are any.
  const edges = edgesOf(track) ?? (track.decodedDurationMs !== undefined ? null : edgesOf(rec()));
  if (edges) {
    if (durSec <= 0) durSec = Number(rec()?.durationSec) || 0;
    return { leadMs: edges.lead, tailMs: edges.tail, tailStartMs: edges.dur - edges.tail, durSec };
  }
  let leadMs = track.leadSilenceMs;
  let tailMs = track.tailSilenceMs;
  let tailStartMs = track.tailStartMs;
  if (leadMs == null || tailMs == null || tailStartMs == null || durSec <= 0) {
    const r = rec();
    if (leadMs == null) leadMs = r?.leadSilenceMs ?? null;
    if (tailMs == null) tailMs = r?.tailSilenceMs ?? null;
    if (tailStartMs == null) tailStartMs = r?.tailStartMs ?? null;
    if (durSec <= 0) durSec = Number(r?.durationSec) || 0;
  }
  return { leadMs, tailMs, tailStartMs, durSec };
}

// Where the analyzer's decode ended, file-absolute. Preferred over the tagged
// duration, which disagrees with the decoded file. Tagged duration is the
// fallback for pre-column rows; null when neither is known, never a guess.
function endReferenceSec(m: Measured): number | null {
  const measuredEndSec = m.tailStartMs != null && m.tailMs != null
    ? (m.tailStartMs + m.tailMs) / 1000
    : null;
  return measuredEndSec ?? (m.durSec > 0 ? m.durSec : null);
}

// Cue-point arithmetic over a resolved measurement set; split out so
// playableSpanSec reaches both halves from one measure() call.
function trimFrom(m: Measured, minGapMs: number): SilenceTrimResult {
  const leadSec = usableTrimSec(m.leadMs, minGapMs, MAX_LEAD_TRIM_SEC);
  const tailSec = usableTrimSec(m.tailMs, minGapMs, MAX_TAIL_TRIM_SEC);
  const endRefSec = endReferenceSec(m);

  // A tail longer than the song yields no stamp: a cue_out at or before the
  // cue_in resolves as an empty request in Liquidsoap.
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

// The min-gap dial, or Infinity (no trim). An unreadable dial must not become 0.
function minGapOf(cfg: { minGapMs?: unknown } | null | undefined): number {
  return Number.isFinite(cfg?.minGapMs as number) ? (cfg?.minGapMs as number) : Infinity;
}

// Where a FADE stops being audible, when transitions.fadeAudibleEnd is on and
// that is before the end `cut` gives; null = no change. Needs a fade outro
// with a valid loudness curve and a body loudness (track first, else the
// library row, the same ladder as the queue's loudness gain).
function audibleEndFor(track: SilenceTrimTrack, m: Measured, cut: SilenceTrimResult): number | null {
  const tr = settings.get()?.transitions;
  if (tr?.fadeAudibleEnd !== true) return null;
  const rec = track.id && (track.outro == null || track.loudnessLufs == null) ? library.get(track.id) : null;
  const outro = track.outro ?? rec?.outro ?? null;
  if (outro?.ending !== 'fade') return null;
  const curve = parseLoudnessCurve(outro.loudnessCurve);
  if (!curve) return null;
  const body = track.loudnessLufs ?? rec?.loudnessLufs ?? null;
  // The dial is bounded by load() (repair) and update() (refusal); an
  // unreadable one reads as no audible end, never as some other depth.
  // When the tail never reaches it (a drone or room noise after the music
  // fills the whole tail window), the whole-track series places the end; it
  // is present only with transitions.tailFromCurve on (music/tail-levels.ts).
  const whole = outro.wholeLoudnessCurve;
  const e = audibleEndSec(curve, body, Number(tr.fadeAudibleEndDb))
    ?? (whole ? audibleEndSec(whole, body, Number(tr.fadeAudibleEndDb)) : null);
  if (e == null) return null;
  const endSec = Math.round(e * 1000) / 1000;
  // Only ever earlier than the end the trim (or the file) gives…
  const otherwise = cut.cueOutSec ?? endReferenceSec(m);
  if (otherwise == null || endSec >= otherwise) return null;
  // …and never an empty request: a cue_out at/before the cue_in + 1 s.
  if (endSec <= (cut.cueInSec ?? 0) + 1) return null;
  return endSec;
}

// The cue points and whether the audible-end cut set the end. The ONE path
// resolveSilenceTrim, playableSpanSec and resolveAudibleEnd all read.
function cutFrom(track: SilenceTrimTrack, m: Measured): SilenceTrimResult & { audibleEndSec: number | null } {
  const cfg = settings.get()?.silenceTrim;
  const cut = cfg?.enabled === true ? trimFrom(m, minGapOf(cfg)) : NONE;
  const audible = audibleEndFor(track, m, cut);
  return audible == null
    ? { cueInSec: cut.cueInSec, cueOutSec: cut.cueOutSec, audibleEndSec: null }
    : { cueInSec: cut.cueInSec, cueOutSec: audible, audibleEndSec: audible };
}

export function resolveSilenceTrim(
  track: SilenceTrimTrack | null | undefined,
): SilenceTrimResult {
  if (!track) return NONE;
  // Both switches off: nothing to resolve (and no library read), as before.
  const s = settings.get();
  if (s?.silenceTrim?.enabled !== true && s?.transitions?.fadeAudibleEnd !== true) return NONE;
  const { cueInSec, cueOutSec } = cutFrom(track, measure(track));
  return { cueInSec, cueOutSec };
}

// The audible-end cut, when it applies to this track: its end (absolute file
// seconds, the cueOutSec resolveSilenceTrim gives) and the cue_in it was
// bounded by. The queue sizes the exit canvas on it (mix.endingCrossSecondsFor)
// without re-deriving the decision.
export function resolveAudibleEnd(
  track: SilenceTrimTrack | null | undefined,
): { endSec: number; cueInSec: number | null } | null {
  if (!track) return null;
  const r = cutFrom(track, measure(track));
  return r.audibleEndSec == null ? null : { endSec: r.audibleEndSec, cueInSec: r.cueInSec };
}

// Seconds this track will actually make sound. Null means "no answer", never
// zero. Never subtract the cue points locally (#1594). The end is
// `cueOutSec ?? endReferenceSec`, never the tagged duration, and excludes the
// #447 length cap, which is an on-air cut its one caller is exempt from.
// Trim off: the file plays whole (to the end reference) unless the
// audible-end cut ends it earlier.
export function playableSpanSec(
  track: SilenceTrimTrack | null | undefined,
): number | null {
  if (!track) return null;
  const m = measure(track);
  const { cueInSec, cueOutSec } = cutFrom(track, m);
  const endSec = cueOutSec ?? endReferenceSec(m);
  if (endSec == null) return null;
  const span = endSec - (cueInSec ?? 0);
  return span > 0 ? Math.round(span * 1000) / 1000 : null;
}

// Shift a file-relative onset onto the TRIMMED timeline: the analyzer measures
// from byte zero, a trimmed track starts at cueInSec. No trim = untouched.
export function shiftOnsetMs(
  track: SilenceTrimTrack | null | undefined,
  onsetMs: number | null | undefined,
): number | null {
  return shiftOnsetByCueMs(resolveSilenceTrim(track).cueInSec, onsetMs);
}

// shiftOnsetMs for a cue already resolved, for a reader that has the PLAY
// rather than only the track: the cue a drained play was stamped with.
export function shiftOnsetByCueMs(
  cueInSec: number | null | undefined,
  onsetMs: number | null | undefined,
): number | null {
  if (onsetMs == null || !Number.isFinite(onsetMs)) return null;
  if (typeof cueInSec !== 'number' || !Number.isFinite(cueInSec)) return onsetMs;
  return Math.max(0, Math.round(onsetMs - cueInSec * 1000));
}

// Inverse of shiftOnsetMs: a played-timeline offset back onto the file's own
// timeline, which is what `liq_cue_out` carries. Takes a resolved `cueInSec`.
export function absoluteOffsetSec(
  cueInSec: number | null | undefined,
  playedSec: number,
): number {
  const cueIn = typeof cueInSec === 'number' && Number.isFinite(cueInSec) && cueInSec > 0
    ? cueInSec
    : 0;
  return cueIn + playedSec;
}
