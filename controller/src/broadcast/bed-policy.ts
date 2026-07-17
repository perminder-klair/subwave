// Bed policy — the pure decisions behind "should this link ride a bed, and how
// long should the bed be?". Policy lives here; the mechanism (pushing the bed
// into dj_queue) lives in broadcast/queue.ts. Same split as broadcast/dj-budget.ts:
// call sites ask a question, this module answers it, and scripts/bed-policy.test.ts
// pins the answers.
//
// The gesture being modelled: today a link is talked OVER the incoming song
// (light duck, ~40%), so every second of DJ costs a second of the song it is
// introducing. A bed decouples the two — Song A → bed (DJ talks) → ramp → Song B.
//
// No I/O, no imports from the queue. Everything here is a function of numbers.

export interface BedOpts {
  // Used only when the ramp budget is unknown (see rampBudgetMs).
  thresholdSec: number;
  // The bed's own exit crossfade — how long the next song takes to ramp in.
  crossSec: number;
}

// Bed alone before the DJ's clip lands, ON TOP of the entry cross (see
// bedLengthFor's entryCrossSec). This is LATENCY, not a preference: the
// controller sees the bed start on its 1.5s now-playing tick, writes intro.txt,
// and Liquidsoap picks it up on a 0.5s poll. 2.5s covers the worst case. If the
// voice lands later than this anyway, the tail spills into the next song — i.e.
// it degrades to exactly today's behaviour, which is the point.
export const BED_HEAD_SEC = 2.5;

// Bed + next song blend after the DJ's clip ends, so the bed doesn't die on the
// DJ's last syllable.
export const BED_TAIL_SEC = 2.0;

// The ramp budget: how long the DJ may talk over the START of `track` before
// trampling something the listener wants to hear. Reads the three-state vocal
// semantics library-db documents on `vocalRanges` — [] is instrumental, null is
// not-computed, non-empty means the analyzer measured real vocals.
//
//   non-empty vocalRanges → the earliest range's startMs IS the vocal onset.
//   [] (instrumental)     → nothing to trample. Infinity — never bed.
//   null (not computed)   → unknown. Caller falls back to the threshold.
//
// Deliberately NOT introMs, not even as a shortcut when ranges exist. introMs
// only equals the vocal onset when Demucs ran in the SAME analysis pass; a
// heavy-then-lean history desyncs the columns (clearAnalysis({keepVocal:true})
// NULLs intro_ms while COALESCE preserves vocal_ranges_json, and the lean pass
// rewrites intro_ms from the energy heuristic — ~0 for a full-band opener). The
// ranges themselves are the measurement, so read the onset off them directly.
// Without ranges, introMs is a pure energy heuristic ("where the track comes in
// after a quiet count-in") whose own docstring calls it "a soft budget, never a
// gate" — and for this question it measures the wrong thing: a track opening
// full-band with vocals at 0:15 reads introMs ≈ 0, which would fire a bed
// exactly where the ramp is longest.
export function rampBudgetMs(
  track: { vocalRanges?: { startMs: number }[] | null } | null,
): number | null {
  if (!track) return null;
  const ranges = track.vocalRanges;
  if (ranges == null) return null;              // not computed → unknown
  if (ranges.length === 0) return Infinity;     // instrumental → never bed
  const onset = Math.min(...ranges.map(r => (typeof r?.startMs === 'number' ? r.startMs : NaN)));
  return Number.isFinite(onset) && onset >= 0 ? onset : null;
}

// Should this spoken clip ride a bed? `voiceMs` is the rendered clip's real
// length plus the lead-in/tail padding (queue.speechDurationMs). `budgetMs` is
// rampBudgetMs() for the incoming track — null when unknown.
export function bedWanted(voiceMs: number, budgetMs: number | null, opts: BedOpts): boolean {
  if (!Number.isFinite(voiceMs) || voiceMs <= 0) return false;
  // Known budget: bed exactly when the DJ would outlast the intro. Infinity
  // (instrumental) can never be outlasted, so it falls out here.
  if (budgetMs != null) return voiceMs > budgetMs;
  // Unknown budget: no data to be clever with, so a plain duration threshold.
  const thresholdMs = Math.max(0, opts.thresholdSec) * 1000;
  return voiceMs > thresholdMs;
}

// How long the bed plays, and how long its exit cross is.
//
//   bedSec = entryCross + head + voice + tail
//
// `entryCrossSec` is the PREDECESSOR's exit canvas — the cross the bed fades in
// under. The bed's clock (cue_out, and the marker the controller keys the link
// off) starts when the bed enters that cross buffer, not when it is dominant,
// so the entry cross is dead time the bed must carry on top of the head/voice/
// tail budget. Without it, the DJ's opening words land over the outgoing song's
// fade rather than over the solo bed.
//
// The bed's liq_cross_duration means the next song starts fading in at
// (bedSec - crossSec), landing ~4s before the DJ's clip ends with the defaults.
// That overlap IS the ramp: the DJ's closing words play over the song's
// fade-in, the way a presenter talks up to the vocal.
//
// The clamp keeps the arithmetic total rather than trusting the policy to stay
// honest: the ramp must never start before the bed does. Only reachable on a
// sub-2s script, which bedWanted() prevents today.
export function bedLengthFor(
  voiceMs: number,
  opts: BedOpts,
  entryCrossSec = 0,
): { bedSec: number; crossSec: number } {
  const bedSec = Math.max(0, entryCrossSec) + BED_HEAD_SEC + voiceMs / 1000 + BED_TAIL_SEC;
  const crossSec = Math.min(Math.max(0, opts.crossSec), bedSec - 1);
  return { bedSec: round2(bedSec), crossSec: round2(crossSec) };
}

// Pick a bed from the pool: long enough to be cut to `bedSec`, and not the one
// that played last. Beds are only ever trimmed SHORTER (cue_out), never looped,
// so "long enough" is the only hard requirement — a 60s file covers everything.
//
// Deterministic in its inputs via `roll` (0..1), so the test can pin selection
// without reaching for Math.random.
export function pickBed<T extends { name: string; durationSec?: number | null }>(
  beds: T[],
  bedSec: number,
  lastUsed: string | null,
  roll: number,
): T | null {
  // Unknown duration is excluded, not gambled on: a bed that runs out mid-link
  // drops the DJ into silence, which is worse than today's behaviour.
  const fits = beds.filter(b => typeof b.durationSec === 'number' && b.durationSec >= bedSec);
  if (!fits.length) return null;
  // Avoid an immediate repeat, but never at the cost of airing no bed at all.
  const fresh = fits.filter(b => b.name !== lastUsed);
  const pool = fresh.length ? fresh : fits;
  const i = Math.min(pool.length - 1, Math.floor(clamp01(roll) * pool.length));
  return pool[i];
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
