// Mixing helpers — the pure, I/O-free maths behind "DJ mode feels mixed".
//
// Everything here is a pure function of {bpm, key} analysis pairs (the values
// music/analyzer.ts writes into the library DB). No imports, no library
// lookups — callers resolve analysis (via library.get) and hand it in, so this
// module stays trivially testable and free of cycles.
//
// `bpmCompat` / `keyCompat` / `parseCamelot` live here as the single source of
// truth; music/picker.ts re-imports them for its pool re-rank. The DJ-mix
// features (adaptive blend, transition FX, mini-runs) build on top.

export interface Analysis {
  bpm: number | null;
  key: string | null;
  // Boundary keys (feature: key ranges) — the key the track OPENS in and the
  // key it ENDS in, resolved from the measured per-region key ranges via
  // openingKeyFrom / endingKeyFrom. Optional; consumers fall back to the
  // whole-window dominant `key`, so un-analysed tracks behave as before.
  keyStart?: string | null;
  keyEnd?: string | null;
  // Measured ending of the track (outro analysis): 'fade' = winds down to
  // silence, 'cold' = ends at level. Optional — absent/null means "no outro
  // signal" and every consumer behaves exactly as before.
  ending?: 'fade' | 'cold' | null;
}

// --- Boundary keys (feature: key ranges) -------------------------------------
// The analyzer stores per-region keys as {startMs,endMs,tonic,mode} over the
// ANALYSED WINDOW (the first ANALYZE_SECONDS, ~40s — not the whole file).
// These helpers turn them into the two keys a transition actually meets: the
// incoming track's OPENING key (the first range — the window starts at t=0,
// so this is always a real measurement) and the outgoing track's ENDING key
// (only trusted when the ranges genuinely reach the track's end, i.e. the
// track fits inside the window — otherwise the whole-window dominant key is
// the best available estimate and the fallback wins).

// Duck-typed mirror of library-db's TrackKeyRange, so this module keeps its
// no-imports invariant.
export interface KeyRangeLike {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: string;
}

// Camelot code for a tonic + mode — indexed by pitch class, mirroring the
// analyze worker's MAJOR_CAMELOT / MINOR_CAMELOT tables exactly (the worker
// spells tonics with sharps: C, C#, D, …, B).
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

// Slack for "the ranges reach the end": codecs pad/truncate a little and the
// duration is Subsonic's rounded seconds, so demand coverage only to within
// this many ms of the reported end.
const ENDING_KEY_SLACK_MS = 5000;

// The key the track ends in — the last measured range, but ONLY when the
// ranges actually cover the track's ending (short tracks that fit inside the
// analysis window). Anything longer falls back: the window is leading-only,
// so its last range is the key at ~40s, not the ending.
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

// --- Loudness normalisation ------------------------------------------------
// Target integrated loudness; streaming-standard −14 LUFS (Spotify, YouTube)
// by default, operator-tunable via settings.loudness. The two directions are
// clamped asymmetrically because they carry different risk: cutting a loud
// track is always safe (wide fixed clamp), while boosting a quiet one can
// drive high-crest material (classical, jazz) into the broadcast limiter — so
// the boost is capped by the operator's maxBoostDb AND by the track's own
// measured peak headroom when the analyzer has one.
export const LOUDNESS_TARGET_LUFS = -14;
export const LOUDNESS_MAX_BOOST_DB = 6;
export const LOUDNESS_CUT_CLAMP_DB = 12;
// Boost never pushes the measured sample peak past this ceiling — it matches
// the brick-wall limiter threshold (−1 dBFS in radio.liq) so normal catalogue
// audio stays clear of it. Peak is measured over the analysis window (~the
// first 2 min), not the whole file, so the limiter remains the backstop for
// peaks later in the track.
export const LOUDNESS_PEAK_CEILING_DBFS = -1;

// dB gain to bring a track measured at `lufs` toward the target, clamped.
// Returns null when the track has no loudness measurement (→ unity gain on the
// playback side, i.e. today's behaviour). Result is rounded to 0.1 dB — finer
// is inaudible and just bloats the annotate string.
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

// True when a track carries at least one measured value. An un-analysed track
// (both null) makes every consumer below a no-op, so an un-analysed library
// behaves exactly as before.
function analysed(a: Analysis): boolean {
  return a.bpm != null || a.key != null;
}

// Broadcast crossfade bounds (seconds). The floor keeps every blend audible —
// shorter than this and a transition reads as a hard cut / "no crossfade".
export const CROSS_MIN_SECONDS = 6;
export const CROSS_MAX_SECONDS = 14;

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

// Overall mix compatibility 0..1 — tempo weighted a touch over key, matching
// the pool re-rank's intent (a beat that locks matters more to a blend than a
// key that's merely adjacent). Key compares the pair the seam actually meets:
// the outgoing track's ENDING key against the incoming track's OPENING key
// (feature: key ranges), falling back to the whole-window dominant keys.
export function mixCompat(cur: Analysis, next: Analysis): number {
  return 0.6 * bpmCompat(cur.bpm, next.bpm) + 0.4 * keyCompat(cur.keyEnd ?? cur.key, next.keyStart ?? next.key);
}

// --- Feature 1: adaptive blend ---------------------------------------------
// Compatibility → cross-buffer SECONDS for the transition INTO `next`.
// Compatible tracks get a short, tight blend; clashes get a long wash that
// hides the seam. Returns null when EITHER track is un-analysed, so the caller
// omits the liq_cross_duration override and Liquidsoap keeps its startup
// crossfade_duration() — today's behaviour, byte-for-byte.
//
// `opts.energyDelta` is a small daypart nudge (energyForDaypart().speed - 1,
// roughly -0.08..+0.06): lower-energy dayparts stretch the wash slightly,
// brisker ones tighten it. Kept subtle so the compatibility curve dominates.
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

  // Daypart nudge: lower energy → longer, brisker → shorter. Subtle (±~0.5s).
  const energyDelta = opts.energyDelta ?? 0;
  secs += -energyDelta * 4;

  // Beat-grid snap (feature: beat/bar grid): round the blend to a whole number
  // of the OUTGOING track's bars (4 beats, 4/4) so the fade.out spans a musical
  // unit instead of an arbitrary count. Only when the outgoing tempo is known
  // and the snap stays in range; the intro cap below still wins over it.
  if (cur.bpm && cur.bpm > 0) {
    const barSec = (4 * 60) / cur.bpm;
    if (barSec > 0) {
      const bars = Math.max(1, Math.round(secs / barSec));
      const snapped = bars * barSec;
      if (snapped >= 3 && snapped <= 14) secs = snapped;
    }
  }

  // Structure-aware cap (feature: song structure): the incoming track plays
  // from t=0 at the start of the cross buffer and its fade.in spans the whole
  // buffer, so a buffer longer than the incoming track's instrumental intro
  // would fade up over the first vocals. Cap the blend to the intro length so
  // the fade-in completes before the song proper. Absent intro → no cap, i.e.
  // today's behaviour. Floor at CROSS_MIN_SECONDS so a short intro still leaves
  // an audible blend — a tighter cap collapsed most transitions to ~3s and read
  // as "no crossfade".
  const introSec = typeof opts.nextIntroMs === 'number' && opts.nextIntroMs > 0
    ? opts.nextIntroMs / 1000
    : null;
  if (introSec != null) secs = Math.min(secs, Math.max(CROSS_MIN_SECONDS, introSec));

  // Clamp to the broadcast range and quantise to 0.1s. The upper bound is the
  // operator's admin crossfade length (settings.crossfadeDuration, passed as
  // opts.maxSec) so the adaptive blend never exceeds what they configured;
  // falls back to CROSS_MAX_SECONDS when unset. An admin value below the audible
  // floor wins as the ceiling — an explicit short crossfade is the operator's
  // call — so the floor yields to it.
  const maxSec = typeof opts.maxSec === 'number' && opts.maxSec > 0 ? opts.maxSec : CROSS_MAX_SECONDS;
  const minSec = Math.min(CROSS_MIN_SECONDS, maxSec);
  secs = Math.max(minSec, Math.min(maxSec, secs));
  return Math.round(secs * 10) / 10;
}

// --- Ending-aware exit canvas (feature: outro analysis) ---------------------
// Canvas for a track's OWN exit, sized by its measured ENDING. Unlike the
// pair-sized crossSecondsFor above — which can't be applied (#749: a track's
// liq_cross_duration governs its own end, and its successor is unknown when it
// is annotated) — the ending is a property of the track alone, so this CAN be
// stamped correctly at annotation time. A measured fade earns a long canvas
// that rides the wind-down out under whatever follows; a cold end cuts tight
// (the short cross IS the intent — stretching a hard ending smears it).
// Returns null when the ending is unknown, so the caller leaves crossSec unset
// and Liquidsoap keeps the operator's default — today's behaviour.
//
// `windDownSec` is the measured wind-down length (duration − outro.startMs);
// a fade's canvas spans it (clamped 8..12 so the wash stays broadcast-shaped).
// Bar-snapped to the track's own tempo like the other canvases — prefer the
// TAIL tempo (outro.bpm) in `a` when the caller has it; outros drift.
//
// Tail-loudness shaping (feature: outro analysis): how far the tail actually
// drops below the track's body decides how much of the wind-down deserves the
// overlap. Below this drop the "fade" barely recedes — a full-length overlap
// doubles two near-full-level tracks — so the canvas trims toward its 8s
// floor; at or past FADE_DROP_DEEP_DB it's a true fade and keeps the full
// wind-down ride. Linear in between. Needs BOTH the tail and body LUFS
// (opts.tailLufs / opts.bodyLufs) — either missing → no shaping.
export const FADE_DROP_SHALLOW_DB = 3;
export const FADE_DROP_DEEP_DB = 12;

export function endingCrossSecondsFor(
  a: Analysis,
  windDownSec: number | null,
  opts: { maxSec?: number | null; tailLufs?: number | null; bodyLufs?: number | null } = {},
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
  } else {
    secs = 4; // tight, intentional cut — same length as a locked beat-blend
  }
  // Beat-grid snap (same convention as the washout/loop canvases).
  if (a.bpm && a.bpm > 0) {
    const barSec = (4 * 60) / a.bpm;
    const bars = Math.max(1, Math.round(secs / barSec));
    const snapped = bars * barSec;
    if (snapped >= 3 && snapped <= 14) secs = snapped;
  }
  secs = Math.max(Math.min(3, ceil), Math.min(ceil, secs));
  return Math.round(secs * 10) / 10;
}

// --- DJ transition effects (sweep / washout) --------------------------------
// The DJ agent proposes `transition: sweep|washout` on a pick; these helpers
// are how the data disposes. All pure — broadcast/queue.ts applies them.
//
// Cross-duration physics (see radio.liq's fade == buffer invariant): a track's
// `liq_cross_duration` governs the crossfade at its own END. The washout flag
// rides the track that ends, so its canvas can be stamped on that same track
// and it lands on exactly the transition the wash fires on. The sweep (the
// transition INTO the flagged pick) cannot be given a canvas — the previous
// track's stamp is already sent to Liquidsoap when the pick happens — so its
// envelope scales to whatever `d` that transition already earned.

export const WASHOUT_CROSS_TARGET_SECONDS = 12;

// Blend canvas for a washout: target 12 s snapped to whole bars of the flagged
// track's own tempo, clamped to [8, min(14, admin ceiling)]. Unknown BPM →
// fixed 10 s. No incoming-intro cap: the next track isn't known when this
// track is annotated — a tail decaying over the next track's opening is an
// accepted (and DJ-authentic) hazard.
export function washoutCrossSecondsFor(a: Analysis, maxSec: number | null = null): number {
  const ceil = typeof maxSec === 'number' && maxSec > 0 ? Math.min(maxSec, CROSS_MAX_SECONDS) : CROSS_MAX_SECONDS;
  const lo = Math.min(8, ceil);
  let secs = 10;
  if (a.bpm && a.bpm > 0) {
    const barSec = (4 * 60) / a.bpm;
    const bars = Math.max(1, Math.round(WASHOUT_CROSS_TARGET_SECONDS / barSec));
    secs = bars * barSec;
  }
  secs = Math.max(lo, Math.min(ceil, secs));
  return Math.round(secs * 10) / 10;
}

// Comb tap spacing for the washout tail — a dotted eighth of the flagged
// track's tempo (the classic dub-throw subdivision), clamped so extreme tempi
// stay in the audible-echo range. Unknown BPM → 0.30 s (the neutral default
// radio.liq also falls back to when the stamp is absent).
export function washoutDelayFor(bpm: number | null): number {
  if (!bpm || bpm <= 0) return 0.3;
  const clamped = Math.max(0.18, Math.min(0.45, 0.75 * (60 / bpm)));
  return Math.round(clamped * 100) / 100;
}

// Loop tap for the exit loop — one bar (4 beats, 4/4) of the flagged track's
// own tempo, halved/doubled into a 1.2–3.4 s window so extreme tempi still
// yield a musical, comb-sized loop (a half-bar at very slow tempi, two bars
// at very fast ones — both still whole beat multiples, so the loop repeats
// in time). Unknown BPM → 2.0 s, but the queue strips the effect before that
// matters (a loop without a measured bar is noise); 2.0 is only the
// radio.liq fallback when the stamp is somehow absent.
export function loopBarFor(bpm: number | null): number {
  if (!bpm || bpm <= 0) return 2.0;
  let bar = (4 * 60) / bpm;
  while (bar > 3.4) bar = bar / 2;
  while (bar < 1.2) bar = bar * 2;
  return Math.round(bar * 100) / 100;
}

export const LOOP_CROSS_TARGET_SECONDS = 12;

// Canvas for a loop exit — like the washout's, but snapped to a whole number
// of LOOPS (not bars) so the ride-out holds an integral repeat count before
// the release; the [8, ceiling] clamp still wins at the edges (an off-grid
// last repeat under the master fade beats a canvas outside the broadcast
// range). Same no-incoming-cap rationale as washoutCrossSecondsFor: the next
// track isn't known when this track is annotated.
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

// The LLM proposes, the data disposes. A sweep is the move that hides a seam —
// between tempo/key-locked tracks a tight beat-blend is better and a filter
// ride reads as gratuitous — so it only survives a real clash. Un-analysed
// tracks pass (the data can't contradict the DJ). Washout is an editorial
// "close the chapter" gesture, not a compatibility repair: always allowed —
// the caller's cooldown rations it.
//
// The effects map onto a small grid: blend = the rhythmic move for COMPATIBLE
// pairs, washout = the rhythmic exit (always allowed), sweep = the dramatic
// textural move across a clash, dissolve = the smooth textural move across a
// clash (the reverb wash — hides the seam the sweep would announce), chop =
// the percussive move across a clash (the crossfader cut — announces the seam
// on the beat instead of choking it like the sweep).
export function effectAllowedFor(kind: 'sweep' | 'washout' | 'blend' | 'dissolve' | 'chop' | 'loop', cur: Analysis, next: Analysis): boolean {
  if (kind === 'washout') return true;
  // loop (exit loop) is editorial like the washout — an intentful way to
  // leave a track, not a compatibility repair. The queue separately requires
  // the flagged track's own measured tempo (a loop needs a bar length).
  if (kind === 'loop') return true;
  // chop gates the OUTGOING track rhythmically — over a measured fade-out the
  // stabs are stabs of near-silence, so a fade ending vetoes it outright
  // (feature: outro analysis). Checked before the analysed() pass-through:
  // the ending is measured independently of bpm/key.
  if (kind === 'chop' && cur.ending === 'fade') return false;
  if (!analysed(cur) || !analysed(next)) return true;
  const compat = mixCompat(cur, next);
  // blend (spectral handover) is the sweep's mirror: it makes COMPATIBLE
  // tracks feel like one continuous piece — between clashing tracks the
  // complementary-band trade just exposes the clash, so a long wash (or a
  // sweep) serves better there.
  if (kind === 'blend') return compat >= 0.4;
  // dissolve: exact mirror of blend — beatless ambience is the tempo-agnostic
  // glue for a pair that measurably clashes; between compatible tracks a
  // blend keeps the groove alive and a wash just kills it.
  if (kind === 'dissolve') return compat < 0.4;
  // sweep and chop are both gear-change moves — musically wrong between
  // locked tracks where a tight beat-blend serves better.
  return compat < 0.6;
}

// Gate period for the chop — one beat of the OUTGOING track (the one being
// cut), clamped so extreme tempi stay in the stab-audible range. Unknown BPM →
// 0.5 s (the neutral default radio.liq also falls back to when the stamp is
// absent). Unlike the washout's dotted-eighth echo tap, the chop cuts ON the
// beat: the gate opens at each beat start so the downbeat transient survives.
export function chopPeriodFor(bpm: number | null): number {
  if (!bpm || bpm <= 0) return 0.5;
  const clamped = Math.max(0.25, Math.min(0.75, 60 / bpm));
  return Math.round(clamped * 100) / 100;
}

// --- Feature 2: transition FX ----------------------------------------------
// Pick a flourish to fire across the blend, or null for "no garnish". Only
// fires on a NOTABLE upward tempo jump (the moment a DJ would ride a riser);
// most transitions return null. Caller still gates on djMode, sfx.enabled and
// a cooldown — this only decides *whether the transition is worth a sound*.
// Returned names are built-in SFX (broadcast/sfx.ts).
export function transitionSfxFor(
  cur: Analysis,
  next: Analysis,
): 'whoosh' | 'drum-roll' | null {
  if (cur.bpm == null || next.bpm == null || cur.bpm <= 0) return null;
  const ratio = next.bpm / cur.bpm;
  // Only meaningful upward jumps (and not just a half/double-time artefact).
  if (ratio < 1.18 || ratio >= 1.9) return null;
  // A big leap earns the bigger flourish.
  return ratio >= 1.4 ? 'drum-roll' : 'whoosh';
}

// --- Feature 4: mini-runs ---------------------------------------------------
// Daypart-signed target for a short tempo/key run. Nudges BPM up when the
// daypart energy is rising (speed > 1), down when winding down, and holds the
// current key so the run stays harmonically coherent. Returns null when the
// current track is un-analysed (nothing to anchor a run to).
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
