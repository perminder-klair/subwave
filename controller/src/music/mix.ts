// Pure mixing maths over {bpm, key} analysis pairs. Keep it import-free:
// callers resolve analysis (via library.get) and hand it in.

export interface Analysis {
  bpm: number | null;
  key: string | null;
  // Keys the track OPENS / ENDS in, from the measured per-region key ranges.
  // Optional; consumers fall back to the whole-window dominant `key`.
  keyStart?: string | null;
  keyEnd?: string | null;
  // Measured ending: 'fade' = winds down to silence, 'cold' = ends at level.
  // absent/null = no signal.
  ending?: 'fade' | 'cold' | null;
  // Whether the ENDING is sung. absent/null = unknown.
  vocalTail?: boolean | null;
}

// Duck-typed mirror of library-db's TrackKeyRange (no imports here).
export interface KeyRangeLike {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: string;
}

// Camelot code for a tonic + mode, indexed by pitch class. Mirrors the analyze
// worker's tables, which spell tonics with sharps.
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export function camelotFor(tonic: string | null | undefined, mode: string | null | undefined): string | null {
  if (!tonic || !mode) return null;
  const pc = PITCH_NAMES.indexOf(tonic.trim().toUpperCase());
  if (pc < 0) return null;
  const m = mode.trim().toLowerCase();
  if (m === 'major') return MAJOR_CAMELOT[pc];
  if (m === 'minor') return MINOR_CAMELOT[pc];
  return null;
}

// The key the track opens in — the first measured range, else the fallback.
export function openingKeyFrom(
  ranges: KeyRangeLike[] | null | undefined,
  fallback: string | null,
): string | null {
  const first = ranges?.[0];
  return (first && camelotFor(first.tonic, first.mode)) ?? fallback;
}

// Slack for "the ranges reach the end": codecs pad/truncate and the duration is
// Subsonic's rounded seconds.
const ENDING_KEY_SLACK_MS = 5000;

// The key the track ends in — the last measured range, but only when the ranges
// cover the track's ending. The analysis window is leading-only (~40s), so on a
// longer track the last range is the key at ~40s and the fallback wins.
export function endingKeyFrom(
  ranges: KeyRangeLike[] | null | undefined,
  durationMs: number | null,
  fallback: string | null,
): string | null {
  const last = ranges && ranges.length ? ranges[ranges.length - 1] : null;
  if (!last || durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;
  if (last.endMs < durationMs - ENDING_KEY_SLACK_MS) return fallback;
  return camelotFor(last.tonic, last.mode) ?? fallback;
}

// Target integrated loudness (streaming standard), operator-tunable via
// settings.loudness. The clamps are asymmetric on purpose: cutting a loud track
// is safe, boosting a quiet one can drive high-crest material into the
// broadcast limiter, so boost is capped by maxBoostDb AND by peak headroom.
export const LOUDNESS_TARGET_LUFS = -14;
export const LOUDNESS_MAX_BOOST_DB = 6;
export const LOUDNESS_CUT_CLAMP_DB = 12;
// Boost never pushes the measured sample peak past this ceiling, which matches
// radio.liq's brick-wall limiter threshold. Peak covers the analysis window
// only, so the limiter stays the backstop for later peaks.
export const LOUDNESS_PEAK_CEILING_DBFS = -1;

// dB gain toward the target, clamped. null when the track has no loudness
// measurement (→ unity gain). Rounded to 0.1 dB.
export function gainForLoudness(
  lufs: number | null | undefined,
  opts: { peakDb?: number | null; targetLufs?: number | null; maxBoostDb?: number | null } = {},
): number | null {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return null;
  const target =
    typeof opts.targetLufs === 'number' && Number.isFinite(opts.targetLufs)
      ? opts.targetLufs
      : LOUDNESS_TARGET_LUFS;
  const maxBoost =
    typeof opts.maxBoostDb === 'number' && Number.isFinite(opts.maxBoostDb) && opts.maxBoostDb >= 0
      ? opts.maxBoostDb
      : LOUDNESS_MAX_BOOST_DB;
  const raw = target - lufs;
  let gain: number;
  if (raw > 0) {
    gain = Math.min(raw, maxBoost);
    if (typeof opts.peakDb === 'number' && Number.isFinite(opts.peakDb)) {
      gain = Math.min(gain, Math.max(0, LOUDNESS_PEAK_CEILING_DBFS - opts.peakDb));
    }
  } else {
    gain = Math.max(raw, -LOUDNESS_CUT_CLAMP_DB);
  }
  return Math.round(gain * 10) / 10;
}

// ReplayGain 2.0 reference level (EBU R128). A tag's trackGain is the dB offset
// that brings the track TO this reference, so the track's own integrated
// loudness is reference − trackGain.
export const REPLAYGAIN_REFERENCE_LUFS = -18;

// OpenSubsonic `replayGain` → the same {lufs, peakDb} shape the analyzer
// measures, and preferred over it when present (#998): the tag is a whole-file
// R128 scan, the measurement covers only the leading window. trackPeak is
// linear (1.0 = FS) → dBFS. null when there is no usable trackGain.
export function loudnessFromReplayGain(
  rg: unknown,
): { lufs: number; peakDb: number | null } | null {
  if (!rg || typeof rg !== 'object') return null;
  const gain = (rg as { trackGain?: unknown }).trackGain;
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return null;
  const peak = (rg as { trackPeak?: unknown }).trackPeak;
  const peakDb =
    typeof peak === 'number' && Number.isFinite(peak) && peak > 0
      ? Math.round(20 * Math.log10(peak) * 100) / 100
      : null;
  return { lufs: Math.round((REPLAYGAIN_REFERENCE_LUFS - gain) * 100) / 100, peakDb };
}

// True when a track carries at least one measured value. Both null makes every
// consumer below a no-op.
function analysed(a: Analysis): boolean {
  return a.bpm != null || a.key != null;
}

// Broadcast crossfade bounds (seconds). Below the floor a transition reads as a
// hard cut.
export const CROSS_MIN_SECONDS = 6;
export const CROSS_MAX_SECONDS = 14;

// Octave-safe timing pulse (#1417): librosa doubles slow material, so halve any
// reading at or above 110 BPM. Never multiply a low reading — that could turn a
// genuine slow bar into a half-bar. The stored BPM is untouched.
function timingBpm(bpm: number | null): number | null {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null;
  let folded = bpm;
  while (folded >= 110) folded /= 2;
  return folded;
}

// 0..1 — how close two tempos are, folding half/double time (70 ≈ 140).
export function bpmCompat(a: number | null, b: number | null): number {
  if (!a || !b || a <= 0 || b <= 0) return 0;
  const candidates = [b, b * 2, b / 2];
  let best = 1;
  for (const c of candidates) best = Math.min(best, Math.abs(a - c) / a);
  if (best < 0.03) return 1;
  if (best < 0.06) return 0.6;
  if (best < 0.12) return 0.3;
  return 0;
}

// Parse a Camelot code like '8A' → { n: 8, letter: 'A' }.
export function parseCamelot(code: string | null): { n: number; letter: string } | null {
  if (!code) return null;
  const m = /^(\d{1,2})([AB])$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 12) return null;
  return { n, letter: m[2] };
}

// 0..1 — harmonic compatibility on the Camelot wheel: same key, ±1 around the
// wheel, or relative major/minor (same number, other letter).
export function keyCompat(a: string | null, b: string | null): number {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 0;
  if (ka.n === kb.n && ka.letter === kb.letter) return 1;
  if (ka.n === kb.n) return 0.8; // relative major/minor
  if (ka.letter === kb.letter) {
    const d = Math.abs(ka.n - kb.n);
    const wheel = Math.min(d, 12 - d);
    if (wheel === 1) return 0.8; // adjacent on the wheel
  }
  return 0;
}

// Overall mix compatibility 0..1, tempo weighted a touch over key. Key compares
// the pair the seam meets: outgoing ENDING vs incoming OPENING, falling back to
// the whole-window dominant keys.
export function mixCompat(cur: Analysis, next: Analysis): number {
  return 0.6 * bpmCompat(cur.bpm, next.bpm) + 0.4 * keyCompat(cur.keyEnd ?? cur.key, next.keyStart ?? next.key);
}

// Compatibility → cross-buffer SECONDS for the transition INTO `next`. null
// when EITHER track is un-analysed, so the caller omits the liq_cross_duration
// override and Liquidsoap keeps its startup crossfade_duration().
// `opts.energyDelta` is a small daypart nudge (roughly -0.08..+0.06).
export function crossSecondsFor(
  cur: Analysis,
  next: Analysis,
  opts: { energyDelta?: number; nextIntroMs?: number | null; maxSec?: number | null } = {},
): number | null {
  if (!analysed(cur) || !analysed(next)) return null;

  const comp = mixCompat(cur, next);
  let secs: number;
  if (comp >= 0.8) {
    secs = 4; // locked tempo + key → tight beat-blend
  } else if (comp >= 0.4) {
    // interpolate 8s (at 0.4) → 6s (at 0.8)
    secs = 8 - 2 * ((comp - 0.4) / 0.4);
  } else if (comp >= 0.1) {
    secs = 10; // loosely compatible → today's default
  } else {
    secs = 12; // clash → long wash to hide the seam
  }

  // Daypart nudge (±~0.5s): lower energy → longer, brisker → shorter.
  const energyDelta = opts.energyDelta ?? 0;
  secs += -energyDelta * 4;

  // Snap to whole bars of the OUTGOING track so fade.out spans a musical unit.
  // The intro cap below still wins over it.
  const curTimingBpm = timingBpm(cur.bpm);
  if (curTimingBpm != null) {
    const barSec = (4 * 60) / curTimingBpm;
    if (barSec > 0) {
      const bars = Math.max(1, Math.round(secs / barSec));
      const snapped = bars * barSec;
      if (snapped >= 3 && snapped <= 14) secs = snapped;
    }
  }

  // The incoming fade.in spans the whole buffer, so a buffer longer than its
  // instrumental intro fades up over the first vocals. Cap to the intro length
  // (absent → no cap), floored at CROSS_MIN_SECONDS so short intros don't
  // collapse most transitions to ~3s.
  const introSec = typeof opts.nextIntroMs === 'number' && opts.nextIntroMs > 0
    ? opts.nextIntroMs / 1000
    : null;
  if (introSec != null) secs = Math.min(secs, Math.max(CROSS_MIN_SECONDS, introSec));

  // Clamp to the broadcast range, quantise to 0.1s. Upper bound is the
  // operator's settings.crossfadeDuration (opts.maxSec), else
  // CROSS_MAX_SECONDS, and it wins even below the audible floor.
  const maxSec = typeof opts.maxSec === 'number' && opts.maxSec > 0 ? opts.maxSec : CROSS_MAX_SECONDS;
  const minSec = Math.min(CROSS_MIN_SECONDS, maxSec);
  secs = Math.max(minSec, Math.min(maxSec, secs));
  return Math.round(secs * 10) / 10;
}

// Exit canvas sized by a track's OWN measured ending, so unlike the pair-sized
// crossSecondsFor it can be stamped at annotation time (#749). null when the
// ending is unknown, so the caller leaves crossSec unset. `windDownSec` is
// duration − outro.startMs; a fade's canvas spans it, clamped 8..12 and
// bar-snapped.
//
// Tail-loudness shaping: below FADE_DROP_SHALLOW_DB the canvas trims toward its
// 8s floor, at/past FADE_DROP_DEEP_DB it keeps the full ride, linear between.
// Needs BOTH tailLufs and bodyLufs, else no shaping.
export const FADE_DROP_SHALLOW_DB = 3;
export const FADE_DROP_DEEP_DB = 12;

// Analysis.vocalTail from the measured tail vocal spans (absolute ms) and the
// wind-down start: the ending is "sung" when any span reaches into the
// wind-down, not merely to end-of-file, which false-negatives on exactly the
// fades this targets. null = not measured.
export function vocalTailFor(
  vocalRanges: Array<{ startMs: number; endMs: number }> | null | undefined,
  windDownStartMs: number | null | undefined,
): boolean | null {
  if (vocalRanges == null) return null;
  if (vocalRanges.length === 0) return false;
  if (typeof windDownStartMs !== 'number' || !Number.isFinite(windDownStartMs)) return null;
  return vocalRanges.some(r => r.endMs >= windDownStartMs);
}

export function endingCrossSecondsFor(
  a: Analysis,
  windDownSec: number | null,
  opts: { maxSec?: number | null; tailLufs?: number | null; bodyLufs?: number | null; vocalTail?: boolean | null } = {},
): number | null {
  const ending = a.ending;
  if (ending !== 'fade' && ending !== 'cold') return null;
  const maxSec = opts.maxSec;
  const ceil = typeof maxSec === 'number' && maxSec > 0 ? Math.min(maxSec, CROSS_MAX_SECONDS) : CROSS_MAX_SECONDS;
  let secs: number;
  if (ending === 'fade') {
    secs = windDownSec != null && windDownSec > 0 ? windDownSec : 10;
    secs = Math.max(8, Math.min(12, secs));
    const { tailLufs, bodyLufs } = opts;
    if (
      typeof tailLufs === 'number' && Number.isFinite(tailLufs) &&
      typeof bodyLufs === 'number' && Number.isFinite(bodyLufs)
    ) {
      const drop = bodyLufs - tailLufs; // dB the tail sits below the body
      const t = Math.max(0, Math.min(1, (drop - FADE_DROP_SHALLOW_DB) / (FADE_DROP_DEEP_DB - FADE_DROP_SHALLOW_DB)));
      secs = 8 + (secs - 8) * t;
    }
    // A still-sung wind-down pulls to the 8s floor: a long overlap puts the
    // next track under a singing voice. Unknown (null/absent) changes nothing.
    if (opts.vocalTail === true) secs = 8;
  } else {
    secs = 4; // tight, intentional cut — same length as a locked beat-blend
  }
  // Beat-grid snap (same convention as the washout/loop canvases).
  const endingTimingBpm = timingBpm(a.bpm);
  if (endingTimingBpm != null) {
    const barSec = (4 * 60) / endingTimingBpm;
    const bars = Math.max(1, Math.round(secs / barSec));
    const snapped = bars * barSec;
    if (snapped >= 3 && snapped <= 14) secs = snapped;
  }
  secs = Math.max(Math.min(3, ceil), Math.min(ceil, secs));
  return Math.round(secs * 10) / 10;
}

// DJ transition effects, applied by broadcast/queue.ts. A track's
// `liq_cross_duration` governs the crossfade at its own END, so a washout
// (which rides the track that ends) can be given a canvas while a sweep (the
// transition INTO the pick) cannot — the previous track's stamp is already sent.

export const WASHOUT_CROSS_TARGET_SECONDS = 12;

// Snapped to whole bars of the flagged track's octave-safe pulse, clamped to
// [8, min(14, admin ceiling)]. Unknown BPM → 10s. No incoming-intro cap: the
// next track isn't known when this one is annotated.
export function washoutCrossSecondsFor(a: Analysis, maxSec: number | null = null): number {
  const ceil = typeof maxSec === 'number' && maxSec > 0 ? Math.min(maxSec, CROSS_MAX_SECONDS) : CROSS_MAX_SECONDS;
  const lo = Math.min(8, ceil);
  let secs = 10;
  const washoutTimingBpm = timingBpm(a.bpm);
  if (washoutTimingBpm != null) {
    const barSec = (4 * 60) / washoutTimingBpm;
    const bars = Math.max(1, Math.round(WASHOUT_CROSS_TARGET_SECONDS / barSec));
    secs = bars * barSec;
  }
  secs = Math.max(lo, Math.min(ceil, secs));
  return Math.round(secs * 10) / 10;
}

// Comb tap spacing for the washout tail — a dotted eighth of the octave-safe
// pulse, HALVED into the audible-echo range. Unknown BPM → 0.30s (radio.liq's
// own fallback). Halve, never clamp: a clamped tap is no longer a subdivision
// of anything and the comb drifts against the tail it echoes.
export function washoutDelayFor(bpm: number | null): number {
  const folded = timingBpm(bpm);
  if (folded == null) return 0.3;
  let tap = 0.75 * (60 / folded);
  while (tap > 0.45) tap = tap / 2;
  while (tap < 0.18) tap = tap * 2;
  return Math.round(tap * 100) / 100;
}

// One bar (4 beats, 4/4) of the octave-safe pulse, halved/doubled into a
// 1.2–3.4s window (whole beat multiples either way, so the loop repeats in
// time). Unknown BPM → 2.0s, radio.liq's own fallback.
export function loopBarFor(bpm: number | null): number {
  const folded = timingBpm(bpm);
  if (folded == null) return 2.0;
  let bar = (4 * 60) / folded;
  while (bar > 3.4) bar = bar / 2;
  while (bar < 1.2) bar = bar * 2;
  return Math.round(bar * 100) / 100;
}

export const LOOP_CROSS_TARGET_SECONDS = 12;

// Like the washout canvas, but snapped to whole LOOPS (not bars) so the
// ride-out holds an integral repeat count; the [8, ceiling] clamp still wins.
export function loopCrossSecondsFor(a: Analysis, maxSec: number | null = null): number {
  const ceil = typeof maxSec === 'number' && maxSec > 0 ? Math.min(maxSec, CROSS_MAX_SECONDS) : CROSS_MAX_SECONDS;
  const lo = Math.min(8, ceil);
  let secs = 10;
  if (a.bpm && a.bpm > 0) {
    const bar = loopBarFor(a.bpm);
    const loops = Math.max(3, Math.round(LOOP_CROSS_TARGET_SECONDS / bar));
    secs = loops * bar;
  }
  secs = Math.max(lo, Math.min(ceil, secs));
  return Math.round(secs * 10) / 10;
}

// Whether the measured pair supports the effect the agent proposed. Un-analysed
// tracks pass. The grid:
//   blend    rhythmic, for COMPATIBLE pairs
//   washout  rhythmic exit (always allowed; the caller's cooldown rations it)
//   sweep    dramatic textural move across a clash
//   dissolve smooth textural move across a clash (reverb wash, hides the seam)
//   chop     percussive move across a clash (crossfader cut, on the beat)
export function effectAllowedFor(kind: 'sweep' | 'washout' | 'blend' | 'dissolve' | 'chop' | 'loop', cur: Analysis, next: Analysis): boolean {
  if (kind === 'washout') return true;
  // Editorial like the washout. The queue separately requires the flagged
  // track's own measured tempo (a loop needs a bar length).
  if (kind === 'loop') return true;
  // Over a measured fade-out the chop's stabs are stabs of near-silence, and
  // over a sung ending it stutters a voice mid-word. Checked before the
  // analysed() pass-through: both are measured independently of bpm/key.
  if (kind === 'chop' && cur.ending === 'fade') return false;
  if (kind === 'chop' && cur.vocalTail === true) return false;
  if (!analysed(cur) || !analysed(next)) return true;
  const compat = mixCompat(cur, next);
  // blend (spectral handover) needs a compatible pair; between clashing tracks
  // the complementary-band trade just exposes the clash. dissolve is its mirror:
  // beatless glue for a measurable clash.
  if (kind === 'blend') return compat >= 0.4;
  if (kind === 'dissolve') return compat < 0.4;
  // sweep and chop are gear-change moves, wrong between locked tracks.
  return compat < 0.6;
}

// Gate period for the chop — one beat of the OUTGOING track's octave-safe
// pulse, HALVED into the stab-audible range. Unknown BPM → 0.5s (radio.liq's
// own fallback). Unlike the washout's echo tap the chop cuts ON the beat, so
// the gate must open at each beat start. Halve, never clamp (see
// washoutDelayFor).
export function chopPeriodFor(bpm: number | null): number {
  const folded = timingBpm(bpm);
  if (folded == null) return 0.5;
  let period = 60 / folded;
  while (period > 0.75) period = period / 2;
  while (period < 0.25) period = period * 2;
  return Math.round(period * 100) / 100;
}

// A flourish to fire across the blend, or null (the common case). Caller still
// gates on djMode, sfx.enabled and a cooldown. Names are built-in SFX
// (broadcast/sfx.ts).
export function transitionSfxFor(
  cur: Analysis,
  next: Analysis,
): 'whoosh' | 'drum-roll' | null {
  if (cur.bpm == null || next.bpm == null || cur.bpm <= 0) return null;
  const ratio = next.bpm / cur.bpm;
  // Only meaningful upward jumps, and not a half/double-time artefact.
  if (ratio < 1.18 || ratio >= 1.9) return null;
  return ratio >= 1.4 ? 'drum-roll' : 'whoosh';
}

// Target for a short tempo/key run: nudges BPM with the daypart's energy
// direction, holding the current key. null when the current track is
// un-analysed (nothing to anchor to).
export function pickRunTarget(
  current: Analysis,
  energy: { speed: number; register?: string },
): Analysis | null {
  if (current.bpm == null && current.key == null) return null;
  const dir = energy.speed > 1.0 ? 1 : energy.speed < 1.0 ? -1 : 0;
  const delta = 6 * dir; // ~6 BPM per step in the run's direction
  const bpm = current.bpm != null ? Math.max(50, current.bpm + delta) : null;
  return { bpm, key: current.key };
}
