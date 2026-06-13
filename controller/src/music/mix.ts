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
}

// --- Loudness normalisation ------------------------------------------------
// Target integrated loudness; streaming-standard −14 LUFS (Spotify/YouTube/
// Apple Music). Gain is clamped to ±LOUDNESS_GAIN_CLAMP_DB so a mis-measured
// outlier can't blow up the mix — Liquidsoap's brick-wall limiter still backs
// us up, but the clamp keeps us well clear of it on normal catalogue audio.
export const LOUDNESS_TARGET_LUFS = -14;
export const LOUDNESS_GAIN_CLAMP_DB = 6;

// dB gain to bring a track measured at `lufs` toward the target, clamped.
// Returns null when the track has no loudness measurement (→ unity gain on the
// playback side, i.e. today's behaviour). Result is rounded to 0.1 dB — finer
// is inaudible and just bloats the annotate string.
export function gainForLoudness(lufs: number | null | undefined): number | null {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return null;
  const raw = LOUDNESS_TARGET_LUFS - lufs;
  const clamped = Math.max(-LOUDNESS_GAIN_CLAMP_DB, Math.min(LOUDNESS_GAIN_CLAMP_DB, raw));
  return Math.round(clamped * 10) / 10;
}

// True when a track carries at least one measured value. An un-analysed track
// (both null) makes every consumer below a no-op, so an un-analysed library
// behaves exactly as before.
function analysed(a: Analysis): boolean {
  return a.bpm != null || a.key != null;
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

// Overall mix compatibility 0..1 — tempo weighted a touch over key, matching
// the pool re-rank's intent (a beat that locks matters more to a blend than a
// key that's merely adjacent).
export function mixCompat(cur: Analysis, next: Analysis): number {
  return 0.6 * bpmCompat(cur.bpm, next.bpm) + 0.4 * keyCompat(cur.key, next.key);
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
  opts: { energyDelta?: number } = {},
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

  // Clamp to a sane broadcast range and quantise to 0.1s.
  secs = Math.max(3, Math.min(14, secs));
  return Math.round(secs * 10) / 10;
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
